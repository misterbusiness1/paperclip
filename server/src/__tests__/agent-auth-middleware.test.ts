import { createHash, createHmac, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  boardApiKeys,
  heartbeatRuns,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { assertCompanyAccess } from "../routes/authz.js";
import {
  acquireRunMutationLease,
  sealRunMutationActivity,
  waitForRunMutationActivityToDrain,
} from "../services/run-mutation-activity.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createSelectChain(
  rowsForTable: (table: unknown) => unknown[],
  beforeRead?: (table: unknown) => Promise<void>,
) {
  return {
    from(table: unknown) {
      return {
        async where() {
          await beforeRead?.(table);
          return rowsForTable(table);
        },
      };
    },
  };
}

function createDbState(input: {
  agent: { id: string; companyId: string; status?: string };
  agentKey?: {
    id: string;
    agentId: string;
    companyId: string;
    keyHash: string;
    responsibleUserId?: string | null;
    scopeConfig?: Record<string, unknown> | null;
  };
  run?: {
    id: string;
    companyId: string;
    agentId: string;
    responsibleUserId?: string | null;
    status?: string;
    cancellationRequestedAt?: Date | null;
    finishedAt?: Date | null;
  };
  beforeRead?: (table: unknown) => Promise<void>;
}) {
  const activity: Array<Record<string, unknown>> = [];
  const agentRow = {
    id: input.agent.id,
    companyId: input.agent.companyId,
    status: input.agent.status ?? "active",
  };
  const keyRow = input.agentKey
    ? {
        id: input.agentKey.id,
        agentId: input.agentKey.agentId,
        companyId: input.agentKey.companyId,
        keyHash: input.agentKey.keyHash,
        responsibleUserId: input.agentKey.responsibleUserId ?? null,
        revokedAt: null,
        scopeConfig: input.agentKey.scopeConfig ?? null,
      }
    : null;
  const runRow = input.run
    ? {
        id: input.run.id,
        companyId: input.run.companyId,
        agentId: input.run.agentId,
        responsibleUserId: input.run.responsibleUserId ?? null,
        status: input.run.status ?? "running",
        cancellationRequestedAt: input.run.cancellationRequestedAt ?? null,
        finishedAt: input.run.finishedAt ?? null,
      }
    : null;

  const db = {
    select: () =>
      createSelectChain((table) => {
        if (table === boardApiKeys) return [];
        if (table === agentApiKeys) return keyRow ? [keyRow] : [];
        if (table === agents) return [agentRow];
        if (table === heartbeatRuns) return runRow ? [runRow] : [];
        return [];
      }, input.beforeRead),
    update: () => ({
      set() {
        return {
          where() {
            return Promise.resolve([]);
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values(values: Record<string, unknown>) {
        if (table === activityLog) activity.push(values);
        return Promise.resolve([]);
      },
    }),
  } as any;

  return { db, activity };
}

function createApp(db: any, onMutation?: () => void, onTransportClose?: () => void) {
  const app = express();
  app.use(express.json());
  if (onTransportClose) {
    app.use((_req, res, next) => {
      res.once("close", onTransportClose);
      next();
    });
  }
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.get("/companies/:companyId/protected", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ ok: true });
  });
  app.get("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ id: req.params.issueId, readable: true });
  });
  app.patch("/companies/:companyId/mutation-probe", (_req, res) => {
    onMutation?.();
    res.json({ writable: true });
  });
  app.patch("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    onMutation?.();
    res.json({ id: req.params.issueId, writable: true });
  });
  app.use(errorHandler);
  return app;
}

function createDelayedMutationApp(
  db: any,
  input: {
    entered: () => void;
    waitUntilReleased: Promise<void>;
    onMutation: () => void;
    respondBeforeWait?: boolean;
    responseFinished?: () => void;
    asUseMiddleware?: boolean;
  },
) {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }),
  );
  const delayedHandler: express.RequestHandler = async (_req, res) => {
    input.entered();
    if (input.respondBeforeWait) {
      if (input.responseFinished) res.once("finish", input.responseFinished);
      res.json({ writable: true });
    }
    await input.waitUntilReleased;
    input.onMutation();
    if (!input.respondBeforeWait) res.json({ writable: true });
  };
  if (input.asUseMiddleware) {
    app.use("/companies/:companyId/delayed-mutation", delayedHandler);
  } else {
    app.patch("/companies/:companyId/delayed-mutation", delayedHandler);
  }
  app.use(errorHandler);
  return app;
}

function createDelayedParamMutationApp(
  db: any,
  input: {
    entered: () => void;
    waitUntilReleased: Promise<void>;
    onMutation: () => void;
    continued?: () => void;
  },
) {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }),
  );
  app.param("resourceId", async (_req, _res, next) => {
    input.entered();
    await input.waitUntilReleased;
    next();
    input.continued?.();
  });
  app.patch("/companies/:companyId/delayed-param/:resourceId", (_req, res) => {
    input.onMutation();
    res.json({ writable: true });
  });
  app.use(errorHandler);
  return app;
}

function craftAgentJwtWithoutResponsibleClaim(input: {
  secret: string;
  agentId: string;
  companyId: string;
  adapterType: string;
  runId: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    sub: input.agentId,
    company_id: input.companyId,
    adapter_type: input.adapterType,
    run_id: input.runId,
    iat: now,
    exp: now + 3600,
    iss: "paperclip",
    aud: "paperclip-api",
  };
  const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${headerB64}.${claimsB64}`;
  // Sign with the same per-instance, per-company key the server derives. The
  // instance defaults to "default" (beforeEach clears PAPERCLIP_INSTANCE_ID),
  // matching the live control plane this middleware test exercises. This helper
  // only omits the responsible_user_id claim — it is not a cross-instance token.
  const signingKey = createHmac("sha256", input.secret).update(`jwt:default:${input.companyId}`).digest("hex");
  const signature = createHmac("sha256", signingKey).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("agent auth middleware", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "auth-middleware-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    // Pin the control-plane instance so mint/verify (and the hand-crafted
    // legacy token helper) all derive keys under the "default" live instance.
    delete process.env.PAPERCLIP_INSTANCE_ID;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
  });

  it("uses the signed responsible_user_id claim when it matches the authoritative run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      runId,
      onBehalfOfUserId: "user-claim",
      source: "agent_jwt",
    });
  });

  it("rejects a signed JWT whose responsible user no longer matches the run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const onMutation = vi.fn();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "current-user" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "stale-user");

    const res = await request(createApp(db, onMutation))
      .patch(`/companies/${companyId}/mutation-probe`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "must not write" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("AGENT_RUN_NOT_ACTIVE");
    expect(onMutation).not.toHaveBeenCalled();
  });

  it.each(["queued", "running"])("allows a %s signed run to reach a mutation handler", async (status) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const onMutation = vi.fn();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim", status },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");

    const res = await request(createApp(db, onMutation))
      .patch(`/companies/${companyId}/mutation-probe`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "allowed mutation" });

    expect(res.status).toBe(200);
    expect(onMutation).toHaveBeenCalledOnce();
  });

  it("keeps cancellation drain pending until an admitted HTTP mutation handler finishes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim", status: "running" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let releaseHandler!: () => void;
    const waitUntilReleased = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const onMutation = vi.fn();
    const response = request(createDelayedMutationApp(db, {
      entered: markEntered,
      waitUntilReleased,
      onMutation,
    }))
      .patch(`/companies/${companyId}/delayed-mutation`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "delayed" });
    const responsePromise = response.then((result) => result);

    await entered;
    sealRunMutationActivity(db, runId);
    expect(acquireRunMutationLease(db, runId)).toBeNull();
    let drained = false;
    const drain = waitForRunMutationActivityToDrain(db, runId).then(() => { drained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    expect(onMutation).not.toHaveBeenCalled();

    releaseHandler();
    const result = await responsePromise;
    await drain;
    expect(result.status).toBe(200);
    expect(onMutation).toHaveBeenCalledOnce();
    expect(drained).toBe(true);
  });

  it("does not release an admitted HTTP mutation when its client socket closes mid-handler", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim", status: "running" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let releaseHandler!: () => void;
    const waitUntilReleased = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const testRequest = request(createDelayedMutationApp(db, {
      entered: markEntered,
      waitUntilReleased,
      onMutation: vi.fn(),
    }))
      .patch(`/companies/${companyId}/delayed-mutation`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "aborted" });
    const requestSettled = testRequest.then(
      () => undefined,
      () => undefined,
    );

    await entered;
    sealRunMutationActivity(db, runId);
    let drained = false;
    void waitForRunMutationActivityToDrain(db, runId).then(() => { drained = true; });
    testRequest.abort();
    await requestSettled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    releaseHandler();
    await vi.waitFor(() => expect(drained).toBe(true));
  });

  it("does not release an admitted router.use mutation when its client socket closes mid-handler", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim", status: "running" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let releaseHandler!: () => void;
    const waitUntilReleased = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const testRequest = request(createDelayedMutationApp(db, {
      entered: markEntered,
      waitUntilReleased,
      onMutation: vi.fn(),
      asUseMiddleware: true,
    }))
      .patch(`/companies/${companyId}/delayed-mutation`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "aborted middleware" });
    const requestSettled = testRequest.then(
      () => undefined,
      () => undefined,
    );

    await entered;
    sealRunMutationActivity(db, runId);
    let drained = false;
    void waitForRunMutationActivityToDrain(db, runId).then(() => { drained = true; });
    testRequest.abort();
    await requestSettled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    releaseHandler();
    await vi.waitFor(() => expect(drained).toBe(true));
  });

  it("does not dispatch a mutation after an aborted async param resolver releases its lease", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim", status: "running" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let releaseParam!: () => void;
    const waitUntilReleased = new Promise<void>((resolve) => { releaseParam = resolve; });
    let markContinued!: () => void;
    const continued = new Promise<void>((resolve) => { markContinued = resolve; });
    const onMutation = vi.fn();
    const testRequest = request(createDelayedParamMutationApp(db, {
      entered: markEntered,
      waitUntilReleased,
      onMutation,
      continued: markContinued,
    }))
      .patch(`/companies/${companyId}/delayed-param/resource-1`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "aborted param" });
    const requestSettled = testRequest.then(
      () => undefined,
      () => undefined,
    );

    await entered;
    sealRunMutationActivity(db, runId);
    testRequest.abort();
    await requestSettled;
    await waitForRunMutationActivityToDrain(db, runId);

    releaseParam();
    await continued;
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("releases a late-admitted lease when the client disconnects during run authentication", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    let markAuthReadEntered!: () => void;
    const authReadEntered = new Promise<void>((resolve) => { markAuthReadEntered = resolve; });
    let releaseAuthRead!: () => void;
    const waitForAuthRead = new Promise<void>((resolve) => { releaseAuthRead = resolve; });
    let markAfterAuthTurn!: () => void;
    const afterAuthTurn = new Promise<void>((resolve) => { markAfterAuthTurn = resolve; });
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: null, status: "running" },
      beforeRead: async (table) => {
        if (table !== heartbeatRuns) return;
        markAuthReadEntered();
        await waitForAuthRead;
        // The authentication continuation and lease registration are queued
        // as promise microtasks, so this turn marker runs after admission.
        setImmediate(markAfterAuthTurn);
      },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, null);
    const onMutation = vi.fn();
    let markTransportClosed!: () => void;
    const transportClosed = new Promise<void>((resolve) => { markTransportClosed = resolve; });
    const app = createApp(db, onMutation, markTransportClosed);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP listener");

    try {
      const body = JSON.stringify({ title: "disconnect during auth" });
      const clientRequest = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: `/companies/${companyId}/mutation-probe`,
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Paperclip-Run-Id": runId,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      });
      clientRequest.on("error", () => undefined);
      const clientClosed = new Promise<void>((resolve) => clientRequest.once("close", resolve));
      clientRequest.end(body);

      await authReadEntered;
      clientRequest.destroy();
      await Promise.all([clientClosed, transportClosed]);
      releaseAuthRead();
      await afterAuthTurn;

      sealRunMutationActivity(db, runId);
      let drained = false;
      void waitForRunMutationActivityToDrain(db, runId).then(() => { drained = true; });
      await vi.waitFor(() => expect(drained).toBe(true));
      expect(onMutation).not.toHaveBeenCalled();
    } finally {
      releaseAuthRead();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("tracks handler work that continues after the response has finished", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim", status: "running" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let releaseHandler!: () => void;
    const waitUntilReleased = new Promise<void>((resolve) => { releaseHandler = resolve; });
    let markResponseFinished!: () => void;
    const responseFinished = new Promise<void>((resolve) => { markResponseFinished = resolve; });
    const onMutation = vi.fn();
    const responseRequest = request(createDelayedMutationApp(db, {
      entered: markEntered,
      waitUntilReleased,
      onMutation,
      respondBeforeWait: true,
      responseFinished: markResponseFinished,
    }))
      .patch(`/companies/${companyId}/delayed-mutation`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "post-response work" });
    const responsePromise = responseRequest.then((result) => result);

    await entered;
    await responseFinished;
    sealRunMutationActivity(db, runId);
    let drained = false;
    const drain = waitForRunMutationActivityToDrain(db, runId).then(() => { drained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    expect(onMutation).not.toHaveBeenCalled();

    releaseHandler();
    await drain;
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(onMutation).toHaveBeenCalledOnce();
  });

  it.each([
    { status: "cancelled", finishedAt: new Date("2026-08-03T17:47:12.000Z") },
    { status: "running", finishedAt: new Date("2026-08-03T17:47:12.000Z") },
    {
      status: "running",
      finishedAt: null,
      cancellationRequestedAt: new Date("2026-08-03T17:47:11.500Z"),
    },
  ])("rejects a non-active signed run before a mutation handler", async ({
    status,
    finishedAt,
    cancellationRequestedAt,
  }) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const onMutation = vi.fn();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: {
        id: runId,
        companyId,
        agentId,
        responsibleUserId: "user-claim",
        status,
        cancellationRequestedAt,
        finishedAt,
      },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");

    const res = await request(createApp(db, onMutation))
      .patch(`/companies/${companyId}/mutation-probe`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "must not write" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("AGENT_RUN_NOT_ACTIVE");
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("rejects a terminal run header on an agent key before a mutation handler", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const token = "pcp_test_terminal_run_key";
    const onMutation = vi.fn();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
      },
      run: {
        id: runId,
        companyId,
        agentId,
        responsibleUserId: "user-key",
        status: "cancelled",
        finishedAt: new Date("2026-08-03T17:47:12.000Z"),
      },
    });

    const res = await request(createApp(db, onMutation))
      .patch(`/companies/${companyId}/mutation-probe`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "must not write" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("AGENT_RUN_NOT_ACTIVE");
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("rejects a fenced running run header on an agent key before a mutation handler", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const token = "pcp_test_fenced_run_key";
    const onMutation = vi.fn();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
      },
      run: {
        id: runId,
        companyId,
        agentId,
        responsibleUserId: "user-key",
        status: "running",
        cancellationRequestedAt: new Date("2026-08-03T17:47:11.500Z"),
      },
    });

    const res = await request(createApp(db, onMutation))
      .patch(`/companies/${companyId}/mutation-probe`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "must not write" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("AGENT_RUN_NOT_ACTIVE");
    expect(onMutation).not.toHaveBeenCalled();
  });

  it.each(["agent", "company"] as const)(
    "rejects an agent key run header with a mismatched %s binding",
    async (mismatch) => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const token = `pcp_test_wrong_${mismatch}_run_key`;
      const onMutation = vi.fn();
      const { db } = createDbState({
        agent: { id: agentId, companyId },
        agentKey: {
          id: randomUUID(),
          agentId,
          companyId,
          keyHash: hashToken(token),
          responsibleUserId: "user-key",
        },
        run: {
          id: runId,
          companyId: mismatch === "company" ? randomUUID() : companyId,
          agentId: mismatch === "agent" ? randomUUID() : agentId,
          responsibleUserId: "user-key",
          status: "running",
        },
      });

      const res = await request(createApp(db, onMutation))
        .patch(`/companies/${companyId}/mutation-probe`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Paperclip-Run-Id", runId)
        .send({ title: "must not write" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("AGENT_RUN_NOT_ACTIVE");
      expect(onMutation).not.toHaveBeenCalled();
    },
  );

  it("allows an agent key mutation only with a matching active run header", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const token = "pcp_test_active_run_key";
    const onMutation = vi.fn();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
      },
      run: {
        id: runId,
        companyId,
        agentId,
        responsibleUserId: "user-key",
        status: "running",
      },
    });

    const res = await request(createApp(db, onMutation))
      .patch(`/companies/${companyId}/mutation-probe`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "allowed mutation" });

    expect(res.status).toBe(200);
    expect(onMutation).toHaveBeenCalledOnce();
  });

  it("preserves run-independent standard-key mutations without a run header", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const token = "pcp_test_missing_run_key";
    const onMutation = vi.fn();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
      },
    });

    const res = await request(createApp(db, onMutation))
      .patch(`/companies/${companyId}/mutation-probe`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "bootstrap work" });

    expect(res.status).toBe(200);
    expect(onMutation).toHaveBeenCalledOnce();
  });

  it("preserves run-independent task-bridge mutations without a run header", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const token = "pcp_test_task_bridge_key";
    const onMutation = vi.fn();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
        scopeConfig: { kind: "task_bridge", projectId: randomUUID() },
      },
    });

    const res = await request(createApp(db, onMutation))
      .patch(`/companies/${companyId}/mutation-probe`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "webhook work" });

    expect(res.status).toBe(200);
    expect(onMutation).toHaveBeenCalledOnce();
  });

  it("rejects an agent key run header bound to a different responsible user", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const token = "pcp_test_cross_user_run_key";
    const onMutation = vi.fn();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
      },
      run: {
        id: runId,
        companyId,
        agentId,
        responsibleUserId: "different-user",
        status: "running",
      },
    });

    const res = await request(createApp(db, onMutation))
      .patch(`/companies/${companyId}/mutation-probe`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "must not write" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("AGENT_RUN_NOT_ACTIVE");
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("preserves signed skill_test JWT scope on the request actor", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim", {
      kind: "skill_test",
      issueId,
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      keyScope: { kind: "skill_test", issueId },
      source: "agent_jwt",
    });
  });

  it("rejects mismatched run headers for agent JWTs and audits the spoof attempt", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const spoofedRunId = randomUUID();
    const { db, activity } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", spoofedRunId);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("agent_jwt_run_id_mismatch");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "auth.agent_jwt_run_header_mismatch",
      entityType: "heartbeat_run",
      entityId: runId,
      runId,
      details: { claimRunId: runId, headerRunId: spoofedRunId },
    });
  });

  it("falls back to the run row responsible user for legacy claim-less agent JWTs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-legacy" },
    });
    const token = craftAgentJwtWithoutResponsibleClaim({
      secret: process.env.PAPERCLIP_AGENT_JWT_SECRET!,
      agentId,
      companyId,
      adapterType: "codex_local",
      runId,
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      runId,
      onBehalfOfUserId: "user-legacy",
      source: "agent_jwt",
    });
  });

  it("rejects fork-minted run JWTs before issue reads or writes reach live issue data", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });

    process.env.PAPERCLIP_INSTANCE_ID = "pap-12899-worktree";
    const forkToken = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");
    expect(forkToken).not.toBeNull();

    process.env.PAPERCLIP_INSTANCE_ID = "default";
    const app = createApp(db);
    const readRes = await request(app)
      .get(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${forkToken}`)
      .set("X-Paperclip-Run-Id", runId);
    const writeRes = await request(app)
      .patch(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${forkToken}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "should not write" });

    expect(readRes.status).toBe(401);
    expect(writeRes.status).toBe(401);
  });

  it("populates agent-key actors from the key responsible user binding", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const token = "pcp_test_agent_key";
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
      },
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      onBehalfOfUserId: "user-key",
      source: "agent_key",
    });
  });

  it("rejects agent keys that lack a responsible user binding and audits the denial", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const keyId = randomUUID();
    const token = "pcp_test_agent_key_without_user";
    const { db, activity } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: keyId,
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: null,
      },
    });

    const res = await request(createApp(db))
      .get(`/companies/${companyId}/protected`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RESPONSIBLE_USER_UNAVAILABLE");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "auth.agent_key_missing_responsible_user",
      entityType: "agent_api_key",
      entityId: keyId,
      details: { method: "GET", url: `/companies/${companyId}/protected` },
    });
  });
});

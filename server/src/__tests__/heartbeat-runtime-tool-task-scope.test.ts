import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, issueComments, issues } from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { connectionIntentService } from "../services/connection-intents.ts";
import { verifyRuntimeToolsToken } from "../runtime-tools-token.ts";
import { logger } from "../middleware/logger.ts";

const adapter = vi.hoisted(() => ({
  delivery: "native_mcp" as "native_mcp" | "invocation_context" | "environment",
  execute: vi.fn(),
}));
vi.mock("../adapters/index.ts", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: false,
    runtimeToolDelivery: adapter.delivery,
    execute: adapter.execute,
  })),
}));
import { heartbeatService } from "../services/heartbeat.ts";

describe("runtime connection tools require a task", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const deliveries: Array<{
    runtimeTools: AdapterExecutionContext["runtimeTools"];
    contextTools: unknown;
    mcpConnectionIds: string[];
    validation: "accepted" | "rejected" | "not_advertised";
  }> = [];
  let warn: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-runtime-tool-scope-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://127.0.0.1:3100");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "isolated-runtime-tool-test-secret");
    warn = vi.spyOn(logger, "warn");
    adapter.execute.mockImplementation(async (ctx: AdapterExecutionContext) => {
      const contextTools = ctx.context.paperclipRuntimeTools as AdapterExecutionContext["runtimeTools"];
      const nativeTools = ctx.runtimeMcp?.getServers().find((server) => server.connectionId === "paperclip-runtime-tools");
      const token = ctx.runtimeTools?.bearerToken ?? contextTools?.bearerToken ?? nativeTools?.token;
      let validation: "accepted" | "rejected" | "not_advertised" = "not_advertised";
      if (token) {
        const claims = verifyRuntimeToolsToken(token);
        if (!claims) throw new Error("Runtime capability was not valid");
        try {
          await connectionIntentService(db).validate(claims);
          validation = "accepted";
        } catch {
          validation = "rejected";
        }
      }
      deliveries.push({
        runtimeTools: ctx.runtimeTools,
        contextTools: ctx.context.paperclipRuntimeTools,
        mcpConnectionIds: (ctx.runtimeMcp?.getServers() ?? []).map((server) => server.connectionId),
        validation,
      });
      // Model a provider finishing its task, so teardown has no follow-up work.
      if (typeof ctx.context.issueId === "string") {
        const task = await db.select().from(issues).where(eq(issues.id, ctx.context.issueId)).then((rows) => rows[0]);
        if (task?.assigneeAgentId === ctx.agent.id && !["done", "cancelled"].includes(task.status)) {
          await db.update(issues).set({ status: "done" }).where(eq(issues.id, task.id));
        }
      }
      return { exitCode: 0, signal: null, timedOut: false, summary: "Runtime tool delivery checked." };
    });
  });

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql`TRUNCATE companies CASCADE`);
    deliveries.length = 0;
    adapter.execute.mockReset();
    warn.mockRestore();
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await temporary?.cleanup(); }, 30_000);

  async function seed(bound: boolean, adapterType = "codex_local") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = bound ? randomUUID() : null;
    await db.insert(companies).values({
      id: companyId, name: "Runtime tool scope", issuePrefix: `R${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test-operator",
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "test-operator",
      status: "active", membershipRole: "member",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "engineer", status: "idle",
      adapterType, adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    if (issueId) await db.insert(issues).values({
      id: issueId, companyId, title: "Bound task", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: "test-operator",
    });
    return { companyId, agentId, issueId };
  }

  async function dispatch(bound: boolean, adapterType = "codex_local") {
    const fixture = await seed(bound, adapterType);
    const run = await heartbeat.wakeup(fixture.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "runtime_scope_check",
      manualUserWake: true, requestedByActorType: "user", requestedByActorId: "test-operator",
      contextSnapshot: fixture.issueId ? { issueId: fixture.issueId } : {},
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded");
    expect(deliveries).toHaveLength(1);
    return deliveries[0]!;
  }

  it.each(["native_mcp", "invocation_context", "environment"] as const)(
    "does not advertise task-only tools to an unbound %s run", async (delivery) => {
      adapter.delivery = delivery;
      const actual = await dispatch(false);
      expect(actual.runtimeTools).toBeUndefined();
      expect(actual.contextTools).toBeUndefined();
      expect(actual.mcpConnectionIds).not.toContain("paperclip-runtime-tools");
      expect(actual.validation).toBe("not_advertised");
      expect(warn.mock.calls.some((call) => call.includes("runtime connection tools could not be delivered")))
        .toBe(false);
    },
  );

  it.each(["claude_local", "codex_local"] as const)(
    "delivers task-bound tools to %s only through native MCP", async (adapterType) => {
      adapter.delivery = "native_mcp";
      const actual = await dispatch(true, adapterType);
      expect(actual.runtimeTools).toBeUndefined();
      expect(actual.contextTools).toBeUndefined();
      expect(actual.mcpConnectionIds).toContain("paperclip-runtime-tools");
      expect(actual.validation).toBe("accepted");
    },
  );

  it.each(["kimi_local", "gemini_local"] as const)(
    "delivers task-bound tools to %s only through the environment projection", async (adapterType) => {
      adapter.delivery = "environment";
      const actual = await dispatch(true, adapterType);
      expect(actual.runtimeTools).toBeDefined();
      expect(actual.contextTools).toBeUndefined();
      expect(actual.mcpConnectionIds).not.toContain("paperclip-runtime-tools");
      expect(actual.validation).toBe("accepted");
    },
  );

  it("delivers task-bound tools to invocation-context adapters only through context", async () => {
    adapter.delivery = "invocation_context";
    const actual = await dispatch(true, "http");
    expect(actual.runtimeTools).toBeUndefined();
    expect(actual.contextTools).toBeDefined();
    expect(actual.mcpConnectionIds).not.toContain("paperclip-runtime-tools");
    expect(actual.validation).toBe("accepted");
  });

  it.each([
    ["native_mcp", "foreign_owner"], ["invocation_context", "foreign_owner"], ["environment", "foreign_owner"],
    ["native_mcp", "done"], ["invocation_context", "done"], ["environment", "done"],
    ["native_mcp", "cancelled"], ["invocation_context", "cancelled"], ["environment", "cancelled"],
  ] as const)("does not advertise %s connection tools on a %s comment-mention run", async (delivery, state) => {
    adapter.delivery = delivery;
    const fixture = await seed(true, "kimi_local");
    let expectedAssignee = fixture.agentId;
    if (state === "foreign_owner") {
      expectedAssignee = randomUUID();
      await db.insert(agents).values({
        id: expectedAssignee, companyId: fixture.companyId, name: "Task owner", role: "engineer", status: "idle",
        adapterType: "kimi_local", adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      });
      await db.update(issues).set({ assigneeAgentId: expectedAssignee }).where(eq(issues.id, fixture.issueId!));
    } else {
      await db.update(issues).set({ status: state }).where(eq(issues.id, fixture.issueId!));
    }
    const [comment] = await db.insert(issueComments).values({
      companyId: fixture.companyId, issueId: fixture.issueId!, authorType: "user",
      authorUserId: "test-operator", body: "@Worker Please review this task without taking ownership.",
    }).returning();
    const run = await heartbeat.wakeup(fixture.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_comment_mentioned",
      requestedByActorType: "user", requestedByActorId: "test-operator",
      payload: { issueId: fixture.issueId, commentId: comment.id },
      contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "issue_comment_mentioned",
        source: "comment.mention", commentId: comment.id, wakeCommentId: comment.id },
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    if (state === "foreign_owner") {
      expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded");
      expect(deliveries).toHaveLength(1);
      const actual = deliveries[0]!;
      // Boolean assertions keep even isolated test bearer tokens out of failure logs.
      expect(actual.runtimeTools !== undefined).toBe(false);
      expect(actual.contextTools !== undefined).toBe(false);
      expect(actual.mcpConnectionIds).not.toContain("paperclip-runtime-tools");
      expect(actual.validation).toBe("not_advertised");
    } else {
      expect((await heartbeat.getRun(run!.id))?.status).toBe("cancelled");
      expect(deliveries).toHaveLength(0);
    }
    const task = await db.select().from(issues).where(eq(issues.id, fixture.issueId!)).then((rows) => rows[0]);
    expect(task.assigneeAgentId).toBe(expectedAssignee);
    if (state !== "foreign_owner") expect(task.status).toBe(state);
  });

  it("retains a delivery warning for a bound run with no reachable API URL", async () => {
    adapter.delivery = "native_mcp";
    vi.stubEnv("PAPERCLIP_API_URL", "");
    const actual = await dispatch(true);
    expect(actual.runtimeTools).toBeUndefined();
    expect(warn.mock.calls.some((call) => call.includes("runtime connection tools could not be delivered")))
      .toBe(true);
  });
});

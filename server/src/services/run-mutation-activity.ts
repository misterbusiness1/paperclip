import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "@paperclipai/db";

type RunMutationState = {
  sealed: boolean;
  leases: Set<RunMutationLease>;
  idleWaiters: Set<() => void>;
};

export type RunMutationLease = {
  readonly runId: string;
  readonly released: Promise<void>;
  readonly isReleased: () => boolean;
  release: () => void;
};

const statesByDb = new WeakMap<object, Map<string, RunMutationState>>();
const currentLeaseStorage = new AsyncLocalStorage<{ db: object; lease: RunMutationLease }>();

type HttpMutationTracker = {
  lease: RunMutationLease;
  activeHandlers: number;
  responseSettled: boolean;
};

type ExpressLayerLike = {
  handle?: ((...args: any[]) => unknown) & { stack?: ExpressLayerLike[] };
  route?: { stack?: ExpressLayerLike[] };
};

const httpMutationTrackers = new WeakMap<object, HttpMutationTracker>();
const instrumentedExpressLayers = new WeakSet<object>();

function statesFor(db: Db) {
  const key = db as object;
  let states = statesByDb.get(key);
  if (!states) {
    states = new Map();
    statesByDb.set(key, states);
  }
  return states;
}

function stateFor(db: Db, runId: string) {
  const states = statesFor(db);
  let state = states.get(runId);
  if (!state) {
    state = { sealed: false, leases: new Set(), idleWaiters: new Set() };
    states.set(runId, state);
  }
  return state;
}

function notifyIfIdle(state: RunMutationState) {
  if (state.leases.size > 0) return;
  for (const resolve of state.idleWaiters) resolve();
  state.idleWaiters.clear();
}

/**
 * Synchronously linearize a run-bound mutation against cancellation. Callers
 * must first validate the durable run fence, then acquire before dispatching
 * any mutating work. A null result means cancellation sealed the run between
 * the durable validation and this admission point.
 */
export function acquireRunMutationLease(db: Db, runId: string): RunMutationLease | null {
  const state = stateFor(db, runId);
  if (state.sealed) return null;

  let released = false;
  let resolveReleased!: () => void;
  const releasedPromise = new Promise<void>((resolve) => {
    resolveReleased = resolve;
  });
  const lease: RunMutationLease = {
    runId,
    released: releasedPromise,
    isReleased: () => released,
    release: () => {
      if (released) return;
      released = true;
      state.leases.delete(lease);
      resolveReleased();
      notifyIfIdle(state);
    },
  };
  state.leases.add(lease);
  return lease;
}

/** Seal a run synchronously after its cancellation fence commits. */
export function sealRunMutationActivity(db: Db, runId: string) {
  stateFor(db, runId).sealed = true;
}

/** Wait for every mutation admitted before the seal to finish. */
export function waitForRunMutationActivityToDrain(db: Db, runId: string): Promise<void> {
  const state = stateFor(db, runId);
  if (state.leases.size === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    state.idleWaiters.add(resolve);
    // There is no await between the size check and registration, but keep this
    // check so the invariant remains safe if this function is later refactored.
    notifyIfIdle(state);
  });
}

/**
 * Preserve the admitting HTTP lease in async context so a handler that
 * cancels its own run can defer terminalization until its response releases
 * the lease instead of waiting on itself.
 */
export function runWithRunMutationLease<T>(db: Db, lease: RunMutationLease, fn: () => T): T {
  return currentLeaseStorage.run({ db: db as object, lease }, fn);
}

export function getCurrentRunMutationLease(db: Db, runId: string): RunMutationLease | null {
  const current = currentLeaseStorage.getStore();
  if (!current || current.db !== (db as object) || current.lease.runId !== runId || current.lease.isReleased()) {
    return null;
  }
  return current.lease;
}

function maybeReleaseHttpMutation(tracker: HttpMutationTracker) {
  if (tracker.responseSettled && tracker.activeHandlers === 0) tracker.lease.release();
}

/**
 * Register the transport half of an HTTP mutation. `finish` and `close` do not
 * release directly: an async Express handler may continue after either event.
 * Route instrumentation below supplies the handler-completion half.
 */
export function registerHttpRunMutation(
  request: { aborted?: boolean },
  response: {
    once(event: "finish" | "close", listener: () => void): unknown;
    writableFinished?: boolean;
    destroyed?: boolean;
    closed?: boolean;
  },
  lease: RunMutationLease,
  transportAlreadySettled = false,
) {
  // Authentication performs asynchronous lookups before the lease is
  // admitted. The client may disconnect during those awaits, in which case
  // the transport events have already fired by the time listeners are added.
  // Seed the tracker from the current stream state so that late admission
  // releases immediately instead of leaking a lease forever.
  const responseAlreadySettled = Boolean(
    transportAlreadySettled
    || request.aborted
    || response.writableFinished
    || response.destroyed
    || response.closed,
  );
  const tracker: HttpMutationTracker = {
    lease,
    activeHandlers: 0,
    responseSettled: responseAlreadySettled,
  };
  httpMutationTrackers.set(request, tracker);
  const settleResponse = () => {
    tracker.responseSettled = true;
    maybeReleaseHttpMutation(tracker);
  };
  response.once("finish", settleResponse);
  response.once("close", settleResponse);
  if (responseAlreadySettled) maybeReleaseHttpMutation(tracker);
}

function instrumentExpressLayer(layer: ExpressLayerLike) {
  if (!layer || typeof layer !== "object" || instrumentedExpressLayers.has(layer as object)) return;

  if (Array.isArray(layer.route?.stack)) {
    instrumentedExpressLayers.add(layer as object);
    for (const routeLayer of layer.route.stack) instrumentExpressHandlerLayer(routeLayer);
    return;
  }
  if (Array.isArray(layer.handle?.stack)) {
    instrumentedExpressLayers.add(layer as object);
    for (const child of layer.handle.stack) instrumentExpressLayer(child);
    return;
  }

  // `router.use()` handlers are plain layers rather than endpoint route
  // layers. They can still dispatch external/plugin mutations, so their raw
  // async lifetime must participate in the same cancellation drain.
  instrumentExpressHandlerLayer(layer);
}

function instrumentExpressHandlerLayer(layer: ExpressLayerLike) {
  if (!layer || typeof layer !== "object" || instrumentedExpressLayers.has(layer as object)) return;
  instrumentedExpressLayers.add(layer as object);
  const original = layer.handle;
  if (typeof original !== "function" || original.length > 3) return;

  layer.handle = function trackedRunMutationHandler(request: object, ...args: any[]) {
    const tracker = httpMutationTrackers.get(request);
    if (!tracker) return original.call(this, request, ...args);
    // A client can disconnect while an uninstrumented, read-only async param
    // resolver is still pending. The transport may then release the lease
    // before Express reaches this mutating endpoint. Never dispatch a handler
    // after its admission lease has been released.
    if (tracker.lease.isReleased()) return undefined;

    tracker.activeHandlers += 1;
    let result: unknown;
    try {
      result = original.call(this, request, ...args);
    } catch (error) {
      tracker.activeHandlers -= 1;
      maybeReleaseHttpMutation(tracker);
      throw error;
    }

    if (result && typeof (result as { then?: unknown }).then === "function") {
      return Promise.resolve(result).then(
        (value) => {
          tracker.activeHandlers -= 1;
          maybeReleaseHttpMutation(tracker);
          return value;
        },
        (error) => {
          tracker.activeHandlers -= 1;
          maybeReleaseHttpMutation(tracker);
          throw error;
        },
      );
    }

    tracker.activeHandlers -= 1;
    maybeReleaseHttpMutation(tracker);
    return result;
  };
}

/**
 * Express does not propagate a route handler's returned promise back through
 * `next()`. Instrument route and ordinary `router.use()` handler layers once
 * so the admission middleware can observe actual handler settlement,
 * including work that continues after a response flush or client disconnect.
 */
export function instrumentExpressRunMutationHandlers(app: {
  router?: { stack?: ExpressLayerLike[] };
  _router?: { stack?: ExpressLayerLike[] };
}) {
  const stack = app.router?.stack ?? app._router?.stack;
  if (!Array.isArray(stack)) return;
  for (const layer of stack) instrumentExpressLayer(layer);
}

/**
 * Track the raw dispatcher promise. The returned promise may be raced against
 * a caller timeout; the lease intentionally remains held until raw work
 * settles, preventing timeout from becoming a false cancellation drain.
 */
export function startTrackedRunMutation<T>(
  db: Db,
  runId: string,
  start: () => Promise<T>,
): { promise: Promise<T>; admitted: true } | { admitted: false } {
  const lease = acquireRunMutationLease(db, runId);
  if (!lease) return { admitted: false };

  let promise: Promise<T>;
  try {
    promise = start();
  } catch (error) {
    lease.release();
    throw error;
  }
  void promise.then(
    () => lease.release(),
    () => lease.release(),
  );
  return { admitted: true, promise };
}

import assert from "node:assert/strict";
import test from "node:test";
import { coordinateNotificationPermissionController, createNotificationPermissionController } from "./notification-permission";
import { isNativeNotificationPermission } from "./contract";

const current = () => true;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("permission validator exposes exactly the four public strings", () => {
  for (const value of ["unknown", "not-determined", "granted", "denied"]) assert.equal(isNativeNotificationPermission(value), true);
  for (const value of ["restricted", "provisional", "ephemeral", true, false, 2, null, {}, undefined]) assert.equal(isNativeNotificationPermission(value), false);
});

test("non-macOS permission methods never load the addon", async () => {
  for (const platform of ["win32", "linux"] as const) {
    const permission = createNotificationPermissionController(platform, () => { throw new Error("Must not load"); });
    assert.equal(await permission.get(), "unknown"); assert.equal(await permission.request(current), "unknown");
  }
});

for (const module of [undefined, null, {}, { getPermission() { return "granted"; } },
  { getPermission: true, requestPermission() {} }, { getPermission() {}, requestPermission: "bad" }]) {
  test(`invalid native module fails closed (${JSON.stringify(module)})`, async () => {
    const permission = createNotificationPermissionController("darwin", () => module);
    assert.equal(await permission.get(), "unknown"); assert.equal(await permission.request(current), "unknown");
  });
}

test("module load failures never become a granted status", async () => {
  const permission = createNotificationPermissionController("darwin", () => { throw new Error("Unavailable"); });
  assert.equal(await permission.get(), "unknown"); assert.equal(await permission.request(current), "unknown");
});

for (const value of ["unknown", "granted", "denied", "restricted", "provisional", "ephemeral", true, undefined]) {
  test(`permission ${String(value)} is validated without implicit authorization`, async () => {
    let requests = 0;
    const permission = createNotificationPermissionController("darwin", () => ({
      getPermission: async () => value, requestPermission: async () => { requests++; return "granted"; },
    }));
    assert.equal(await permission.get(), isNativeNotificationPermission(value) ? value : "unknown");
    await permission.request(current); assert.equal(requests, 0);
  });
}

test("explicit concurrent requests coalesce and re-read actual OS settings", async () => {
  let status = "not-determined"; let requests = 0; let queries = 0;
  let resolve: ((value: string) => void) | undefined;
  const permission = createNotificationPermissionController("darwin", () => ({
    getPermission: async () => { queries++; return status; },
    requestPermission: () => { requests++; return new Promise<string>((done) => { resolve = done; }); },
  }));
  assert.equal(permission.current(), "unknown");
  const first = permission.request(current); const second = permission.request(current);
  await settle(); assert.equal(requests, 1); assert.ok(resolve);
  status = "denied"; resolve("granted");
  assert.equal(await first, "denied"); assert.equal(await second, "denied");
  assert.equal(permission.current(), "denied"); assert.equal(queries, 2);
});

for (const staleStage of ["query", "request"]) {
  test(`stale ${staleStage} cannot authorize a departed document`, async () => {
    let valid = true; let requests = 0; let resolve: ((value: string) => void) | undefined;
    const permission = createNotificationPermissionController("darwin", () => ({
      getPermission: () => staleStage === "query" ? new Promise<string>((done) => { resolve = done; }) : "not-determined",
      requestPermission: () => { requests++; return new Promise<string>((done) => { resolve = done; }); },
    }));
    const pending = permission.request(() => valid); await settle(); assert.ok(resolve);
    valid = false; resolve(staleStage === "query" ? "not-determined" : "granted");
    assert.equal(await pending, "unknown"); assert.equal(permission.current(), "unknown");
    assert.equal(requests, staleStage === "query" ? 0 : 1);
  });
}

test("foreground is rechecked before OS call, but sheet blur does not invalidate completion", async () => {
  let focused = true; let status = "not-determined";
  const permission = createNotificationPermissionController("darwin", () => ({
    getPermission: async () => status,
    requestPermission: async () => { focused = false; status = "granted"; return "granted"; },
  }));
  assert.equal(await permission.request(current, () => focused), "granted");
});

test("query and request failures/timeouts remain unknown and late results cannot change the cache", async () => {
  for (const stage of ["query", "request"]) {
    for (const failure of ["throw", "reject", "timeout"]) {
      let resolve: ((value: string) => void) | undefined;
      const operation = () => {
        if (failure === "throw") throw new Error("Sensitive diagnostic");
        if (failure === "reject") return Promise.reject(new Error("Sensitive diagnostic"));
        return new Promise<string>((done) => { resolve = done; });
      };
      const permission = createNotificationPermissionController("darwin", () => ({
        getPermission: stage === "query" ? operation : () => "not-determined",
        requestPermission: operation,
      }), 5);
      assert.equal(await permission.request(current), "unknown");
      resolve?.("granted"); await settle(); assert.notEqual(permission.current(), "granted");
    }
  }
});

test("superseded query never borrows cached grant while a newer OS query is pending", async () => {
  let calls = 0; const pending: ((value: string) => void)[] = [];
  const permission = createNotificationPermissionController("darwin", () => ({
    getPermission: () => ++calls === 1 ? "granted" : new Promise<string>((resolve) => { pending.push(resolve); }),
    requestPermission: () => "unknown",
  }));
  assert.equal(await permission.get(), "granted");
  const old = permission.get(); await settle(); const next = permission.get(); await settle();
  assert.equal(pending.length, 2); pending[0]?.("denied");
  assert.equal(await old, "unknown"); pending[1]?.("denied");
  assert.equal(await next, "denied"); assert.equal(permission.current(), "denied");
});

test("an older granted query never overrides a newer revoked permission", async () => {
  let resolve: ((value: string) => void) | undefined; let calls = 0;
  const permission = createNotificationPermissionController("darwin", () => ({
    getPermission: () => ++calls === 1 ? new Promise<string>((done) => { resolve = done; }) : "denied",
    requestPermission: () => "unknown",
  }));
  const first = permission.get(); await settle(); assert.ok(resolve);
  assert.equal(await permission.get(), "denied"); resolve("granted");
  assert.notEqual(await first, "granted"); assert.equal(permission.current(), "denied");
});

for (const staleConsumer of [0, 1]) {
  test(`coordinator shares one read without letting stale consumer ${staleConsumer} cancel the other`, async () => {
    let resolve: ((value: string) => void) | undefined; let queries = 0;
    const valid = [true, true];
    const base = createNotificationPermissionController("darwin", () => ({
      getPermission: () => ++queries === 1 ? new Promise<string>((done) => { resolve = done; }) : "denied",
      requestPermission: () => { throw new Error("Passive reads must not prompt"); },
    }));
    const permission = coordinateNotificationPermissionController(base, current);
    const first = permission.get(() => valid[0]); const second = permission.get(() => valid[1]);
    await settle(); assert.equal(queries, 1); assert.ok(resolve);
    valid[staleConsumer] = false; resolve("granted");
    assert.deepEqual(await Promise.all([first, second]), staleConsumer === 0 ? ["unknown", "granted"] : ["granted", "unknown"]);
    assert.equal(permission.current(), "granted");
    assert.equal(await permission.get(), "denied"); assert.equal(queries, 2);
    assert.equal(permission.current(), "denied");
  });
}

test("coordinator places an explicit request between earlier and later passive snapshots", async () => {
  let resolve: ((value: string) => void) | undefined; let queries = 0; let status = "not-determined";
  const calls: string[] = [];
  const permission = coordinateNotificationPermissionController(createNotificationPermissionController("darwin", () => ({
    getPermission: () => {
      calls.push(`get:${++queries}`);
      return queries === 1 ? new Promise<string>((done) => { resolve = done; }) : status;
    },
    requestPermission: () => { calls.push("request"); status = "denied"; return "granted"; },
  })), current);
  const earlier = permission.get(); await settle(); assert.ok(resolve);
  const request = permission.request(current); const later = permission.get(); const joined = permission.get();
  await settle(); assert.deepEqual(calls, ["get:1"]);
  resolve("granted");
  assert.equal(await earlier, "granted"); assert.equal(await request, "denied");
  assert.equal(await later, "denied"); assert.equal(await joined, "denied");
  assert.deepEqual(calls, ["get:1", "get:2", "request", "get:3", "get:4"]);
});

test("coordinator holds passive reads until the complete explicit prompt and OS reread finish", async () => {
  let resolve: ((value: string) => void) | undefined; let status = "not-determined"; let queries = 0; let requests = 0;
  const permission = coordinateNotificationPermissionController(createNotificationPermissionController("darwin", () => ({
    getPermission: () => { queries++; return status; },
    requestPermission: () => { requests++; return new Promise<string>((done) => { resolve = done; }); },
  })), current);
  const request = permission.request(current); await settle(); assert.ok(resolve);
  const first = permission.get(); const second = permission.get();
  await settle(); assert.equal(queries, 1); assert.equal(requests, 1);
  status = "granted"; resolve("granted");
  assert.deepEqual(await Promise.all([request, first, second]), ["granted", "granted", "granted"]);
  assert.equal(queries, 3); assert.equal(permission.current(), "granted");
});

for (const change of ["document", "foreground", "quit"]) {
  test(`coordinator rechecks ${change} after its queued request query and before native prompt`, async () => {
    let valid = true; let focused = true; let alive = true; let requests = 0;
    let resolve: ((value: string) => void) | undefined;
    const permission = coordinateNotificationPermissionController(createNotificationPermissionController("darwin", () => ({
      getPermission: () => new Promise<string>((done) => { resolve = done; }),
      requestPermission: () => { requests++; return "granted"; },
    })), () => alive);
    const pending = permission.request(() => valid, () => focused); await settle(); assert.ok(resolve);
    if (change === "document") valid = false;
    if (change === "foreground") focused = false;
    if (change === "quit") alive = false;
    resolve("not-determined");
    assert.equal(await pending, "unknown"); assert.equal(requests, 0);
  });
}

test("coordinator rejects late grants after quit without running queued native operations", async () => {
  let alive = true; let queries = 0; let requests = 0; let resolve: ((value: string) => void) | undefined;
  const permission = coordinateNotificationPermissionController(createNotificationPermissionController("darwin", () => ({
    getPermission: () => { queries++; return new Promise<string>((done) => { resolve = done; }); },
    requestPermission: () => { requests++; return "granted"; },
  })), () => alive);
  const read = permission.get(); await settle(); assert.ok(resolve);
  const request = permission.request(current); const later = permission.get(); alive = false; resolve("granted");
  assert.deepEqual(await Promise.all([read, request, later]), ["unknown", "unknown", "unknown"]);
  assert.equal(permission.current(), "unknown"); assert.equal(queries, 1); assert.equal(requests, 0);
});

for (const stage of ["query", "request"]) {
  for (const failure of ["throw", "reject", "timeout", "provisional", "denied"]) {
    test(`coordinator recovers after ${stage} ${failure} without caching a grant or blocking the queue`, async () => {
      let failed = true; let resolve: ((value: string) => void) | undefined;
      const operation = () => {
        if (failure === "throw") throw new Error("Sensitive diagnostic");
        if (failure === "reject") return Promise.reject(new Error("Sensitive diagnostic"));
        if (failure === "timeout") return new Promise<string>((done) => { resolve = done; });
        return failure;
      };
      const permission = coordinateNotificationPermissionController(createNotificationPermissionController("darwin", () => ({
        getPermission: () => !failed ? "granted" : stage === "query" ? operation() : "not-determined",
        requestPermission: operation,
      }), 5), current);
      const pending = stage === "query" ? permission.get() : permission.request(current);
      const expected = failure === "denied" ? stage === "query" ? "denied" : "not-determined" : "unknown";
      assert.equal(await pending, expected);
      assert.notEqual(permission.current(), "granted");
      failed = false; resolve?.("granted");
      assert.equal(await permission.get(), "granted"); assert.equal(permission.current(), "granted");
    });
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { createHiddenRecoveryScheduler, isAbortedNavigation } from "./lifecycle";

function fixture() {
  let hasWindow = false;
  let quitting = false;
  let recoveries = 0;
  let onRecover: (() => void) | undefined;
  const queue: (() => void)[] = [];
  const recover = createHiddenRecoveryScheduler({
    hasWindow: () => hasWindow,
    isQuitting: () => quitting,
    schedule: (callback) => { queue.push(callback); },
    recoverHidden: () => { recoveries += 1; hasWindow = true; onRecover?.(); },
  });
  return {
    recover, queue, recoveries: () => recoveries,
    setWindow: (value: boolean) => { hasWindow = value; },
    quit: () => { quitting = true; },
    onRecover: (callback: () => void) => { onRecover = callback; },
    flush: () => { const callback = queue.shift(); assert.ok(callback); callback(); },
  };
}

test("only explicit Chromium ERR_ABORTED errno is ignored, not unrelated load errors", () => {
  assert.equal(isAbortedNavigation({ errno: -3 }), true);
  for (const value of [null, {}, { errno: -105 }, { errno: -202 }, { errno: "-3" }, { code: "ERR_ABORTED" }, new Error("network")]) {
    assert.equal(isAbortedNavigation(value), false);
  }
});

test("unexpected root destruction queues only one hidden recovery", () => {
  const f = fixture();
  f.recover(); f.recover(); f.recover();
  assert.equal(f.queue.length, 1);
  assert.equal(f.recoveries(), 0);
  f.flush();
  assert.equal(f.recoveries(), 1);
  f.recover();
  assert.equal(f.queue.length, 0);
});

test("explicit Quit prevents both scheduled and subsequent recovery", () => {
  const f = fixture();
  f.recover();
  f.quit();
  f.flush();
  f.recover();
  assert.equal(f.recoveries(), 0);
  assert.equal(f.queue.length, 0);
});

test("an explicit Open recreating the root before scheduled recovery does not duplicate it", () => {
  const f = fixture();
  f.recover();
  f.setWindow(true);
  f.flush();
  assert.equal(f.recoveries(), 0);
});

test("synchronous close during replacement cannot create a reentrant recovery loop", () => {
  const f = fixture();
  f.onRecover(() => { f.setWindow(false); f.recover(); });
  f.recover();
  f.flush();
  assert.equal(f.recoveries(), 1);
  assert.equal(f.queue.length, 0);
});

test("a later independent root destruction can recover again", () => {
  const f = fixture();
  f.recover(); f.flush();
  f.setWindow(false);
  f.recover(); f.flush();
  assert.equal(f.recoveries(), 2);
});

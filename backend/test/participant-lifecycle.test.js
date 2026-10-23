import test from "node:test";
import assert from "node:assert/strict";
import { scheduleStoppedLogout } from "../../frontend/src/platform/stoppedLogout.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("stopped participant signs out after 60 seconds and navigation does not extend the deadline", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const session = storage();
  let logouts = 0;
  const dispose = scheduleStoppedLogout(session, "run-a", () => logouts++);
  t.mock.timers.tick(30000);
  assert.equal(logouts, 0);
  dispose();
  scheduleStoppedLogout(session, "run-a", () => logouts++);
  t.mock.timers.tick(29999);
  assert.equal(logouts, 0);
  t.mock.timers.tick(1);
  assert.equal(logouts, 1);
});

test("expired stop deadline signs out immediately; unmount cancels pending logout", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const session = storage();
  let logouts = 0;
  session.setItem("expired-run", "99999");
  scheduleStoppedLogout(session, "expired-run", () => logouts++);
  t.mock.timers.tick(1);
  assert.equal(logouts, 1);
  const dispose = scheduleStoppedLogout(session, "other-run", () => logouts++);
  dispose();
  t.mock.timers.tick(60000);
  assert.equal(logouts, 1);
});

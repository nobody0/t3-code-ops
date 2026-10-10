import test from "node:test";
import assert from "node:assert/strict";
import { monitorLiveness, backoffDelay, sleepUnlessAborted } from "./lib/service-monitor.mjs";
test("healthy and degraded probes reset failures; a sustained outage is confirmed", async () => {
  const abort = new AbortController();
  let n = 0;
  const result = await monitorLiveness({
    signal: abort.signal,
    startupGraceMs: 0,
    intervalMs: 20,
    failureLimit: 2,
    failureSpanMs: 40,
    probe: async () => ({ kind: ++n < 3 ? "degraded" : "down" }),
    onProbe: () => {},
  });
  assert.equal(result, "unresponsive");
  assert.ok(n >= 5);
});
test("cancellation stops health polling without recovery; backoff is capped", async () => {
  const abort = new AbortController();
  let probes = 0;
  const result = await monitorLiveness({
    signal: abort.signal,
    startupGraceMs: 100,
    intervalMs: 5,
    failureLimit: 2,
    probe: async () => {
      probes++;
      return { kind: "healthy" };
    },
    onProbe: () => abort.abort(),
  });
  assert.equal(result, "cancelled");
  assert.equal(probes, 1);
  assert.deepEqual(
    [0, 1, 2, 10].map((n) => backoffDelay(n, 1000, 300000)),
    [1000, 2000, 4000, 300000],
  );
  assert.equal(await sleepUnlessAborted(1000, abort.signal), false);
});

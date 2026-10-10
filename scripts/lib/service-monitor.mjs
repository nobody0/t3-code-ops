// Shared by the KO and T3 app wrappers. No OS service control or process discovery.
export function sleepUnlessAborted(ms, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (completed) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      resolve(completed);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
export function backoffDelay(failures, baseMs = 500, maxMs = 30_000) {
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures, 16));
}
export async function monitorLiveness({
  signal,
  probe,
  onProbe,
  startupGraceMs,
  intervalMs,
  startupIntervalMs = 1000,
  failureLimit,
  failureSpanMs = 0,
}) {
  let graceEnds = Date.now() + startupGraceMs;
  let failures = 0,
    ready = false,
    firstFailureAt = null,
    lastProbeAt = Date.now();
  while (!signal.aborted) {
    const now = Date.now();
    if (now - lastProbeAt > Math.max(intervalMs * 2.5, startupGraceMs)) {
      failures = 0;
      firstFailureAt = null;
      graceEnds = now + startupGraceMs;
    }
    const result = await probe();
    // A slow health request is a failed probe, not evidence of device sleep.
    lastProbeAt = Date.now();
    if (signal.aborted) break;
    if (result.kind === "healthy" || result.kind === "degraded") {
      ready = true;
      failures = 0;
      firstFailureAt = null;
    } else if (Date.now() >= graceEnds) {
      failures++;
      firstFailureAt ??= Date.now();
    }
    onProbe(result, failures, ready);
    if (failures >= failureLimit && Date.now() - firstFailureAt >= failureSpanMs)
      return "unresponsive";
    if (
      !(await sleepUnlessAborted(
        ready || Date.now() >= graceEnds ? intervalMs : startupIntervalMs,
        signal,
      ))
    )
      break;
  }
  return "cancelled";
}

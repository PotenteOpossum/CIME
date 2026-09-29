// State belongs to this polling instance, not to a render captured by a timer.
export function createQualityPolling({ request, statisticsUrl, onData, onError, onLoading,
  schedule = setInterval, cancel = clearInterval }) {
  let disposed = false;
  let hasStats = false;
  let lastMessageCount = null;
  let pending = null;
  const controller = new AbortController();

  function refresh(force = false) {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      if (disposed) return;
      if (force || !hasStats) onLoading(true);
      try {
        let count = null;
        try {
          const data = await request('/admin/decision-process/message-count', { signal: controller.signal });
          if (Number.isFinite(data?.count)) count = data.count;
        } catch (error) {
          if (controller.signal.aborted) return;
        }
        if (disposed) return;
        const changed = count !== null && (lastMessageCount === null || count < lastMessageCount || count - lastMessageCount >= 5);
        if (force || !hasStats || changed) {
          const data = await request(statisticsUrl, { signal: controller.signal });
          if (disposed) return;
          hasStats = true;
          lastMessageCount = count;
          onData(data);
          onError(null);
        }
      } catch (error) {
        if (!disposed) onError(error.message || 'Failed to fetch statistics');
      } finally {
        if (!disposed) onLoading(false);
      }
    }).finally(() => { pending = null; });
    return pending;
  }

  const interval = schedule(() => refresh(), 15000);
  refresh(true);
  return {
    refresh,
    dispose() {
      disposed = true;
      cancel(interval);
      controller.abort();
    }
  };
}

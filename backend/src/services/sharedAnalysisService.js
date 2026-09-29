import { cancellationError, getWorkContext, runWithWorkContext, throwIfWorkCancelled } from './workContext.js';

const pending = new Map();

// Completed results live in SQLite. This map only covers the gap between a
// cache miss and its saved result, shared across all tabs and HTTP requests.
export async function shareAnalysis(key, task) {
  throwIfWorkCancelled();
  const context = getWorkContext();
  const signal = context?.signal;
  let entry = pending.get(key);
  if (entry?.controller.signal.aborted) {
    // Let an already submitted API call finish/cache before a new subscriber
    // retries. Aborting a browser must not cause a parallel paid replacement.
    await entry.promise.catch(() => {});
    throwIfWorkCancelled();
    return shareAnalysis(key, task);
  }
  if (!entry) {
    entry = { controller: new AbortController(), consumers: 0, settled: false };
    pending.set(key, entry);
    entry.promise = Promise.resolve().then(() => runWithWorkContext(
      { ...context, signal: entry.controller.signal }, task
    )).finally(() => {
      entry.settled = true;
      if (pending.get(key) === entry) pending.delete(key);
    });
  }
  entry.consumers++;
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return false;
      released = true;
      signal?.removeEventListener('abort', onAbort);
      entry.consumers--;
      if (!entry.settled && entry.consumers === 0) entry.controller.abort();
      return true;
    };
    const onAbort = () => {
      if (release()) reject(cancellationError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      (result) => { if (release()) resolve(result); },
      (error) => { if (release()) reject(error); }
    );
    if (signal?.aborted) onAbort();
  });
}

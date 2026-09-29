import { AsyncLocalStorage } from 'node:async_hooks';

const contexts = new AsyncLocalStorage();

export function getWorkContext() {
  return contexts.getStore();
}

export function runWithWorkContext(context, task) {
  return contexts.run(context, task);
}

export function cancellationError() {
  const error = new Error('Work is no longer needed.');
  error.name = 'AbortError';
  return error;
}

export function throwIfWorkCancelled() {
  const context = getWorkContext();
  if (context?.signal?.aborted || (context?.isCurrent && !context.isCurrent())) {
    throw cancellationError();
  }
}

// Express emits response close when the browser disconnects, including when it
// aborts a fetch. Request close alone also fires on normally completed GETs.
export function withRequestWork(handler, workType = 'request') {
  return async (req, res, next) => {
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', disconnect);
    req.once('aborted', disconnect);
    try {
      return await runWithWorkContext({ signal: controller.signal, workType }, () => handler(req, res, next));
    } catch (error) {
      if (error.name !== 'AbortError') next(error);
    } finally {
      controller.abort();
      res.off('close', disconnect);
      req.off('aborted', disconnect);
    }
  };
}

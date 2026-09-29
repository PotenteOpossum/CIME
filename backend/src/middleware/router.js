import express from 'express';

function guard(handler) {
  if (Array.isArray(handler)) return handler.map(guard);
  return function guardedRoute(req, res, next) {
    Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };
}

export function createRouter() {
  const router = express.Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const register = router[method];
    router[method] = function (route, ...handlers) {
      return register.call(this, route, ...handlers.map(guard));
    };
  }
  return router;
}

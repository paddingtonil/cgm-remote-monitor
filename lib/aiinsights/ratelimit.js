'use strict';

// Sliding-window rate limiter for the aiinsights router
// (docs/proposals/ai-insights-design.md 7.5). No external dependency: a Map
// of timestamps per (route name, client key). Keyed by the caller's IP as
// Express resolves it (trust proxy is configured in lib/server/app.js).

function createRateLimiter (opts) {
  opts = opts || { };
  var now = opts.now || function () { return Date.now(); };
  var buckets = new Map();

  function prune (list, windowStart) {
    while (list.length && list[0] <= windowStart) { list.shift(); }
  }

  /**
   * check(name, clientKey, { max, windowMs }) -> { allowed, retryAfterSeconds, remaining }
   */
  function check (name, clientKey, limit) {
    var key = name + ':' + clientKey;
    var current = now();
    var windowStart = current - limit.windowMs;
    var list = buckets.get(key);
    if (!list) { list = []; buckets.set(key, list); }
    prune(list, windowStart);
    if (list.length >= limit.max) {
      var retryAfterMs = list[0] + limit.windowMs - current;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)), remaining: 0 };
    }
    list.push(current);
    return { allowed: true, retryAfterSeconds: 0, remaining: limit.max - list.length };
  }

  /**
   * Express middleware factory.
   */
  function middleware (name, limit) {
    return function rateLimited (req, res, next) {
      var clientKey = (req.ip || (req.connection && req.connection.remoteAddress) || 'unknown');
      var result = check(name, clientKey, limit);
      if (result.allowed) { return next(); }
      res.set('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({
        status: 429
        , message: 'Too Many Requests'
        , description: 'Rate limit for ' + name + ' exceeded; retry in ' + result.retryAfterSeconds + 's'
      });
    };
  }

  function reset () { buckets.clear(); }

  return { check: check, middleware: middleware, reset: reset };
}

module.exports = createRateLimiter;

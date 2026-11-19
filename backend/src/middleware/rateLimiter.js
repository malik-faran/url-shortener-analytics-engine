/**
 * Rate Limiter Middleware
 *
 * Implements a sliding-window IP rate limiter for URL creation.
 * Sets X-RateLimit-Limit and X-RateLimit-Remaining headers and returns
 * 429 Too Many Requests when the window is exhausted.
 */

/**
 * Create a rate limiter with sliding-window logic.
 * @param {number} maxRequests - max requests per window
 * @param {number} windowMs - window duration in milliseconds
 * @returns {Function & {reset: Function}} Express middleware
 */
function createRateLimiter(maxRequests, windowMs) {
  const windows = new Map(); // ip -> [timestamps]

  const middleware = (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    const recent = (windows.get(ip) || []).filter((ts) => now - ts < windowMs);
    windows.set(ip, recent);

    res.setHeader("X-RateLimit-Limit", String(maxRequests));

    if (recent.length >= maxRequests) {
      const retryAfter = Math.max(
        1,
        Math.ceil((windowMs - (now - recent[0])) / 1000)
      );
      res.setHeader("X-RateLimit-Remaining", "0");
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Too Many Requests",
        message: `Rate limit exceeded. Max ${maxRequests} requests per ${windowMs / 1000} seconds.`,
        retryAfter,
      });
    }

    recent.push(now);
    res.setHeader("X-RateLimit-Remaining", String(maxRequests - recent.length));
    next();
  };

  middleware.reset = () => windows.clear();
  return middleware;
}

const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 30;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;

/* --- Export configured limiter (30 req per minute by default) --- */
const limiter = createRateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

module.exports = limiter;
module.exports.createRateLimiter = createRateLimiter;
module.exports.reset = limiter.reset;

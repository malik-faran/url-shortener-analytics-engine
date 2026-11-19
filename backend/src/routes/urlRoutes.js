/**
 * URL Routes
 *
 * API endpoints for the URL shortener service.
 * The router is mounted at root (app.use("/", urlRoutes) in src/app.js).
 *
 * Route order matters: every /api/* route is registered before the
 * single-segment /:shortCode redirect so API paths are never swallowed.
 */

const express = require("express");
const router = express.Router();
const storage = require("../db/storage");
const cache = require("../cache/cacheManager");
const rateLimiter = require("../middleware/rateLimiter");
const UAParser = require("ua-parser-js");
const { validateUrl } = require("../utils/urlValidator");

const CACHE_TTL_MS = 300 * 1000;

/**
 * Wrap async handlers so rejected promises reach the Express error handler.
 * @param {Function} fn
 * @returns {Function}
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Build the absolute short URL for a code. */
function makeShortUrl(shortCode, req) {
  return `${req.protocol}://${req.get("host")}/${shortCode}`;
}

/**
 * Parse a User-Agent header into browser / OS / device labels.
 * @param {string} uaString
 * @returns {{browser: string, os: string, deviceType: string}}
 */
function parseUserAgent(uaString) {
  const parser = new UAParser(uaString || "");
  const result = parser.getResult();

  const browserName = result.browser.name || "Unknown";
  const browserVersion = result.browser.version
    ? ` ${result.browser.version.split(".")[0]}`
    : "";

  let deviceType = "Desktop";
  if (result.device.type) {
    deviceType =
      result.device.type.charAt(0).toUpperCase() + result.device.type.slice(1);
  } else if (result.os.name === "iOS" || result.os.name === "Android") {
    deviceType = "Mobile";
  }

  return {
    browser: `${browserName}${browserVersion}`.trim(),
    os: result.os.name || "Unknown",
    deviceType,
  };
}

/**
 * POST /api/urls
 * Create a short URL. Accepts originalUrl, optional customAlias and
 * optional expiresInHours.
 */
router.post(
  "/api/urls",
  rateLimiter,
  asyncHandler(async (req, res) => {
    const { originalUrl, customAlias, expiresInHours } = req.body || {};

    if (!originalUrl || typeof originalUrl !== "string") {
      return res.status(400).json({ error: "originalUrl is required" });
    }
    if (!validateUrl(originalUrl)) {
      return res
        .status(400)
        .json({ error: "Invalid URL format. Use an absolute http(s) URL." });
    }
    if (
      expiresInHours !== undefined &&
      expiresInHours !== null &&
      expiresInHours !== "" &&
      (Number.isNaN(Number(expiresInHours)) || Number(expiresInHours) <= 0)
    ) {
      return res
        .status(400)
        .json({ error: "expiresInHours must be a positive number" });
    }

    const saved = await storage.saveUrl(originalUrl, {
      customAlias,
      expiresInHours,
    });

    const record = await storage.getUrl(saved.shortCode);
    if (record) {
      await cache.set(`url:${saved.shortCode}`, record, CACHE_TTL_MS);
    }

    res.status(201).json({
      shortCode: saved.shortCode,
      shortUrl: makeShortUrl(saved.shortCode, req),
      originalUrl,
      customAlias: saved.customAlias,
      expiresAt: saved.expiresAt,
      message: "URL shortened successfully",
    });
  })
);

/**
 * GET /api/urls
 * List every shortened URL with click counts and expiry information.
 */
router.get(
  "/api/urls",
  asyncHandler(async (req, res) => {
    const urls = await storage.listUrls();
    res.json(urls);
  })
);

/**
 * GET /api/urls/:shortCode/analytics
 * Time-series clicks plus browser / OS / device breakdowns.
 */
router.get(
  "/api/urls/:shortCode/analytics",
  asyncHandler(async (req, res) => {
    const analytics = await storage.getAnalytics(req.params.shortCode);
    if (!analytics) {
      return res.status(404).json({ error: "URL not found" });
    }
    res.json(analytics);
  })
);

/**
 * DELETE /api/urls/:shortCode
 * Remove a URL from storage and invalidate its cache entry.
 */
router.delete(
  "/api/urls/:shortCode",
  asyncHandler(async (req, res) => {
    const { shortCode } = req.params;
    const deleted = await storage.deleteUrl(shortCode);
    await cache.del(`url:${shortCode}`);

    if (!deleted) {
      return res.status(404).json({ error: "URL not found" });
    }
    res.json({ message: "URL deleted successfully", shortCode });
  })
);

/**
 * GET /:shortCode
 * Cache-aside redirect. Sets X-Cache: HIT or MISS, records click metadata,
 * and returns 302 to the original URL.
 */
router.get(
  "/:shortCode",
  asyncHandler(async (req, res) => {
    const { shortCode } = req.params;
    const cacheKey = `url:${shortCode}`;

    const cached = await cache.get(cacheKey);
    res.set("X-Cache", cached.found ? "HIT" : "MISS");

    let urlData = cached.found ? cached.value : await storage.getUrl(shortCode);

    if (!urlData) {
      if (cached.found) await cache.del(cacheKey);
      return res.status(404).json({ error: "URL not found" });
    }

    // Recompute expiry from the record so a cached entry cannot outlive it.
    const isExpired = urlData.expiresAt
      ? new Date(urlData.expiresAt).getTime() <= Date.now()
      : false;

    if (isExpired) {
      await storage.deleteUrl(shortCode);
      await cache.del(cacheKey);
      return res.status(410).json({ error: "URL has expired" });
    }

    // Cache-aside: populate on miss so the next request is a HIT.
    if (!cached.found) {
      await cache.set(cacheKey, urlData, CACHE_TTL_MS);
    }

    const meta = parseUserAgent(req.get("User-Agent"));
    await storage.recordClick(shortCode, meta);

    res.redirect(302, urlData.originalUrl);
  })
);

/* --- Export --- */
module.exports = router;
module.exports.parseUserAgent = parseUserAgent;

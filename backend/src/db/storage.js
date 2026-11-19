/**
 * Storage Adapter
 *
 * Provides a unified interface for URL persistence.
 * - If DATABASE_URL is set: uses PostgreSQL (pg Pool) and auto-creates tables.
 * - Otherwise: falls back to a zero-dependency persistent JSON file store.
 *
 * The adapter exposes the same async API for both backends so the routes never
 * need to know which storage engine is active.
 */

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "..", "data");

/**
 * Resolve the JSON store file. `DATA_FILE` makes tests (and container mounts)
 * able to point at an isolated file without touching the repository.
 */
function getStoreFile() {
  if (process.env.DATA_FILE) return path.resolve(process.env.DATA_FILE);
  return path.join(DEFAULT_DATA_DIR, "store.json");
}

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SHORT_CODE_LENGTH = 7;
const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

/* --- PostgreSQL state --- */

let pgPool = null;

/* --- JSON store state --- */

let jsonStore = null;
let writeChain = Promise.resolve();

/* --- Helpers --- */

/**
 * Ensure the data directory and store file exist.
 */
async function ensureStore() {
  const storeFile = getStoreFile();
  await fs.mkdir(path.dirname(storeFile), { recursive: true });
  try {
    await fs.access(storeFile);
  } catch {
    await fs.writeFile(storeFile, JSON.stringify({ urls: {}, clickEvents: [] }, null, 2));
  }
}

/**
 * Base62 encoding for numeric ids.
 * @param {number} num
 * @returns {string}
 */
function base62Encode(num) {
  if (num === 0) return BASE62[0];
  let encoded = "";
  let value = num;
  while (value > 0) {
    encoded = BASE62[value % 62] + encoded;
    value = Math.floor(value / 62);
  }
  return encoded;
}

/**
 * Cryptographically random Base62 short code.
 * @param {number} [length]
 * @returns {string}
 */
function randomShortCode(length = SHORT_CODE_LENGTH) {
  const bytes = crypto.randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) {
    code += BASE62[bytes[i] % 62];
  }
  return code;
}

/**
 * Create an Error that carries an HTTP status for the route layer.
 */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Persist the in-memory JSON store, serialising writes so concurrent
 * requests cannot interleave partial writes.
 */
function persistJson() {
  const payload = JSON.stringify(jsonStore, null, 2);
  writeChain = writeChain.then(() => fs.writeFile(getStoreFile(), payload));
  return writeChain;
}

function emptyAnalytics() {
  return { byDay: {}, byHour: {}, browsers: {}, os: {}, devices: {} };
}

/* --- PostgreSQL Storage --- */

/**
 * Initialize PostgreSQL pool and schema.
 * @param {import('pg').Pool} pool
 */
async function initPg(pool) {
  pgPool = pool;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS urls (
      id SERIAL PRIMARY KEY,
      short_code VARCHAR(64) UNIQUE NOT NULL,
      original_url TEXT NOT NULL,
      custom_alias VARCHAR(64) UNIQUE,
      expires_at TIMESTAMP,
      click_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS click_events (
      id SERIAL PRIMARY KEY,
      url_id INTEGER REFERENCES urls(id) ON DELETE CASCADE,
      browser VARCHAR(64),
      os VARCHAR(64),
      device_type VARCHAR(32),
      clicked_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pgPool.query(
    "CREATE INDEX IF NOT EXISTS idx_click_events_url_id ON click_events(url_id);"
  );
}

/* --- JSON File Store --- */

/**
 * Load the JSON store into memory (idempotent).
 */
async function initJson() {
  if (jsonStore) return;
  await ensureStore();
  try {
    const raw = await fs.readFile(getStoreFile(), "utf8");
    const parsed = JSON.parse(raw);
    jsonStore = {
      urls: parsed.urls && typeof parsed.urls === "object" ? parsed.urls : {},
      clickEvents: Array.isArray(parsed.clickEvents) ? parsed.clickEvents : [],
    };
  } catch {
    jsonStore = { urls: {}, clickEvents: [] };
  }
}

/* --- Unified CRUD --- */

/**
 * Generate a short code that is not already taken.
 * @returns {Promise<string>}
 */
async function generateShortCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomShortCode();
    if (pgPool) {
      const existing = await pgPool.query(
        "SELECT 1 FROM urls WHERE short_code = $1",
        [code]
      );
      if (existing.rowCount === 0) return code;
    } else {
      await initJson();
      if (!jsonStore.urls[code]) return code;
    }
  }
  throw httpError(500, "Unable to generate a unique short code");
}

/**
 * Save a shortened URL.
 * @param {string} originalUrl
 * @param {Object} [options] - options.customAlias, options.expiresInHours
 * @returns {Promise<{shortCode: string, urlId: number|string, customAlias: string|null, expiresAt: string|null}>}
 */
async function saveUrl(originalUrl, { customAlias, expiresInHours } = {}) {
  const alias = customAlias ? String(customAlias).trim() : "";
  if (alias && !ALIAS_PATTERN.test(alias)) {
    throw httpError(
      400,
      "customAlias must be 3-64 characters and contain only letters, numbers, hyphens or underscores"
    );
  }

  const hours = Number(expiresInHours);
  const expiresAt =
    expiresInHours !== undefined && expiresInHours !== null && expiresInHours !== "" && hours > 0
      ? new Date(Date.now() + hours * 3600 * 1000)
      : null;

  const shortCode = alias || (await generateShortCode());

  if (pgPool) {
    const duplicate = await pgPool.query(
      "SELECT 1 FROM urls WHERE short_code = $1",
      [shortCode]
    );
    if (duplicate.rowCount > 0) {
      throw httpError(409, `Short code "${shortCode}" is already in use`);
    }
    const result = await pgPool.query(
      `INSERT INTO urls (short_code, original_url, custom_alias, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [shortCode, originalUrl, alias || null, expiresAt]
    );
    return {
      shortCode,
      urlId: result.rows[0].id,
      customAlias: alias || null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    };
  }

  await initJson();
  if (jsonStore.urls[shortCode]) {
    throw httpError(409, `Short code "${shortCode}" is already in use`);
  }

  jsonStore.urls[shortCode] = {
    shortCode,
    originalUrl,
    customAlias: alias || null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    clickCount: 0,
    createdAt: new Date().toISOString(),
    analytics: emptyAnalytics(),
  };
  await persistJson();

  return {
    shortCode,
    urlId: shortCode,
    customAlias: alias || null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}

/**
 * Normalise a storage record into the API shape.
 */
function toPublicUrl(record) {
  const expiresAt = record.expiresAt ? new Date(record.expiresAt) : null;
  const remainingMs = expiresAt ? expiresAt.getTime() - Date.now() : null;
  return {
    id: record.id !== undefined ? record.id : record.shortCode,
    shortCode: record.shortCode,
    originalUrl: record.originalUrl,
    customAlias: record.customAlias || null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    expiresInHours: expiresAt ? Math.max(0, Math.ceil(remainingMs / 3600000)) : null,
    expired: expiresAt ? remainingMs <= 0 : false,
    clickCount: record.clickCount || 0,
    createdAt: record.createdAt,
  };
}

/**
 * Get a URL by short code.
 * @param {string} shortCode
 * @returns {Promise<Object|null>}
 */
async function getUrl(shortCode) {
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT id, short_code, original_url, custom_alias, expires_at, click_count, created_at
       FROM urls WHERE short_code = $1`,
      [shortCode]
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return toPublicUrl({
      id: row.id,
      shortCode: row.short_code,
      originalUrl: row.original_url,
      customAlias: row.custom_alias,
      expiresAt: row.expires_at,
      clickCount: row.click_count,
      createdAt: row.created_at,
    });
  }

  await initJson();
  const record = jsonStore.urls[shortCode];
  if (!record) return null;
  return toPublicUrl(record);
}

/**
 * Record a click and its metadata.
 * @param {string} shortCode
 * @param {Object} [meta] - { browser, os, deviceType }
 * @returns {Promise<number>} new click count (0 if the URL is gone)
 */
async function recordClick(shortCode, meta = {}) {
  if (pgPool) {
    const found = await pgPool.query(
      "SELECT id FROM urls WHERE short_code = $1",
      [shortCode]
    );
    if (found.rowCount === 0) return 0;
    const urlId = found.rows[0].id;
    await pgPool.query(
      "INSERT INTO click_events (url_id, browser, os, device_type) VALUES ($1, $2, $3, $4)",
      [urlId, meta.browser || "Unknown", meta.os || "Unknown", meta.deviceType || "Unknown"]
    );
    const updated = await pgPool.query(
      "UPDATE urls SET click_count = click_count + 1 WHERE id = $1 RETURNING click_count",
      [urlId]
    );
    return updated.rows[0].click_count;
  }

  await initJson();
  const record = jsonStore.urls[shortCode];
  if (!record) return 0;

  record.clickCount = (record.clickCount || 0) + 1;
  if (!record.analytics) record.analytics = emptyAnalytics();

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hour = `${day}T${String(now.getUTCHours()).padStart(2, "0")}:00`;
  const { byDay, byHour, browsers, os, devices } = record.analytics;
  byDay[day] = (byDay[day] || 0) + 1;
  byHour[hour] = (byHour[hour] || 0) + 1;

  const browser = meta.browser || "Unknown";
  const platform = meta.os || "Unknown";
  const device = meta.deviceType || "Unknown";
  browsers[browser] = (browsers[browser] || 0) + 1;
  os[platform] = (os[platform] || 0) + 1;
  devices[device] = (devices[device] || 0) + 1;

  jsonStore.clickEvents.push({
    shortCode,
    browser,
    os: platform,
    deviceType: device,
    clickedAt: now.toISOString(),
  });
  // Keep the event log bounded; aggregates above remain complete.
  if (jsonStore.clickEvents.length > 10000) {
    jsonStore.clickEvents = jsonStore.clickEvents.slice(-10000);
  }

  await persistJson();
  return record.clickCount;
}

/**
 * Backwards-compatible alias for recordClick.
 */
async function incrementClick(shortCode) {
  return recordClick(shortCode);
}

/**
 * Delete a URL by short code.
 * @param {string} shortCode
 * @returns {Promise<boolean>}
 */
async function deleteUrl(shortCode) {
  if (pgPool) {
    const result = await pgPool.query(
      "DELETE FROM urls WHERE short_code = $1 RETURNING short_code",
      [shortCode]
    );
    return result.rowCount > 0;
  }

  await initJson();
  if (!jsonStore.urls[shortCode]) return false;
  delete jsonStore.urls[shortCode];
  jsonStore.clickEvents = jsonStore.clickEvents.filter((e) => e.shortCode !== shortCode);
  await persistJson();
  return true;
}

/**
 * List all URLs, newest first.
 * @returns {Promise<Array>}
 */
async function listUrls() {
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT id, short_code, original_url, custom_alias, expires_at, click_count, created_at
       FROM urls ORDER BY created_at DESC`
    );
    return result.rows.map((row) =>
      toPublicUrl({
        id: row.id,
        shortCode: row.short_code,
        originalUrl: row.original_url,
        customAlias: row.custom_alias,
        expiresAt: row.expires_at,
        clickCount: row.click_count,
        createdAt: row.created_at,
      })
    );
  }

  await initJson();
  return Object.values(jsonStore.urls)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .map(toPublicUrl);
}

/**
 * Return aggregated analytics for a short code.
 * @param {string} shortCode
 * @returns {Promise<Object|null>}
 */
async function getAnalytics(shortCode) {
  if (pgPool) {
    const urlResult = await pgPool.query(
      "SELECT id, short_code, original_url, click_count FROM urls WHERE short_code = $1",
      [shortCode]
    );
    if (urlResult.rowCount === 0) return null;
    const url = urlResult.rows[0];

    const byDay = await pgPool.query(
      `SELECT to_char(date_trunc('day', clicked_at), 'YYYY-MM-DD') AS bucket, COUNT(*)::int AS clicks
       FROM click_events WHERE url_id = $1 GROUP BY bucket ORDER BY bucket`,
      [url.id]
    );
    const byHour = await pgPool.query(
      `SELECT to_char(date_trunc('hour', clicked_at), 'YYYY-MM-DD"T"HH24:00') AS bucket, COUNT(*)::int AS clicks
       FROM click_events WHERE url_id = $1 GROUP BY bucket ORDER BY bucket`,
      [url.id]
    );
    const browser = await pgPool.query(
      `SELECT COALESCE(browser, 'Unknown') AS name, COUNT(*)::int AS clicks
       FROM click_events WHERE url_id = $1 GROUP BY name ORDER BY clicks DESC`,
      [url.id]
    );
    const os = await pgPool.query(
      `SELECT COALESCE(os, 'Unknown') AS name, COUNT(*)::int AS clicks
       FROM click_events WHERE url_id = $1 GROUP BY name ORDER BY clicks DESC`,
      [url.id]
    );
    const device = await pgPool.query(
      `SELECT COALESCE(device_type, 'Unknown') AS name, COUNT(*)::int AS clicks
       FROM click_events WHERE url_id = $1 GROUP BY name ORDER BY clicks DESC`,
      [url.id]
    );

    return {
      shortCode,
      originalUrl: url.original_url,
      totalClicks: url.click_count,
      clicksByDay: byDay.rows.map((r) => ({ date: r.bucket, clicks: r.clicks })),
      clicksByHour: byHour.rows.map((r) => ({ timestamp: r.bucket, clicks: r.clicks })),
      browserBreakdown: Object.fromEntries(browser.rows.map((r) => [r.name, r.clicks])),
      osBreakdown: Object.fromEntries(os.rows.map((r) => [r.name, r.clicks])),
      deviceBreakdown: Object.fromEntries(device.rows.map((r) => [r.name, r.clicks])),
    };
  }

  await initJson();
  const record = jsonStore.urls[shortCode];
  if (!record) return null;

  const analytics = record.analytics || emptyAnalytics();
  const toSeries = (obj, key) =>
    Object.entries(obj)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, clicks]) => ({ [key]: bucket, clicks }));

  return {
    shortCode,
    originalUrl: record.originalUrl,
    totalClicks: record.clickCount || 0,
    clicksByDay: toSeries(analytics.byDay, "date"),
    clicksByHour: toSeries(analytics.byHour, "timestamp"),
    browserBreakdown: analytics.browsers,
    osBreakdown: analytics.os,
    deviceBreakdown: analytics.devices,
  };
}

/**
 * Current storage engine name.
 * @returns {"postgresql"|"json-file"}
 */
function getStorageMode() {
  return pgPool ? "postgresql" : "json-file";
}

/**
 * Test helper: clear the in-memory JSON store and reset the pool.
 */
async function resetStore() {
  pgPool = null;
  jsonStore = { urls: {}, clickEvents: [] };
  if (!process.env.DATA_FILE) return;
  await ensureStore();
  await fs.writeFile(getStoreFile(), JSON.stringify(jsonStore, null, 2));
}

/* --- Export --- */

module.exports = {
  initPg,
  initJson,
  generateShortCode,
  randomShortCode,
  saveUrl,
  getUrl,
  recordClick,
  incrementClick,
  deleteUrl,
  listUrls,
  getAnalytics,
  getStorageMode,
  base62Encode,
  resetStore,
};

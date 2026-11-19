/**
 * Application Entry Point
 *
 * Sets up Express, middleware, storage, cache, and routes.
 * `start()` binds the HTTP listener; requiring this module only builds the app
 * so the Jest/Supertest suite can mount it on an ephemeral port.
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const storage = require("./db/storage");
const cache = require("./cache/cacheManager");
const urlRoutes = require("./routes/urlRoutes");

const app = express();
const PORT = Number(process.env.PORT) || 8000;

app.set("trust proxy", true);

// --- Middleware ---

// Lightweight security headers (no native dependencies).
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

const configuredOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowAllOrigins = configuredOrigins.includes("*");

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowAllOrigins || configuredOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    methods: ["GET", "POST", "DELETE", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10kb" }));

// Health check (never rate limited).
app.get("/api/health", (req, res) => {
  const stats = cache.getStats();
  res.json({
    status: "ok",
    uptimeSeconds: Math.floor(process.uptime()),
    storageMode: storage.getStorageMode(),
    cacheMode: stats.mode,
    cacheHits: stats.hits,
    cacheMisses: stats.misses,
    cacheHitRatio: stats.hitRatio,
    rateLimit: {
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
      max: Number(process.env.RATE_LIMIT_MAX) || 30,
    },
  });
});

// Application routes (rate limiting is applied per-route).
app.use("/", urlRoutes);

// Catch-all 404.
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// Global error handler.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error("[app] Unhandled error:", err.message);
  }
  res.status(status).json({ error: status >= 500 ? "Internal Server Error" : err.message });
});

// --- Initialization ---

let initPromise = null;

/**
 * Initialize storage and cache exactly once.
 * @returns {Promise<void>}
 */
function initializeApp() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (process.env.DATABASE_URL) {
      const { Pool } = require("pg");
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      await storage.initPg(pool);
      console.log("[app] Using PostgreSQL storage.");
    } else {
      await storage.initJson();
      console.log("[app] Using JSON file storage (fallback).");
    }

    const redisClient = process.env.REDIS_URL
      ? new (require("ioredis"))(process.env.REDIS_URL)
      : null;
    await cache.initCache(redisClient);
  })();

  return initPromise;
}

/**
 * Start the HTTP server.
 * @param {number} [port]
 * @returns {Promise<import('http').Server>}
 */
async function start(port = PORT) {
  await initializeApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`[app] Listening on http://localhost:${server.address().port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
}

/* --- Start only when executed directly (`node src/app.js`) --- */
if (require.main === module) {
  start().catch((err) => {
    console.error("[app] Failed to start:", err.message);
    process.exit(1);
  });
}

/* --- Export for testing --- */
module.exports = { app, start, initializeApp };

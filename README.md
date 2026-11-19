# High-Throughput URL Shortener & Real-Time Analytics Engine

A production-oriented URL shortener built with **Node.js, Express, PostgreSQL, Redis and React**. It pairs a cache-aside redirect path with a live analytics dashboard that tracks clicks, browsers, operating systems and device types in real time.

<p>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white" />
  <img alt="Express" src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-15-4169E1?logo=postgresql&logoColor=white" />
  <img alt="Redis" src="https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" />
</p>

---

## Overview

The service exposes a small REST API for creating and managing short links, plus a redirect endpoint optimised for the hot path:

1. A request for `GET /:shortCode` first checks **Redis** (or the in-memory fallback).
2. On a cache hit the redirect is served without touching the database.
3. On a miss the record is loaded from **PostgreSQL**, cached, and the click is recorded.
4. Click metadata is aggregated into daily/hourly buckets and browser/OS/device counters.
5. The React dashboard visualises those aggregates and the live cache hit ratio.

If `DATABASE_URL` or `REDIS_URL` are not provided, the backend transparently falls back to a **JSON file store** and an **in-memory TTL cache**, so the project runs with zero external services.

---

## Features

- **Fast redirects** — cache-aside layer with `X-Cache: HIT | MISS` response headers.
- **Custom aliases** — user-defined codes such as `/launch-2026`, with duplicate protection.
- **Link expiration** — optional TTL in hours; expired links return `410 Gone` and are removed.
- **Sliding-window rate limiting** — per-IP limit (30 req/min by default) with `429` and `Retry-After`.
- **Real-time analytics** — total clicks, clicks by day/hour, browser, OS and device breakdowns.
- **Dual storage engines** — PostgreSQL in production, JSON file store for local/dev/test.
- **Dual cache engines** — Redis when available, in-memory Map otherwise.
- **Graceful degradation** — Redis or PostgreSQL outages do not take the API down.
- **Input validation** — absolute `http(s)` URLs only, alias format and length checks.
- **Containerised** — multi-stage Dockerfiles and a single `docker compose up`.
- **CI pipeline** — backend tests, frontend production build and compose validation on every push.

---

## Architecture

```mermaid
flowchart LR
    Browser[Browser / API client] -->|HTTPS| Nginx[Nginx + React SPA]
    Nginx -->|/api/* and /:shortCode| API[Express API]

    API -->|1. GET url:code| Cache[(Redis / in-memory TTL)]
    Cache -->|MISS| DB[(PostgreSQL / JSON store)]
    DB -->|cache fill| Cache
    Cache -->|HIT| Redirect[302 Redirect]
    DB -->|record click| Analytics[(click_events / aggregates)]
    Analytics --> Dashboard[Analytics dashboard]

    subgraph Backend
        API
        Limiter[Sliding-window rate limiter]
        API --- Limiter
    end
```

### Request lifecycle — `GET /:shortCode`

| Step | Action |
| ---- | ------ |
| 1 | Resolve the short code from the path. |
| 2 | Look up `url:<code>` in the cache and set `X-Cache`. |
| 3 | On a miss, read the record from storage and populate the cache (300 s TTL). |
| 4 | Reject missing (`404`) and expired (`410`) links. |
| 5 | Parse the `User-Agent` into browser / OS / device. |
| 6 | Persist the click and update aggregates. |
| 7 | Respond with `302 Location: <originalUrl>`. |

---

## Tech Stack

| Layer | Technology |
| ----- | ---------- |
| API | Node.js 20, Express 4, `ua-parser-js` |
| Storage | PostgreSQL 15 (`pg`), JSON file fallback |
| Cache | Redis 7 (`ioredis`), in-memory Map fallback |
| Frontend | React 18, Vite 5, Tailwind CSS 3, Recharts, lucide-react |
| Tests | Jest 29, Supertest |
| Infrastructure | Docker, Docker Compose, Nginx, GitHub Actions |

---

## Project Structure

```text
.
├── backend/
│   ├── src/
│   │   ├── app.js                 # Express app, health check, startup
│   │   ├── cache/cacheManager.js  # Redis / in-memory cache-aside layer
│   │   ├── db/storage.js          # PostgreSQL / JSON storage adapter
│   │   ├── middleware/rateLimiter.js
│   │   ├── routes/urlRoutes.js    # REST API + redirect endpoint
│   │   └── utils/urlValidator.js
│   ├── tests/url.test.js          # Jest + Supertest integration suite
│   ├── Dockerfile
│   └── .env.example
├── frontend/
│   ├── src/App.jsx                # Dashboard (KPIs, charts, links table)
│   ├── nginx.conf                 # SPA + API reverse proxy
│   └── Dockerfile
├── docker-compose.yml
├── docs/ci.yml.example          # GitHub Actions workflow template
└── README.md
```

---

## Quick Start

### Option 1 — Docker Compose (recommended)

```bash
git clone https://github.com/malik-faran/url-shortener-analytics-engine.git
cd url-shortener-analytics-engine

docker compose up --build
```

| Service | URL |
| ------- | --- |
| Dashboard | http://localhost:5173 |
| API | http://localhost:8000 |
| Health | http://localhost:8000/api/health |

This starts PostgreSQL, Redis, the backend and the Nginx-served frontend. Nginx proxies both `/api/*` and short-code redirects to the backend, so short links work on the same origin.

### Option 2 — Local development (no external services)

```bash
# Terminal 1 — API (JSON store + in-memory cache)
cd backend
cp .env.example .env        # optional
npm install
npm run dev                 # http://localhost:8000

# Terminal 2 — dashboard
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

The backend logs the active engines on boot:

```text
[app] Using JSON file storage (fallback).
[cache] Using in-memory cache with TTL = 300s
[app] Listening on http://localhost:8000
```

To use PostgreSQL/Redis locally, set `DATABASE_URL` and `REDIS_URL` in `backend/.env`:

```env
DATABASE_URL=postgresql://shortuser:shortpass@localhost:5432/urlshortener
REDIS_URL=redis://localhost:6379
```

Tables are created automatically on startup.

---

## Environment Variables

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT` | `8000` | HTTP port for the API |
| `NODE_ENV` | `development` | Runtime environment |
| `DATABASE_URL` | _(unset)_ | PostgreSQL connection string; unset ⇒ JSON file store |
| `REDIS_URL` | _(unset)_ | Redis connection string; unset ⇒ in-memory cache |
| `CORS_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated allowed origins (`*` allows all) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |
| `RATE_LIMIT_MAX` | `30` | Max URL-creation requests per window per IP |
| `DATA_FILE` | `backend/data/store.json` | Override the JSON store path |
| `VITE_API_URL` | `http://localhost:8000` | Frontend API base URL (empty ⇒ same origin) |

---

## API Reference

Base URL: `http://localhost:8000`

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `GET` | `/api/health` | Service status, storage/cache mode, hit ratio, rate-limit config |
| `POST` | `/api/urls` | Create a short URL |
| `GET` | `/api/urls` | List all links with click counts and expiry |
| `GET` | `/api/urls/:shortCode/analytics` | Click time-series and breakdowns |
| `DELETE` | `/api/urls/:shortCode` | Delete a link and invalidate its cache entry |
| `GET` | `/:shortCode` | Redirect (`302`) to the original URL |

### Create a short URL

```bash
curl -X POST http://localhost:8000/api/urls \
  -H "Content-Type: application/json" \
  -d '{
    "originalUrl": "https://www.example.com/a/very/long/path",
    "customAlias": "launch-2026",
    "expiresInHours": 24
  }'
```

```json
{
  "shortCode": "launch-2026",
  "shortUrl": "http://localhost:8000/launch-2026",
  "originalUrl": "https://www.example.com/a/very/long/path",
  "customAlias": "launch-2026",
  "expiresAt": "2026-11-20T10:00:00.000Z",
  "message": "URL shortened successfully"
}
```

`customAlias` and `expiresInHours` are optional. Omitting the alias generates a random 7-character Base62 code. Invalid URLs return `400`; duplicate aliases return `409`.

### Follow a short link

```bash
curl -i http://localhost:8000/launch-2026
```

```http
HTTP/1.1 302 Found
X-Cache: HIT
Location: https://www.example.com/a/very/long/path
```

### Analytics

```bash
curl http://localhost:8000/api/urls/launch-2026/analytics
```

```json
{
  "shortCode": "launch-2026",
  "originalUrl": "https://www.example.com/a/very/long/path",
  "totalClicks": 42,
  "clicksByDay": [{ "date": "2026-11-19", "clicks": 42 }],
  "clicksByHour": [{ "timestamp": "2026-11-19T10:00", "clicks": 27 }],
  "browserBreakdown": { "Chrome 131": 30, "Firefox 133": 12 },
  "osBreakdown": { "Windows": 24, "Linux": 18 },
  "deviceBreakdown": { "Desktop": 38, "Mobile": 4 }
}
```

### Health

```bash
curl http://localhost:8000/api/health
```

```json
{
  "status": "ok",
  "uptimeSeconds": 128,
  "storageMode": "postgresql",
  "cacheMode": "redis",
  "cacheHits": 1840,
  "cacheMisses": 60,
  "cacheHitRatio": "96.84",
  "rateLimit": { "windowMs": 60000, "max": 30 }
}
```

### Error responses

| Status | Meaning |
| ------ | ------- |
| `400` | Missing/invalid `originalUrl`, bad alias, or invalid `expiresInHours` |
| `404` | Unknown short code |
| `409` | Custom alias already in use |
| `410` | Link has expired |
| `429` | Rate limit exceeded (see `Retry-After`) |

---

## How It Works

### Cache-aside redirects

- Creating a link warms `url:<code>` immediately, so the first redirect is a `HIT`.
- Cache entries use a 300-second TTL and are invalidated on delete.
- Redis errors degrade to the in-memory cache instead of failing the request.

### Sliding-window rate limiter

Each IP keeps a list of request timestamps. Timestamps outside the window are discarded, and requests beyond the limit receive `429` with `Retry-After`, `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers. The limiter applies only to `POST /api/urls`, keeping redirects unlimited.

### Analytics aggregation

Every redirect records a click with its parsed browser, OS and device. In JSON mode the aggregates live on the URL record (`byDay`, `byHour`, `browsers`, `os`, `devices`); in PostgreSQL mode they are stored in `click_events` and aggregated with `date_trunc` queries. The dashboard polls `/api/health` every 15 seconds for live cache metrics.

---

## Testing

```bash
cd backend
npm test
```

The suite uses Jest + Supertest against an isolated temporary JSON store and covers:

1. Health endpoint and reported modes.
2. Short URL creation with a custom alias.
3. URL validation and duplicate-alias rejection.
4. Redirects with `X-Cache: HIT/MISS` transitions and `404` handling.
5. Analytics aggregation after clicks.
6. Rate limiting (`429` after the configured maximum).

```bash
cd frontend
npm run build      # production bundle sanity check
```

---

## CI/CD

A ready-to-use GitHub Actions workflow is included at [`docs/ci.yml.example`](docs/ci.yml.example). To enable it, copy it into your repository's workflow directory:

```bash
mkdir -p .github/workflows
cp docs/ci.yml.example .github/workflows/ci.yml
```

It runs on every push and pull request to `main`/`master`:

- **Backend tests** — `npm ci` + Jest suite (no external services required).
- **Frontend build** — `npm ci` + `vite build`.
- **Compose validation** — `docker compose config`.

---

## Design Notes

- **No native dependencies.** Storage uses `pg`, caching uses `ioredis`, and the JSON fallback uses `fs` — so `npm install` works on Linux, macOS and Windows without a compiler toolchain.
- **Fail soft.** Redis connection failures fall back to memory; a missing `DATABASE_URL` falls back to the file store.
- **Collision-safe codes.** Random 7-character Base62 codes are checked for uniqueness before insert, and custom aliases are validated and uniqueness-checked.
- **Single source of truth.** Route handlers are async-wrapped so rejected promises reach the global error handler instead of hanging requests.

---

## License

Released under the [MIT License](LICENSE).

/**
 * URL Shortener & Real-Time Analytics Engine — dashboard.
 *
 * Hero shortener form, live service KPIs, per-link analytics and a managed
 * links table. Talks to the Express API over REST.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Check,
  Copy,
  Database,
  ExternalLink,
  Gauge,
  Link2,
  Loader2,
  Trash2,
  X,
} from "lucide-react";

const API_BASE = (import.meta.env.VITE_API_URL ?? "http://localhost:8000").replace(/\/$/, "");
const PIE_COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#06b6d4"];
const CHART_TOOLTIP = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  color: "#111827",
};

const EXPIRY_OPTIONS = [
  { label: "Never expires", value: "Never" },
  { label: "1 hour", value: "1" },
  { label: "24 hours", value: "24" },
  { label: "7 days", value: "168" },
];

function shortUrlFor(code) {
  return API_BASE ? `${API_BASE}/${code}` : `/${code}`;
}

function truncate(value, max) {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function breakdownToArray(breakdown) {
  return Object.entries(breakdown || {})
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

export default function App() {
  const [links, setLinks] = useState([]);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState("");
  const [loadingLinks, setLoadingLinks] = useState(true);

  const [originalUrl, setOriginalUrl] = useState("");
  const [customAlias, setCustomAlias] = useState("");
  const [expiresInHours, setExpiresInHours] = useState("Never");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState("");

  const [analyticsFor, setAnalyticsFor] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  const totalClicks = useMemo(
    () => links.reduce((sum, link) => sum + (link.clickCount || 0), 0),
    [links]
  );

  const fetchLinks = useCallback(async () => {
    try {
      const { data } = await fetchJson("/api/urls");
      setLinks(data);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingLinks(false);
    }
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const { data } = await fetchJson("/api/health");
      setHealth(data);
    } catch {
      /* health is best-effort */
    }
  }, []);

  useEffect(() => {
    fetchLinks();
    fetchHealth();
    const timer = setInterval(fetchHealth, 15000);
    return () => clearInterval(timer);
  }, [fetchLinks, fetchHealth]);

  async function fetchJson(path, options) {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return { data, response };
  }

  async function handleCreate(event) {
    event.preventDefault();
    if (!originalUrl.trim() || creating) return;

    setCreating(true);
    setError("");
    setCreated(null);

    try {
      const { data } = await fetchJson("/api/urls", {
        method: "POST",
        body: JSON.stringify({
          originalUrl: originalUrl.trim(),
          customAlias: customAlias.trim() || undefined,
          expiresInHours: expiresInHours === "Never" ? undefined : Number(expiresInHours),
        }),
      });
      setCreated(data);
      setOriginalUrl("");
      setCustomAlias("");
      setExpiresInHours("Never");
      await fetchLinks();
      await fetchHealth();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(shortCode) {
    if (!window.confirm(`Delete /${shortCode}?`)) return;
    try {
      await fetchJson(`/api/urls/${shortCode}`, { method: "DELETE" });
      if (analyticsFor === shortCode) {
        setAnalyticsFor(null);
        setAnalytics(null);
      }
      await fetchLinks();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleOpenAnalytics(shortCode) {
    setAnalyticsFor(shortCode);
    setAnalytics(null);
    setAnalyticsLoading(true);
    try {
      const { data } = await fetchJson(`/api/urls/${shortCode}/analytics`);
      setAnalytics(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setAnalyticsLoading(false);
    }
  }

  async function handleCopy(value) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement("input");
      input.value = value;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
    }
    setCopied(value);
    setTimeout(() => setCopied(""), 1500);
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <span className="rounded-lg bg-blue-600 p-2 text-white">
              <Link2 className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-lg font-semibold leading-tight text-gray-900">URL Shortener</h1>
              <p className="text-xs text-gray-500">Real-time analytics engine</p>
            </div>
          </div>
          <span className="rounded-full border border-gray-300 px-3 py-1 text-xs text-gray-500">
            v1.0.0
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 p-4">
        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Shortener form */}
        <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-base font-semibold text-gray-900">Shorten a URL</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700" htmlFor="originalUrl">
                Original URL
              </label>
              <input
                id="originalUrl"
                type="url"
                required
                value={originalUrl}
                onChange={(event) => setOriginalUrl(event.target.value)}
                placeholder="https://www.example.com/some/long/path"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700" htmlFor="customAlias">
                  Custom alias (optional)
                </label>
                <input
                  id="customAlias"
                  type="text"
                  value={customAlias}
                  onChange={(event) => setCustomAlias(event.target.value)}
                  placeholder="my-custom-link"
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700" htmlFor="expiry">
                  Expiration
                </label>
                <select
                  id="expiry"
                  value={expiresInHours}
                  onChange={(event) => setExpiresInHours(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
                >
                  {EXPIRY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={!originalUrl.trim() || creating}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                  {creating ? "Shortening…" : "Shorten URL"}
                </button>
              </div>
            </div>
          </form>

          {created && (
            <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm font-medium text-emerald-800">Short link created</p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  readOnly
                  value={created.shortUrl}
                  className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-900"
                />
                <button
                  onClick={() => handleCopy(created.shortUrl)}
                  className="flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
                >
                  {copied === created.shortUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied === created.shortUrl ? "Copied" : "Copy"}
                </button>
                <a
                  href={created.shortUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:border-gray-400 hover:text-gray-900"
                >
                  <ExternalLink className="h-4 w-4" /> Open
                </a>
              </div>
            </div>
          )}
        </section>

        {/* KPIs */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard icon={<Link2 className="h-4 w-4" />} label="Total links" value={links.length} />
          <KpiCard icon={<Activity className="h-4 w-4" />} label="Total clicks" value={totalClicks} />
          <KpiCard
            icon={<Gauge className="h-4 w-4" />}
            label="Cache hit ratio"
            value={health ? `${health.cacheHitRatio}%` : "—"}
            accent="text-blue-600"
          />
          <KpiCard
            icon={<Database className="h-4 w-4" />}
            label="Storage / cache"
            value={health ? `${health.storageMode} / ${health.cacheMode}` : "—"}
            small
          />
        </section>

        {/* Analytics */}
        {analyticsFor && (
          <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
                  <BarChart3 className="h-4 w-4 text-blue-600" />
                  Analytics for /{analyticsFor}
                </h2>
                {analytics && (
                  <p className="mt-1 text-xs text-gray-500">
                    {analytics.totalClicks} total clicks · {truncate(analytics.originalUrl, 70)}
                  </p>
                )}
              </div>
              <button
                onClick={() => {
                  setAnalyticsFor(null);
                  setAnalytics(null);
                }}
                className="rounded-lg border border-gray-300 p-2 text-gray-500 hover:text-gray-900"
                aria-label="Close analytics"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {analyticsLoading && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading analytics…
              </div>
            )}

            {analytics && !analyticsLoading && (
              <div className="space-y-6">
                {analytics.clicksByHour.length === 0 ? (
                  <p className="text-sm text-gray-500">
                    No clicks recorded yet. Open the short link to generate data.
                  </p>
                ) : (
                  <div>
                    <h3 className="mb-2 text-sm font-medium text-gray-700">Clicks over time</h3>
                    <div className="h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={analytics.clicksByHour}>
                          <defs>
                            <linearGradient id="clicks" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.5} />
                              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                          <XAxis dataKey="timestamp" tick={{ fontSize: 11, fill: "#6b7280" }} />
                          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#6b7280" }} />
                          <Tooltip contentStyle={CHART_TOOLTIP} />
                          <Area
                            type="monotone"
                            dataKey="clicks"
                            stroke="#3b82f6"
                            strokeWidth={2}
                            fill="url(#clicks)"
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                <div className="grid gap-6 lg:grid-cols-3">
                  <BreakdownPie title="Browsers" data={breakdownToArray(analytics.browserBreakdown)} />
                  <BreakdownBars title="Operating systems" data={breakdownToArray(analytics.osBreakdown)} />
                  <BreakdownBars title="Devices" data={breakdownToArray(analytics.deviceBreakdown)} />
                </div>
              </div>
            )}
          </section>
        )}

        {/* Links table */}
        <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-base font-semibold text-gray-900">Managed links</h2>

          {loadingLinks ? (
            <p className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading links…
            </p>
          ) : links.length === 0 ? (
            <p className="text-sm text-gray-500">No links yet. Create your first short URL above.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wider text-gray-500">
                    <th className="px-2 py-3 font-medium">Short code</th>
                    <th className="px-2 py-3 font-medium">Original URL</th>
                    <th className="px-2 py-3 text-center font-medium">Clicks</th>
                    <th className="px-2 py-3 text-center font-medium">Expiry</th>
                    <th className="px-2 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((link) => (
                    <tr key={link.shortCode} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-2 py-3 font-mono text-blue-600">/{link.shortCode}</td>
                      <td className="max-w-xs px-2 py-3 text-gray-700" title={link.originalUrl}>
                        {truncate(link.originalUrl, 48)}
                      </td>
                      <td className="px-2 py-3 text-center text-gray-900">{link.clickCount || 0}</td>
                      <td className="px-2 py-3 text-center text-gray-500">
                        {link.expiresAt ? `${link.expiresInHours}h left` : "Never"}
                      </td>
                      <td className="px-2 py-3">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            onClick={() => handleCopy(shortUrlFor(link.shortCode))}
                            className="text-gray-400 hover:text-gray-700"
                            title="Copy short link"
                          >
                            {copied === shortUrlFor(link.shortCode) ? (
                              <Check className="h-4 w-4" />
                            ) : (
                              <Copy className="h-4 w-4" />
                            )}
                          </button>
                          <button
                            onClick={() => window.open(shortUrlFor(link.shortCode), "_blank", "noreferrer")}
                            className="text-blue-600 hover:text-blue-500"
                            title="Open short link"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleOpenAnalytics(link.shortCode)}
                            className="text-purple-600 hover:text-purple-500"
                            title="View analytics"
                          >
                            <BarChart3 className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(link.shortCode)}
                            className="text-red-600 hover:text-red-500"
                            title="Delete link"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function KpiCard({ icon, label, value, accent = "text-gray-900", small = false }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-gray-500">
        {icon}
        {label}
      </p>
      <p className={`${small ? "text-sm" : "text-2xl"} font-semibold ${accent}`}>{value}</p>
    </div>
  );
}

function BreakdownPie({ title, data }) {
  if (data.length === 0) {
    return <EmptyBreakdown title={title} />;
  }
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-gray-700">{title}</h3>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" outerRadius={80} label>
              {data.map((entry, index) => (
                <Cell key={entry.name} fill={PIE_COLORS[index % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={CHART_TOOLTIP} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function BreakdownBars({ title, data }) {
  if (data.length === 0) {
    return <EmptyBreakdown title={title} />;
  }
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-gray-700">{title}</h3>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6b7280" }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#6b7280" }} />
            <Tooltip contentStyle={CHART_TOOLTIP} />
            <Bar dataKey="value" fill="#3b82f6" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function EmptyBreakdown({ title }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-gray-700">{title}</h3>
      <p className="text-xs text-gray-400">No data</p>
    </div>
  );
}

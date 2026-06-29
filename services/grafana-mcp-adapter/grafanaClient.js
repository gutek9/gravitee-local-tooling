// Grafana HTTP client: auth + API requests against the Grafana HTTP API.
//
// Auth: a Grafana **service account token** sent as a Bearer token in the
// `Authorization` header. The token is scoped to the permissions granted to the
// service account (use a Viewer role for a read-only adapter). The token MUST
// come from the environment (GRAFANA_TOKEN), never hardcoded.
//
// API reference: https://grafana.com/docs/grafana/latest/developers/http_api/
// Tokens look like `glsa_...`.

export const ENABLED = String(process.env.GRAFANA_ENABLED || "false").toLowerCase() === "true";
// Base URL of the Grafana instance, e.g. https://myorg.grafana.net — the HTTP
// API hangs off `${BASE_URL}/api`. Trailing slashes are stripped.
export const BASE_URL = (process.env.GRAFANA_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.GRAFANA_TOKEN || "";
export const TIMEOUT_SECONDS = Number.parseInt(process.env.GRAFANA_TIMEOUT_SECONDS || "15", 10);

export function log(level, message, fields = {}) {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: "grafana-mcp-adapter",
      message,
      ...fields,
    })}\n`,
  );
}

export function requireEnabled() {
  if (!ENABLED) {
    throw new Error("Grafana is disabled. Set GRAFANA_ENABLED=true in .env and configure GRAFANA_TOKEN.");
  }
}

export function requireConfig() {
  requireEnabled();
  if (!BASE_URL) {
    throw new Error("GRAFANA_BASE_URL is required when GRAFANA_ENABLED=true");
  }
  if (!TOKEN) {
    throw new Error("GRAFANA_TOKEN is required when GRAFANA_ENABLED=true");
  }
}

export function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}` };
}

function buildSearch(params = {}) {
  // Drop undefined/null/empty params so we don't send empty query keys.
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === "") continue;
        search.append(key, String(item));
      }
    } else {
      search.append(key, String(value));
    }
  }
  return search;
}

async function request(method, path, { params = {}, body } = {}) {
  requireConfig();
  const search = buildSearch(params);
  const url = `${BASE_URL}/api${path}${search.size ? `?${search.toString()}` : ""}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_SECONDS * 1000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const bodyText = await res.text();
    let parsed = {};
    try {
      parsed = bodyText ? JSON.parse(bodyText) : {};
    } catch (_err) {
      parsed = { raw: bodyText };
    }
    if (!res.ok) {
      const retryAfter = res.headers.get("retry-after");
      const suffix = retryAfter ? `; retry-after=${retryAfter}` : "";
      throw new Error(`Grafana ${method} ${path} failed with HTTP ${res.status}${suffix}`);
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

export async function grafanaGet(path, params = {}) {
  return request("GET", path, { params });
}

// Some read-only Grafana endpoints are POST (notably /ds/query, which reads
// metrics/logs). The adapter stays read-only: only safe query endpoints use this.
export async function grafanaPost(path, body, params = {}) {
  return request("POST", path, { params, body });
}

// Call a datasource's native API through Grafana's read-only proxy:
//   /api/datasources/proxy/uid/{uid}/<datasourcePath>
// We use this to hit Loki's query_range directly (the typed frames from
// /ds/query are awkward for raw log lines). `dsPath` is the part after the uid,
// e.g. "loki/api/v1/query_range".
export async function grafanaDatasourceProxyGet(uid, dsPath, params = {}) {
  const cleanPath = dsPath.replace(/^\/+/, "");
  return grafanaGet(`/datasources/proxy/uid/${encodeURIComponent(uid)}/${cleanPath}`, params);
}

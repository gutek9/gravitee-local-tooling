// Where the Gravitee Cloud customer map comes from.
//
// Fetched from GitHub at runtime so it is current, with a bundled snapshot as a
// fallback for when GitHub is unreachable. Which source answered is always
// reported: resolving a customer against stale data without saying so is exactly
// the kind of quiet wrongness this adapter exists to avoid.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { log } from "./grafanaClient.js";
import { parseCustomerCsv } from "./customerCsv.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable so tests can point the fallback at a file of their own and never
// read a real local snapshot. Exported so refresh-customers writes where this
// module reads.
export const SNAPSHOT_PATH = process.env.GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH || join(HERE, "customers-snapshot.json");

const REPO = process.env.GRAFANA_CUSTOMER_MAP_REPO || "gravitee-io/cloud-deployments-configuration";
const PATH = process.env.GRAFANA_CUSTOMER_MAP_PATH || "docs/summary/customers_summary.csv";
const REF = process.env.GRAFANA_CUSTOMER_MAP_REF || "prod";
// Customers are added over days, not seconds; an hour of cache is plenty and
// keeps GitHub out of the hot path for a burst of tool calls.
const TTL_MS = Number(process.env.GRAFANA_CUSTOMER_MAP_TTL_SECONDS || 3600) * 1000;
// A log lookup must not hang because GitHub is slow. Fall back fast instead.
const FETCH_TIMEOUT_MS = Number(process.env.GRAFANA_CUSTOMER_MAP_TIMEOUT_MS || 5000);

// A map fetched live can still be months out of date. Report the age rather than
// letting `source: "github"` imply currency.
function staleness(generatedAt) {
  if (!generatedAt) return {};
  const days = Math.floor((Date.now() - Date.parse(generatedAt)) / 86400000);
  if (!Number.isFinite(days)) return {};
  if (days < STALE_AFTER_DAYS) return { generated_days_ago: days };
  return {
    generated_days_ago: days,
    warning:
      `The customer map was last regenerated ${days} days ago (${String(generatedAt).slice(0, 10)}). It is a ` +
      "GENERATED file, so fetching it live does not make it current: deployments created since then are absent " +
      "entirely, and a customer that does not resolve may simply be missing rather than nonexistent. " +
      "Regenerate it by running docs/summary/generate_summary.py in the source repository.",
  };
}

let cache = null;
let cachedAt = 0;
// Concurrent tool calls on a cold cache must not each fetch: they await the same
// request. Without this, a burst of calls at connect time all pay the round trip.
let inFlight = null;

// How old the map may be before it is called out. The summary is a GENERATED
// artifact committed to its repo, so "fetched from GitHub" says nothing about
// when it was last regenerated — and a stale map fails by omission, which is the
// hardest kind of wrong to notice.
const STALE_AFTER_DAYS = Number(process.env.GRAFANA_CUSTOMER_MAP_STALE_DAYS || 30);

// The date the source file was last COMMITTED, i.e. last regenerated. Best-effort:
// a failure here must not stop the map loading.
export async function fetchGeneratedAt(token) {
  try {
    const url =
      `https://api.github.com/repos/${REPO}/commits?path=${encodeURIComponent(PATH)}` +
      `&sha=${encodeURIComponent(REF)}&per_page=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "grafana-mcp-adapter" },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const commits = await res.json();
      return commits?.[0]?.commit?.committer?.date || commits?.[0]?.commit?.author?.date || null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export async function fetchCustomerCsv() {
  const token = (process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("GITHUB_PERSONAL_ACCESS_TOKEN is not set");
  const url = `https://api.github.com/repos/${REPO}/contents/${PATH}?ref=${encodeURIComponent(REF)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.raw",
        "User-Agent": "grafana-mcp-adapter",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// The snapshot records two dates: when the source CSV was last generated
// (committed), which is what freshness is about, and when it was copied here.
// Refreshing an old CSV today must not make the fallback report a map generated
// today.
export function buildSnapshot({ customers, sourceGeneratedAt, refreshedAt = new Date().toISOString().slice(0, 10) }) {
  return {
    source_generated_at: sourceGeneratedAt || null,
    refreshed_at: refreshedAt,
    source: `${REPO}@${REF} ${PATH}`,
    note: "Slimmed deliberately: only what is needed to resolve a customer to a namespace. Customer hostnames and custom DNS are NOT included.",
    customers,
  };
}

// A snapshot written before the two dates were split only has `generated_at`,
// which was the copy date. It is kept as the refresh date and never passed off
// as the CSV's.
//
// A snapshot with no customers is no map at all, the same as a fetched CSV that
// parses to zero rows: taking it would report a fallback map that resolves
// nobody instead of saying the map is unavailable.
async function loadSnapshot() {
  const raw = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
  const rows = Array.isArray(raw.customers) ? raw.customers : [];
  if (!rows.length) throw new Error("bundled snapshot has no customers");
  return {
    rows,
    source_generated_at: raw.source_generated_at || null,
    refreshed_at: raw.refreshed_at || raw.generated_at || null,
  };
}

function describeSnapshotDates(snap, days) {
  const refreshed = `refreshed ${snap.refreshed_at || "unknown"}`;
  if (!snap.source_generated_at) return `source CSV date unknown, ${refreshed}`;
  const ago = days === undefined ? "" : ` (${days} days ago)`;
  return `source CSV generated ${String(snap.source_generated_at).slice(0, 10)}${ago}, ${refreshed}`;
}

// Returns { rows, source, generated_at, warning }. `source` is always reported so
// a caller can tell a live answer from a fallback one.
export async function loadCustomerMap({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  if (!refresh && inFlight) return inFlight;
  inFlight = loadCustomerMapUncached();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function loadCustomerMapUncached() {
  try {
    const rows = parseCustomerCsv(await fetchCustomerCsv());
    if (!rows.length) throw new Error("fetched customer CSV parsed to zero rows");
    const generatedAt = await fetchGeneratedAt((process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "").trim());
    cache = { rows, source: "github", generated_at: generatedAt, ...staleness(generatedAt) };
    cachedAt = Date.now();
    return cache;
  } catch (err) {
    log("warn", "Customer map: GitHub fetch failed, falling back to bundled snapshot", {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      const snap = await loadSnapshot();
      const { generated_days_ago: days } = staleness(snap.source_generated_at);
      cache = {
        rows: snap.rows,
        source: "bundled_snapshot",
        generated_at: snap.source_generated_at,
        ...(days !== undefined ? { generated_days_ago: days } : {}),
        warning:
          `Customer mapping came from the bundled snapshot (${describeSnapshotDates(snap, days)}), ` +
          `because GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}. ` +
          "Customers created or moved since then will not resolve.",
      };
      cachedAt = Date.now();
      return cache;
    } catch (snapErr) {
      // Both sources gone: return an empty map rather than throwing, so the
      // logs tools still work for hosted customers, which need no mapping.
      log("error", "Customer map unavailable from both GitHub and the bundled snapshot", {
        github_error: err instanceof Error ? err.message : String(err),
        snapshot_error: snapErr instanceof Error ? snapErr.message : String(snapErr),
      });
      return {
        rows: [],
        source: "unavailable",
        generated_at: null,
        warning:
          "Customer mapping is unavailable (GitHub unreachable and no usable bundled snapshot), so " +
          "Gravitee Cloud customers cannot be resolved by name. Hosted customers are unaffected.",
      };
    }
  }
}

// Test seam: drop the cache so a test or a refresh can start clean.
export function resetCustomerMapCache() {
  cache = null;
  cachedAt = 0;
  inFlight = null;
}

// Start loading at server startup so the fetch overlaps the MCP handshake rather
// than landing in the middle of someone's first query. Fire-and-forget: a failure
// here is not fatal, the next call falls back to the snapshot as usual.
export function warmCustomerMap() {
  loadCustomerMap().catch(() => {});
}

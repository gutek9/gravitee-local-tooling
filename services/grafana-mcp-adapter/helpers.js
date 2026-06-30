// Pure helpers shared by server.js. Kept in their own module (no MCP/transport
// side effects) so they can be imported and unit-tested directly.
import { BASE_URL } from "./grafanaClient.js";

// The raw /ds/query response is huge (one full timestamp+value array per series,
// and `up` alone can be thousands of series). For MCP use we collapse each series
// to its labels + a numeric digest (count, first/last/min/max/avg). The caller can
// always re-query a narrower expression if it needs the full time arrays.
// TODO(enrique): tune what we keep here once the real use case is pinned down.
export function summarizeQueryResult(payload = {}, { maxSeries = 50 } = {}) {
  const out = { results: {} };
  for (const [refId, res] of Object.entries(payload.results || {})) {
    const frames = Array.isArray(res?.frames) ? res.frames : [];
    const series = [];
    for (const frame of frames) {
      const fields = frame?.schema?.fields || [];
      const valueFieldIdx = fields.findIndex((f) => f?.type === "number");
      const labels = valueFieldIdx >= 0 ? fields[valueFieldIdx]?.labels || {} : {};
      const values = (frame?.data?.values?.[valueFieldIdx] || []).filter((v) => typeof v === "number");
      const count = values.length;
      const digest = count
        ? {
            count,
            first: values[0],
            last: values[count - 1],
            min: Math.min(...values),
            max: Math.max(...values),
            avg: values.reduce((a, b) => a + b, 0) / count,
          }
        : { count: 0 };
      series.push({ labels, ...digest });
    }
    out.results[refId] = {
      status: res?.status ?? null,
      series_count: series.length,
      series: series.slice(0, maxSeries),
      truncated: series.length > maxSeries ? series.length - maxSeries : 0,
    };
  }
  return out;
}

// Escape a free-text fragment for safe use inside a Loki regex matcher.
export function escapeRegex(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Environment tokens that name a deployment stage. These are matched as whole
// `service_name` segments, not substrings, so "prod" doesn't also match the
// "prod" inside `nonprod`/`preprod` (a real source of false positives). Any word
// not in this set stays a plain substring (so partial customer names like
// "arcelor" still match "arcelor-mittal").
const ENV_TOKENS = new Set([
  "prod",
  "nonprod",
  "preprod",
  "rec",
  "dev",
  "int",
  "ppr",
  "sandbox",
  "val",
  "qc",
  "qa",
  "test",
  "demo",
  "stage",
  "uat",
  "plt",
]);

// Segment boundary in `service_name` (dash/underscore/dot, or start/end). Used to
// anchor an env token so it matches a whole segment, e.g. `prod` -> `prod-` /
// `-prod-` / `-prod` but not the `prod` inside `nonprod`.
const SEG_START = "(?:^|[-_.])";
const SEG_END = "(?:[-_.]|$)";

// Build a LogQL selector from free-text client/component. Both are matched
// case-insensitively as substrings of `service_name` (which in this instance
// encodes both the customer and the component, e.g.
// `graviteeio-ae-april-rec-engine`, `dev-apim-cloudgate-1ca08d-gateway`).
// `lineFilter` becomes a `|= "..."` line filter on top.
export function buildLogsQuery({ client, component, lineFilter } = {}) {
  if (!client) throw new Error("client is required");
  // Whitespace inside a fragment means "these words, in order, with anything in
  // between" — `service_name` is dash-separated, so a literal space would never
  // match (e.g. "april prod" must become `april.*prod`, not `april prod`). Split
  // each fragment on whitespace; known env words are anchored to a whole segment,
  // everything else stays a plain (escaped) substring, joined with `.*`.
  const toWord = (w) =>
    ENV_TOKENS.has(w.toLowerCase()) ? `${SEG_START}${escapeRegex(w)}${SEG_END}` : escapeRegex(w);
  const toPattern = (s) =>
    String(s)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(toWord)
      .join(".*");
  const parts = [toPattern(client)].filter(Boolean);
  if (component) {
    const c = toPattern(component);
    if (c) parts.push(c);
  }
  // (?i) = case-insensitive; .* between parts so order/extra segments are fine.
  const selector = `{service_name=~"(?i).*${parts.join(".*")}.*"}`;
  return lineFilter ? `${selector} |= \`${lineFilter.replace(/`/g, "")}\`` : selector;
}

// Build a permanent Grafana Explore deep link for a Loki query + time range.
// Grafana 11+ (this instance is 13.x) reads a `panes` param: an object keyed by
// an arbitrary pane id, each holding the datasource, queries and range. The old
// `left=` array form is legacy (<=10) and is intentionally not emitted.
export function buildExploreUrl({ datasourceUid, query, from, to }) {
  const pane = {
    datasource: datasourceUid,
    queries: [{ refId: "A", datasource: { type: "loki", uid: datasourceUid }, expr: query, queryType: "range" }],
    range: { from, to },
  };
  const panes = encodeURIComponent(JSON.stringify({ logs: pane }));
  return `${BASE_URL}/explore?schemaVersion=1&orgId=1&panes=${panes}`;
}

// Build a deep link into the Grafana Logs Drilldown app (plugin
// `grafana-lokiexplore-app`, the "Logs" menu) instead of raw Explore. The app
// navigates per-namespace (`/explore/namespace/{ns}/logs`) and filters by
// individual labels via repeated `var-filters` (`label|operator|value`). We pin
// the namespace and add a `service_name` filter built from the EXACT service
// names matched in that namespace, so the user lands already scoped, then drills
// down by hand in the UI. Params mirror a link produced by the app itself.
//
// Note: this app does NOT evaluate a raw LogQL regex like `(?i).*x.*` in a
// filter value — it treats it as a literal and matches nothing. So we pass exact
// service_name values: one `=` filter for a single value, or a `=~` alternation
// (`a|b`, values regex-escaped) for several.
// The Logs Drilldown app stores committed line filters in the `var-lineFilters`
// ad-hoc variable as `key|operator|value`, NOT as the LogQL `|= "..."`. The app
// escapes the structural delimiters inside each part — `|` -> `__gfp__` and
// `,` -> `__gfc__` — because it uses `|` to separate parts and `,` to separate
// filters/labels (see grafana/logs-drilldown src/services/extensions/links.ts).
//   key      = `caseSensitive,<index>` (or `caseInsensitive` for a `(?i)` regex)
//   operator = the LogQL line-filter op with its pipe escaped: `|=` -> `__gfp__=`
//   value    = the raw substring, delimiters escaped
// We emit a single case-sensitive `|=` (contains) filter at index 0. Returning
// the literal `caseSensitive,0,match,<text>` form (a guess) leaves the field
// empty — this is the format the app itself round-trips.
const GFP = (s) => String(s).replace(/\|/g, "__gfp__").replace(/,/g, "__gfc__");
export function buildLineFilterToken(text) {
  if (!text) return "";
  // key | operator(`|=`) | value, each part delimiter-escaped.
  return `caseSensitive,0|${GFP("|=")}|${GFP(text)}`;
}

export function buildDrilldownUrl({ namespace, serviceNames = [], datasourceUid = "grafanacloud-logs", from, to, lineFilter } = {}) {
  if (!namespace) throw new Error("namespace is required");
  const names = [...new Set((serviceNames || []).filter(Boolean))];
  const p = new URLSearchParams();
  p.set("patterns", "[]");
  p.set("from", from);
  p.set("to", to);
  p.set("var-lineFormat", "");
  p.set("var-ds", datasourceUid);
  // First filter pins the namespace (matches the route). `|=|` is an exact match.
  p.append("var-filters", `namespace|=|${namespace}`);
  // Exact service_name match: `=` for one value, `=~` alternation for several.
  if (names.length === 1) {
    p.append("var-filters", `service_name|=|${names[0]}`);
  } else if (names.length > 1) {
    p.append("var-filters", `service_name|=~|${names.map(escapeRegex).join("|")}`);
  }
  for (const k of [
    "var-fields",
    "var-levels",
    "var-metadata",
    "var-jsonFields",
    "var-patterns",
    "var-lineFilterV2",
    "var-lineFilters",
    "var-all-fields",
  ]) {
    p.set(k, "");
  }
  // Apply the line filter to the committed filters var. The in-progress single
  // filter (`var-lineFilterV2`) stays empty — that's what the app's own deep
  // links do; committed filters live in `var-lineFilters`.
  if (lineFilter) p.set("var-lineFilters", buildLineFilterToken(lineFilter));
  p.set("timezone", "browser");
  p.set("urlColumns", "[]");
  p.set("visualizationType", '"logs"');
  p.set("displayedFields", "[]");
  p.set("userDisplayedFields", "false");
  p.set("sortOrder", '"Descending"');
  p.set("wrapLogMessage", "false");
  p.set("prettifyLogMessage", "false");
  return `${BASE_URL}/a/grafana-lokiexplore-app/explore/namespace/${encodeURIComponent(namespace)}/logs?${p.toString()}`;
}

// Resolve Grafana-style relative ranges ("now-15m") to ns epoch for Loki's
// query_range. Absolute epoch-ms strings/numbers pass through. Loki wants ns.
export function toLokiNs(value, fallbackSecondsAgo, now = Date.now()) {
  if (value === undefined || value === null || value === "") return `${(now - fallbackSecondsAgo * 1000) * 1e6}`;
  const m = /^now(?:-(\d+)([smhd]))?$/.exec(String(value).trim());
  if (m) {
    if (!m[1]) return `${now * 1e6}`;
    const n = Number(m[1]);
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
    return `${(now - n * unit) * 1e6}`;
  }
  // Assume epoch ms.
  const ms = Number(value);
  return Number.isFinite(ms) ? `${ms * 1e6}` : `${(now - fallbackSecondsAgo * 1000) * 1e6}`;
}

// Classic Levenshtein edit distance (small strings; fine for label matching).
export function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

// Rank candidate service_name values against a free-text needle: substring
// containment first, then best (lowest) edit distance to any dash/underscore/dot
// segment. Pulled out of suggestClients so the ranking is testable without Loki.
export function rankClientSuggestions(values = [], client = "") {
  const needle = String(client || "").toLowerCase();
  if (!needle) return [];
  const scored = values
    .map((v) => {
      const lv = v.toLowerCase();
      const segments = lv.split(/[-_.]/).filter(Boolean);
      const contains = lv.includes(needle);
      const bestDist = Math.min(...segments.map((seg) => editDistance(needle, seg)), needle.length);
      return { v, contains, bestDist };
    })
    // Keep substring hits, or close typos (edit distance <= ~1/3 of the word).
    .filter((x) => x.contains || x.bestDist <= Math.max(1, Math.ceil(needle.length / 3)))
    .sort((a, b) => Number(b.contains) - Number(a.contains) || a.bestDist - b.bestDist);
  return [...new Set(scored.map((x) => x.v))].slice(0, 10);
}

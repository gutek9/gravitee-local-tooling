// Pure helpers shared by server.js. Kept in their own module (no MCP/transport
// side effects) so they can be imported and unit-tested directly.
import { BASE_URL } from "./grafanaClient.js";

// Loki log responses arrive as a `LabeledTimeValues` frame: one row per log
// line, with fields `labels` (object), `Time` (epoch ms), `Line` (string),
// `tsNs`, `labelTypes` and `id`. NONE of those is a `number` field, so the
// numeric digest below skips every one of them — a log query that matched
// thousands of lines would report `series_count: 0`, a false "no results" that
// reads as authoritative. Log frames therefore get their own digest.
const LOG_FRAME_TYPE = "LabeledTimeValues";

function findField(fields, name, type) {
  return fields.findIndex((f) => f?.name === name && (!type || f?.type === type));
}

// A frame is a log frame if Grafana stamped it as such, or — defensively, in
// case that meta is absent — if it carries the `Line` string field that makes
// it one.
export function isLogFrame(frame) {
  if (frame?.schema?.meta?.custom?.frameType === LOG_FRAME_TYPE) return true;
  return findField(frame?.schema?.fields || [], "Line", "string") !== -1;
}

// Loki reports per-query counters in `meta.stats` as a flat list of
// {displayName, value}. `total lines processed` is how many lines Loki read to
// answer the query; it is NOT the number of matches, so it must never be shown
// as a result count. We surface it only as context alongside the real count.
function frameStats(frame) {
  const stats = frame?.schema?.meta?.stats;
  if (!Array.isArray(stats)) return {};
  const value = (name) => stats.find((s) => s?.displayName === name)?.value;
  const out = {
    lines_processed: value("Summary: total lines processed"),
    bytes_processed: value("Summary: total bytes processed"),
    exec_time_seconds: value("Summary: exec time"),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Collapse log frames to a digest: how many lines matched, over what window,
// from which streams, plus a capped sample of the lines themselves. `limit` is
// the line cap that was requested of Loki — when the returned count reaches it
// the result is partial, and we say so rather than letting the caller read a
// capped page as the whole story.
// Loki returns an empty result for several different reasons, and the raw API
// gives no way to tell them apart — so "no matching logs" gets reported when the
// truth is "I looked in the wrong place". `total bytes processed` separates them:
// zero means the selector matched no stream at all, so nothing was ever scanned.
//   NO_DATA_SCANNED    - looked nowhere. Wrong namespace/selector or window.
//   TRUNCATED          - hit the cap; older matches were never returned.
//   EMPTY_BUT_SCANNED  - a trustworthy negative for this filter and window.
//   OK                 - results, within the cap.
//   EMPTY_BUT_SAMPLED  - scanned and empty, but Adaptive Logs discards lines
//                        before Loki sees them. NOT proof a specific line was
//                        never written.
export function coverageVerdict({ lineCount, bytesProcessed, limitReached, sampled = false }) {
  if (limitReached) return "TRUNCATED";
  if (bytesProcessed === 0) return "NO_DATA_SCANNED";
  if (lineCount === 0) {
    if (bytesProcessed === undefined) return "UNKNOWN";
    return sampled ? "EMPTY_BUT_SAMPLED" : "EMPTY_BUT_SCANNED";
  }
  return "OK";
}

function summarizeLogFrames(frames, { maxStreams, maxSampleLines, maxLineChars, limit, window }) {
  const streams = new Map();
  // shape -> { time, line, occurrences }, insertion-ordered, so the example kept
  // is the first (most recent) occurrence of each kind.
  const sampleShapes = new Map();
  const stats = {};
  let lineCount = 0;
  let earliest = null;
  let latest = null;

  for (const frame of frames) {
    const fields = frame?.schema?.fields || [];
    const values = frame?.data?.values || [];
    const lines = values[findField(fields, "Line", "string")] || [];
    const times = values[findField(fields, "Time", "time")] || [];
    const labelSets = values[findField(fields, "labels")] || [];
    Object.assign(stats, frameStats(frame));

    for (let i = 0; i < lines.length; i++) {
      lineCount++;

      const t = Number(times[i]);
      if (Number.isFinite(t)) {
        if (earliest === null || t < earliest) earliest = t;
        if (latest === null || t > latest) latest = t;
      }

      // Group by distinct label set so the caller sees which streams produced
      // the lines (a namespace usually spans several pods/containers).
      const labels = labelSets[i] && typeof labelSets[i] === "object" ? labelSets[i] : {};
      const key = JSON.stringify(Object.entries(labels).sort());
      const entry = streams.get(key);
      if (entry) entry.lines++;
      else streams.set(key, { labels, lines: 1 });

      // Sample by DISTINCT KIND, not by position. Taking the first N lines
      // routinely returned N byte-identical copies of one message — five copies
      // of the same exception says no more than one, while costing five times
      // the customer log content. Grouping by shape shows what KINDS of line are
      // present with a count each, which is strictly more information in less
      // text. The example keeps its own timestamp so it can be handed to
      // grafana_logs_context.
      if (typeof lines[i] === "string") {
        const shape = normaliseLogLine(lines[i]);
        const seen = sampleShapes.get(shape);
        if (seen) {
          seen.occurrences++;
        } else {
          const line = lines[i];
          sampleShapes.set(shape, {
            time: Number.isFinite(t) ? new Date(t).toISOString() : null,
            line: line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…[truncated]` : line,
            occurrences: 1,
          });
        }
      }
    }
  }

  const all = [...streams.values()].sort((a, b) => b.lines - a.lines);
  const kinds = [...sampleShapes.values()].sort((a, b) => b.occurrences - a.occurrences);
  const digest = {
    frame_type: "logs",
    line_count: lineCount,
    time_range: { from: iso(earliest), to: iso(latest) },
    stream_count: all.length,
    streams: all.slice(0, maxStreams),
    streams_truncated: all.length > maxStreams ? all.length - maxStreams : 0,
    // Distinct kinds of line, commonest first, each with how many times it
    // occurred among the lines returned.
    sample_lines: kinds.slice(0, maxSampleLines),
    distinct_line_kinds: kinds.length,
    sample_kinds_truncated: kinds.length > maxSampleLines ? kinds.length - maxSampleLines : 0,
  };
  // Computed over ALL streams, not the reported slice — a sampled stream that
  // fell outside maxStreams is still dropping lines from the counts above.
  const sampling = detectSampling(all);
  if (sampling) digest.adaptive_logs_sampling = sampling;
  if (Object.keys(stats).length) digest.stats = stats;

  const limitReached = Number.isFinite(limit) && lineCount >= limit;
  if (limitReached) {
    digest.limit_reached = true;
    digest.note =
      `Returned ${lineCount} lines, the maximum requested — more lines almost certainly match. ` +
      `Raise max_lines, narrow the time range, or aggregate with count_over_time for a true total.`;

    // Loki fills the cap walking BACKWARDS from the end of the window, so hitting
    // it means the oldest part of the requested range was never looked at. A
    // 1-hour request can return only its last minute, and nothing in the response
    // says so — absence in the unseen part then reads as a finding.
    if (window && earliest !== null && latest !== null) {
      const coveredSeconds = Math.max(0, Math.round((latest - earliest) / 1000));
      const requestedSeconds = Math.max(0, Math.round((window.end_ms - window.start_ms) / 1000));
      digest.covered_window = {
        from: new Date(earliest).toISOString(),
        to: new Date(latest).toISOString(),
        covered_seconds: coveredSeconds,
        requested_seconds: requestedSeconds,
      };
      if (requestedSeconds > 0 && coveredSeconds < requestedSeconds * 0.9) {
        digest.covered_window.warning =
          `These ${lineCount} lines span only ${coveredSeconds}s of the ${requestedSeconds}s requested. ` +
          "Loki fills the cap from the END of the window backwards, so the earlier part of the range was " +
          "never returned — do NOT read an absence here as evidence it did not happen earlier in the window.";
      }
    }
  }

  digest.coverage = coverageVerdict({
    lineCount,
    bytesProcessed: stats.bytes_processed,
    limitReached,
  });
  if (digest.coverage === "NO_DATA_SCANNED") {
    digest.coverage_warning =
      "Loki scanned ZERO bytes: the selector matched no stream at all in this window, so this is not a " +
      "statement about whether the event happened. Check the namespace/labels (grafana_find_customer) and " +
      "the time range before concluding anything.";
  } else if (digest.coverage === "EMPTY_BUT_SCANNED") {
    digest.coverage_note =
      `No matching lines, but Loki scanned ${stats.bytes_processed} bytes — the streams exist and were ` +
      "searched, so this is a trustworthy negative for this filter and window.";
  }
  return digest;
}

// Not every datasource returns timeseries or logs — Elasticsearch raw_data returns
// documents, and other types return tables. Such frames still carry number fields
// (response times, durations), so the numeric path would happily digest them into
// a "series" that means nothing — the same class of silent wrongness as
// reporting 0 for a log frame. Anything not recognised gets a table digest
// instead: row count, the columns and their types, and a small sample. An
// unhandled shape is then visible rather than silently misreported.
function summarizeTableFrames(frames, { maxSampleRows, maxCellChars }) {
  let rowCount = 0;
  const columns = [];
  const sample = [];

  for (const frame of frames) {
    const fields = frame?.schema?.fields || [];
    const values = frame?.data?.values || [];
    const rows = values[0]?.length ?? 0;
    rowCount += rows;
    for (const f of fields) {
      if (!columns.some((c) => c.name === f?.name)) columns.push({ name: f?.name ?? null, type: f?.type ?? null });
    }
    for (let i = 0; i < rows && sample.length < maxSampleRows; i++) {
      const row = {};
      for (let c = 0; c < fields.length; c++) {
        const name = fields[c]?.name;
        if (!name) continue;
        const v = values[c]?.[i];
        // Objects (Tempo's `nested`, ES `_type`) are summarised, not inlined —
        // they can be arbitrarily large.
        if (v && typeof v === "object") {
          row[name] = Array.isArray(v) ? `[${v.length} items]` : "{object}";
        } else if (typeof v === "string" && v.length > maxCellChars) {
          row[name] = `${v.slice(0, maxCellChars)}\u2026[truncated]`;
        } else {
          row[name] = v ?? null;
        }
      }
      sample.push(row);
    }
  }

  return {
    frame_type: "table",
    row_count: rowCount,
    columns,
    sample_rows: sample,
    // Distinct from the log digest's sample_truncated so a result carrying both
    // kinds of frame does not clobber one with the other.
    sample_rows_truncated: rowCount > sample.length ? rowCount - sample.length : 0,
  };
}

// Decide how to digest a frame, from the signals Grafana actually sets (verified
// against this instance):
//   Loki logs        -> meta.custom.frameType = "LabeledTimeValues"
//   Prometheus       -> meta.type = "timeseries-multi", fields Time + number(labels)
//   Loki metrics     -> meta.type = "timeseries-multi"
//   Elasticsearch agg-> meta.type = "timeseries-multi", fields Time + Value
//   Elasticsearch raw-> no meta, many string columns
//   table-shaped     -> preferredVisualisationType = "table", string + number columns
// A string field is the discriminator for the last two: a timeseries frame has a
// time axis and numbers, never string columns.
export function classifyFrame(frame) {
  if (isLogFrame(frame)) return "logs";
  const meta = frame?.schema?.meta || {};
  if (typeof meta.type === "string" && meta.type.startsWith("timeseries")) return "timeseries";
  const fields = frame?.schema?.fields || [];
  if (fields.some((f) => f?.type === "string")) return "table";
  // A frame with no time axis is not a series over time, whatever its column
  // types. Elasticsearch terms aggregations return exactly this: `status` +
  // `Count`, both numeric. Digesting those as series produces min/max/avg OF
  // HTTP STATUS CODES — arithmetic on identifiers, presented as a measurement.
  if (!fields.some((f) => f?.type === "time")) return "table";
  return "timeseries";
}

// The raw /ds/query response is huge (one full timestamp+value array per series,
// and `up` alone can be thousands of series). For MCP use we collapse each
// numeric series to its labels + a digest (count, first/last/min/max/avg), and
// each set of log frames to a line-count/stream/sample digest. The caller can
// always re-query a narrower expression if it needs the full arrays.
export function summarizeQueryResult(
  payload = {},
  { maxSeries = 50, maxSampleLines = 5, maxLineChars = 500, maxSampleRows = 5, maxCellChars = 200, limit, window } = {},
) {
  const out = { results: {} };
  for (const [refId, res] of Object.entries(payload.results || {})) {
    const frames = Array.isArray(res?.frames) ? res.frames : [];
    const logFrames = [];
    const tableFrames = [];
    const seriesFrames = [];
    for (const frame of frames) {
      const kind = classifyFrame(frame);
      if (kind === "logs") logFrames.push(frame);
      else if (kind === "table") tableFrames.push(frame);
      else seriesFrames.push(frame);
    }
    const series = [];

    // Numeric path: wide-format frames -> { "field1": [v1, v2], ... }. Only
    // `number` fields carry series values; time/string/other fields are the
    // axis and metadata. Log frames are excluded — they have no number field
    // and are digested separately below.
    for (const frame of seriesFrames) {
      const fields = frame?.schema?.fields || [];
      for (let idx = 0; idx < fields.length; idx++) {
        if (fields[idx]?.type !== "number") continue;
        const labels = fields[idx]?.labels || {};
        const values = (frame?.data?.values?.[idx] || []).filter((v) => typeof v === "number");
        const count = values.length;
        // Computed in one pass rather than Math.min/max(...values): a wide
        // query can return 100k+ points and spreading that many args throws.
        let min = values[0];
        let max = values[0];
        let sum = 0;
        for (const v of values) {
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
        }
        const digest = count
          ? { count, first: values[0], last: values[count - 1], min, max, avg: sum / count }
          : { count: 0 };
        series.push({ labels, ...digest });
      }
    }

    const entry = { status: res?.status ?? null };

    if (logFrames.length) {
      Object.assign(
        entry,
        summarizeLogFrames(logFrames, { maxStreams: maxSeries, maxSampleLines, maxLineChars, limit, window }),
      );
    }

    if (tableFrames.length) {
      Object.assign(entry, summarizeTableFrames(tableFrames, { maxSampleRows, maxCellChars }));
      // Both digests claim frame_type; say so rather than let one win silently.
      if (logFrames.length) entry.frame_type = "logs+table";
    }

    // Emit the numeric keys only when there is a numeric result to describe. On a
    // pure log/table result `series_count: 0` sits next to a real count and reads
    // as "nothing found" — the same misleading zero this digest exists to remove.
    // A query producing several kinds of frame keeps each digest.
    if ((!logFrames.length && !tableFrames.length) || series.length) {
      entry.series_count = series.length;
      entry.series = series.slice(0, maxSeries);
      entry.truncated = series.length > maxSeries ? series.length - maxSeries : 0;
    }

    out.results[refId] = entry;
  }
  return out;
}

// The Loki datasource uid has no safe default. Hardcoding one that happens to be
// right for a single Grafana org is worse than having none: it fails silently
// and plausibly everywhere else. Validated here so the failure is one clear
// message rather than an empty result set.
export function requireDatasourceUid(uid) {
  const value = String(uid ?? "").trim();
  if (!value) {
    throw new Error(
      "GRAFANA_LOGS_DATASOURCE_UID is not set. Set it to the uid of the Loki datasource " +
        "holding your logs (Grafana > Connections > Data sources; the uid is in the page " +
        "URL and is not always the same as the display name), then recreate the container: " +
        "docker compose up -d --force-recreate grafana-mcp-adapter",
    );
  }
  return value;
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

// Split a free-text client fragment into the customer "core" (the words that
// name the customer) and the env tokens (prod, stage, ...). The customer core
// is what we match against the `namespace` label — env tokens don't reliably
// live in the namespace (e.g. a customer whose prod namespace is `…-plt-live`),
// so they only ever narrow `service_name`, never the namespace.
//   splitClientEnv("blueyonder prod") -> { core: "blueyonder", envs: ["prod"] }
//   splitClientEnv("equigy")          -> { core: "equigy",     envs: [] }
export function splitClientEnv(client = "") {
  const words = String(client || "").trim().split(/\s+/).filter(Boolean);
  const core = [];
  const envs = [];
  for (const w of words) (ENV_TOKENS.has(w.toLowerCase()) ? envs : core).push(w);
  return { core: core.join(" "), envs };
}

// From the full list of `namespace` label values, pick the ones the phrase names.
//
// Tried in three tiers, most specific first — measured against every live hosted
// customer (296 namespaces), asking for each by its own name plus environment:
//
//   whole name   `orbit plt live` -> `orbit-plt-live`   exact 296
//   segments     every word is a whole `-` segment                exact 270
//   substring    every word appears anywhere                      exact 245
//
// The tiers matter because customers' names nest: `orbit-plt-live` is a
// prefix of `orbit-plt-live-ap`, and namespaces exist that are called just
// `prod` or `dev`. Substring alone returns the siblings too; whole-name first
// returns the one that was asked for, and falls through when the phrase names a
// customer rather than a deployment (`acme` -> all five of acme's namespaces).
//
// No environment word list is involved: the phrase is matched as typed, and what
// the caller meant by the last word is decided by what exists.
export function matchNamespaces(namespaceValues = [], phrase = "") {
  const words = String(phrase || "").toLowerCase().trim().split(/[\s-]+/).filter(Boolean);
  if (!words.length) return [];
  const values = [...new Set((namespaceValues || []).filter(Boolean))];

  const joined = words.join("-");
  const whole = values.filter((n) => n.toLowerCase() === joined);
  if (whole.length) return whole;

  const bySegment = values.filter((n) => {
    const segments = n.toLowerCase().split("-");
    return words.every((w) => segments.includes(w));
  });
  if (bySegment.length) return bySegment;

  return values.filter((n) => {
    const l = n.toLowerCase();
    return words.every((w) => l.includes(w));
  });
}

// The same, but allowed to give ground: if the whole phrase names nothing, drop
// one trailing word at a time. The dropped tail is returned rather than
// discarded — it is what the caller said about the deployment ("recette",
// "gatewaytesting"), and the customer map, not a word list, decides whether it
// means anything.
export function matchNamespacesPhrase(namespaceValues = [], phrase = "") {
  const words = String(phrase || "").trim().split(/\s+/).filter(Boolean);
  for (let n = words.length; n > 0; n--) {
    const namespaces = matchNamespaces(namespaceValues, words.slice(0, n).join(" "));
    if (namespaces.length) {
      return { namespaces, name: words.slice(0, n).join(" "), tail: words.slice(n) };
    }
  }
  return { namespaces: [], name: "", tail: words };
}


export function buildLogsQuery({ client, component, lineFilter, namespaces, caseSensitive = false } = {}) {
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
  const ns = [...new Set((namespaces || []).filter(Boolean))];
  // When the customer is pinned to its own namespace(s), those namespaces were
  // chosen from the whole phrase (or from the map, env filter already applied),
  // so the environment is ALREADY expressed by the namespace list. Repeating it
  // against `service_name` only removes results: some customers call production
  // `plt-live` or `multitenant`, so `service_name=~".*prod.*"` matched nothing
  // and the caller got an empty answer for a customer that was logging happily.
  // Without namespaces we keep the original behaviour: match the client
  // (+component) against service_name.
  const svcSource = ns.length ? "" : client;
  const parts = [toPattern(svcSource)].filter(Boolean);
  if (component) {
    const c = toPattern(component);
    if (c) parts.push(c);
  }
  const matchers = [];
  if (ns.length) {
    // Pin to the resolved customer namespace(s). Values are exact label values,
    // so anchor each and join with `|` (regex-escaped) for an exact alternation.
    matchers.push(`namespace=~"${ns.map((n) => `^${escapeRegex(n)}$`).join("|")}"`);
  }
  // (?i) = case-insensitive; .* between parts so order/extra segments are fine.
  // Omit the service_name matcher entirely when there's nothing left to narrow
  // by (namespace-pinned with no component/env) — an empty `.*.*` is noise.
  if (parts.length || !ns.length) {
    matchers.push(`service_name=~"(?i).*${parts.join(".*")}.*"`);
  }
  const selector = `{${matchers.join(", ")}}`;
  return lineFilter ? `${selector}${lineFilterExpr(lineFilter, { caseSensitive })}` : selector;
}

// Render a line filter as LogQL.
//
// `|=` is a case-SENSITIVE substring match, and getting the case wrong yields a
// clean, believable empty result — the failure mode this adapter keeps removing,
// in its most deniable form. So the default is case-insensitive: `|~ "(?i)term"`,
// with the term regex-escaped because `|~` takes a pattern, not a literal.
// Callers who know the casing (or want an exact match) can opt back in.
export function lineFilterExpr(lineFilter, { caseSensitive = false } = {}) {
  const text = String(lineFilter).replace(/`/g, "");
  if (!text) return "";
  return caseSensitive ? ` |= \`${text}\`` : ` |~ \`(?i)${escapeRegex(text)}\``;
}

// Build an EXACT LogQL query for one namespace scoped to the precise
// service_name values discovered via /series (not the free-text regex selector).
// Used for the Explore fallback attached to each drilldown link: Explore honours
// the `|=` line filter on load, whereas the Logs Drilldown app leaves a
// pre-filled var-lineFilters in the box without applying it. `=` for a single
// service_name, `=~` alternation (values regex-escaped) for several.
export function buildExactLogsQuery({ namespace, serviceNames = [], lineFilter, caseSensitive = false } = {}) {
  if (!namespace) throw new Error("namespace is required");
  const names = [...new Set((serviceNames || []).filter(Boolean))];
  const matchers = [`namespace="${namespace}"`];
  if (names.length === 1) {
    matchers.push(`service_name="${names[0]}"`);
  } else if (names.length > 1) {
    matchers.push(`service_name=~"${names.map(escapeRegex).join("|")}"`);
  }
  const selector = `{${matchers.join(", ")}}`;
  return lineFilter ? `${selector}${lineFilterExpr(lineFilter, { caseSensitive })}` : selector;
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

// Case-insensitive uses the app's `caseInsensitive` key with the regex operator
// `|~`; case-sensitive uses `caseSensitive` with `|=`. Both verified against the
// live app on data containing "GET": the token below with `get` returned 281
// lines case-insensitively and 0 case-sensitively, so the key genuinely drives
// matching rather than only labelling the input box.
export function buildLineFilterToken(text, { caseSensitive = false } = {}) {
  if (!text) return "";
  // key | operator | value, each part delimiter-escaped.
  return caseSensitive
    ? `caseSensitive,0|${GFP("|=")}|${GFP(text)}`
    : `caseInsensitive,0|${GFP("|~")}|${GFP(text)}`;
}

export function buildDrilldownUrl({ namespace, serviceNames = [], datasourceUid, from, to, lineFilter, caseSensitive = false } = {}) {
  if (!namespace) throw new Error("namespace is required");
  // No default: a uid that is merely plausible produces a link that loads and
  // silently shows the wrong (or no) data. Callers pass the configured uid.
  if (!datasourceUid) throw new Error("datasourceUid is required");
  const names = [...new Set((serviceNames || []).filter(Boolean))];
  const p = new URLSearchParams();
  p.set("patterns", "[]");
  p.set("from", from);
  p.set("to", to);
  p.set("var-lineFormat", "");
  p.set("var-ds", datasourceUid);
  // Each filter is `key|operator|value`; the app splits on `|`, so a pipe INSIDE
  // any part must be escaped as `__gfp__` (and a comma as `__gfc__`).
  //
  // A `=~` alternation does NOT work here, however it is escaped. Verified against
  // the live app: it treats a filter value as a LITERAL and regex-escapes it when
  // building the query, so `a|b` is sent to Loki as `service_name=~"a\\|b"` — a
  // literal pipe, matching nothing. That is the real bug behind the malformed
  // multi-service links: they matched zero lines, not merely the wrong ones.
  //
  // The app's own multi-value operator (`=|`, written `=__gfp__`, values joined by
  // `,`) does work — but only up to two values. With three or more the app
  // silently rewrites the URL down to the first two, consistently and regardless
  // of settle time (verified 1->1, 2->2, 3->2, 5->2). Emitting more would look
  // precise while quietly dropping services.
  //
  // So: pin the exact service_name when there is exactly one, and otherwise scope
  // the link to the namespace alone. Namespace-only is broader but never wrong,
  // and the caller still gets the exact set via `service_names` plus an
  // `explore_url` that carries the full LogQL.
  p.append("var-filters", `namespace|=|${GFP(namespace)}`);
  if (names.length === 1) {
    p.append("var-filters", `service_name|=|${GFP(names[0])}`);
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
  if (lineFilter) p.set("var-lineFilters", buildLineFilterToken(lineFilter, { caseSensitive }));
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

// An ISO 8601 timestamp is only unambiguous with an explicit offset.
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const LOOKS_LIKE_DATE = /^\d{4}-\d{2}-\d{2}/;

// Resolve Grafana-style relative ranges ("now-15m") to ns epoch for Loki's
// query_range. Absolute epoch-ms values pass through, and ISO 8601 is accepted
// ONLY with an explicit offset.
//
// This used to fall back to the default window for anything it could not parse,
// which meant `2026-08-20T15:00:00Z` — a perfectly explicit instant — silently
// became "the last hour". A caller investigating a specific incident window got
// a confident answer about entirely different data. A naive timestamp is worse
// still: Grafana renders in the browser's timezone while log bodies are UTC, so
// "15:26" means two different instants depending on who is reading. Both are now
// refused loudly instead of guessed at.
export function toLokiNs(value, fallbackSecondsAgo, now = Date.now()) {
  if (value === undefined || value === null || value === "") return `${(now - fallbackSecondsAgo * 1000) * 1e6}`;
  const raw = String(value).trim();

  const m = /^now(?:-(\d+)([smhd]))?$/.exec(raw);
  if (m) {
    if (!m[1]) return `${now * 1e6}`;
    const n = Number(m[1]);
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
    return `${(now - n * unit) * 1e6}`;
  }

  if (/^\d+$/.test(raw)) {
    // Loki reports per-line timestamps in NANOseconds (~19 digits). Epoch ms is
    // ~13. Treating a ns value as ms lands in the year 58000 and silently
    // queries an empty future window, so the two are distinguished by width.
    return raw.length >= 16 ? raw : `${Number(raw) * 1e6}`;
  }

  if (LOOKS_LIKE_DATE.test(raw)) {
    if (!EXPLICIT_OFFSET.test(raw)) {
      throw new Error(
        `timestamp "${raw}" has no timezone. Grafana displays in the browser's local timezone while log ` +
          "bodies are UTC, so a bare timestamp is ambiguous and would silently select the wrong window. " +
          'Add an explicit offset, e.g. "' + raw.replace(" ", "T") + 'Z" for UTC.',
      );
    }
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) throw new Error(`timestamp "${raw}" could not be parsed as ISO 8601`);
    return `${ms * 1e6}`;
  }

  throw new Error(
    `unrecognised time "${raw}": use "now", a relative range like "now-15m", epoch milliseconds, or ` +
      'ISO 8601 with an explicit offset ("2026-08-20T15:00:00Z")',
  );
}

// Echo the window a query actually ran over. The caller asked in one vocabulary
// ("now-24h"); this is what it resolved to, in UTC, so a wrong window is visible
// in the answer rather than inferred from surprise at the results.
export function resolvedWindow(from, to, fallbackSecondsAgo, now = Date.now()) {
  const startMs = Number(toLokiNs(from, fallbackSecondsAgo, now)) / 1e6;
  const endMs = Number(toLokiNs(to, 0, now)) / 1e6;
  return {
    from_utc: new Date(startMs).toISOString(),
    to_utc: new Date(endMs).toISOString(),
    duration_seconds: Math.round((endMs - startMs) / 1000),
    start_ms: startMs,
    end_ms: endMs,
  };
}

// --------------------------------------------------------------------------
// Trend + pattern helpers
// --------------------------------------------------------------------------

const DURATION_UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

export function durationSeconds(value) {
  const m = /^(\d+)([smhd])$/.exec(String(value ?? "").trim());
  if (!m) throw new Error(`invalid interval "${value}": use forms like 30s, 5m, 1h, 1d`);
  return Number(m[1]) * DURATION_UNITS[m[2]];
}

// Pick a bucket size giving a readable number of buckets for the range asked for.
// "When did this start?" is answered by shape, not resolution: 48 buckets over a
// day is legible, 1440 one-minute buckets is a wall of numbers that costs tokens
// and hides the onset.
const INTERVAL_CANDIDATES = ["1m", "5m", "15m", "30m", "1h", "3h", "6h", "12h", "1d"];

export function chooseInterval(rangeSeconds, { maxBuckets = 48 } = {}) {
  for (const candidate of INTERVAL_CANDIDATES) {
    if (rangeSeconds / durationSeconds(candidate) <= maxBuckets) return candidate;
  }
  return INTERVAL_CANDIDATES[INTERVAL_CANDIDATES.length - 1];
}

// Loki omits empty steps, so a sparse result cannot be read as a shape — a gap
// and a zero look identical. Fill the grid so the series is continuous, which is
// what makes an onset visible.
export function buildTrendBuckets(points = [], { startSeconds, endSeconds, stepSeconds, maxBuckets = 400 }) {
  const counts = new Map();
  for (const point of points) {
    const t = Number(point?.[0]);
    const v = Number(point?.[1]);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    // Loki stamps a count_over_time point at the END of the interval it counts:
    // at a 5m step the point stamped 17:15 holds the lines from (17:10, 17:15].
    // Filing it under its own stamp presented every bucket one interval late, so
    // an onset read off 5-minute buckets came out at 10:35 for an error that began
    // at 10:30. Verified live: a line at 17:13:33 is counted in the 17:15 point.
    // Filed under the interval's start instead; off-grid stamps snap to the grid.
    const slot = Math.ceil(t / stepSeconds) * stepSeconds - stepSeconds;
    counts.set(slot, (counts.get(slot) || 0) + v);
  }
  const first = Math.floor(startSeconds / stepSeconds) * stepSeconds;
  const buckets = [];
  // `t < endSeconds`: a bucket starting at the end covers nothing inside the window.
  for (let t = first; t < endSeconds && buckets.length < maxBuckets; t += stepSeconds) {
    const bucket = { time: new Date(t * 1000).toISOString(), count: counts.get(t) || 0 };
    // The grid does not start at `from` or end at `to`. An edge bucket reaching
    // outside the window counts lines outside it: a 1h trend from 14:34 reported
    // onset 14:00 and 18 lines when the window held 6. Marked here with the part
    // actually inside the window, so the caller can count exactly that.
    const from = Math.max(t, startSeconds);
    const to = Math.min(t + stepSeconds, endSeconds);
    if (from > t || to < t + stepSeconds) {
      bucket.partial = { from: new Date(from * 1000).toISOString(), to: new Date(to * 1000).toISOString(), seconds: to - from };
    }
    buckets.push(bucket);
  }
  return buckets;
}

// Reduce a filled series to the things the question is actually about: how much,
// when it started, and when it was worst.
export function summarizeTrend(buckets = []) {
  let total = 0;
  let peak = null;
  let onset = null;
  let last = null;
  for (const b of buckets) {
    total += b.count;
    if (b.count > 0) {
      if (onset === null) onset = b.time;
      last = b.time;
      if (!peak || b.count > peak.count) peak = { time: b.time, count: b.count };
    }
  }
  return { total, onset, last_seen: last, peak };
}

// Loki's /patterns returns one entry per detected pattern with [second, count]
// samples. Collapse to a ranked table.
//
// `lines_in_patterns` is the number of lines Loki ASSIGNED to a pattern, which is
// not the total number of lines in the range — unpatterned lines are absent. It is
// named for what it is so it cannot be read as a line count.
export function summarizePatterns(data = [], { maxPatterns = 20 } = {}) {
  const rows = [];
  let covered = 0;
  for (const entry of data) {
    const samples = Array.isArray(entry?.samples) ? entry.samples : [];
    let count = 0;
    let first = null;
    let last = null;
    for (const sample of samples) {
      const t = Number(sample?.[0]);
      const n = Number(sample?.[1]) || 0;
      if (!n) continue;
      count += n;
      if (Number.isFinite(t)) {
        if (first === null || t < first) first = t;
        if (last === null || t > last) last = t;
      }
    }
    if (!count) continue;
    covered += count;
    rows.push({
      pattern: entry?.pattern ?? null,
      level: entry?.level ?? null,
      count,
      first_seen: first === null ? null : new Date(first * 1000).toISOString(),
      last_seen: last === null ? null : new Date(last * 1000).toISOString(),
    });
  }
  rows.sort((a, b) => b.count - a.count);
  return {
    lines_in_patterns: covered,
    pattern_count: rows.length,
    // Loki's pattern detection has a volume floor: rare lines are not assigned a
    // pattern at all and are simply absent. Reporting the smallest pattern we got
    // back tells the caller, empirically, roughly what could be missing — a 1-line
    // exception will not be in here.
    smallest_pattern_count: rows.length ? rows[rows.length - 1].count : null,
    patterns: rows.slice(0, maxPatterns),
    patterns_truncated: rows.length > maxPatterns ? rows.length - maxPatterns : 0,
  };
}

// Flatten Loki's per-stream query_range response into ONE time-ordered sequence.
//
// Order is the whole point. A logger formatting with `\n` emits SEPARATE Loki
// entries: the first carries the searchable text, the second carries the actual
// reason and contains none of the filter's keywords. Stack traces and
// `Caused by:` chains behave the same way. Reading them in order, unfiltered, is
// the only way to see the detail a filtered query structurally hides.
export function mergeContextStreams(result = [], { maxLines = 200, maxLineChars = 2000 } = {}) {
  const rows = [];
  for (const stream of result) {
    const labels = stream?.stream || {};
    for (const [ts, line] of stream?.values || []) {
      const ns = Number(ts);
      if (!Number.isFinite(ns)) continue;
      rows.push({
        time: new Date(ns / 1e6).toISOString(),
        ts_ns: String(ts),
        service_name: labels.service_name ?? null,
        pod: labels.pod ?? null,
        line: typeof line === "string" && line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…[truncated]` : line,
        _sort: ns,
      });
    }
  }
  rows.sort((a, b) => a._sort - b._sort);
  const total = rows.length;
  return {
    lines: rows.slice(0, maxLines).map(({ _sort, ...r }) => r),
    total,
    truncated: total > maxLines ? total - maxLines : 0,
  };
}

// --------------------------------------------------------------------------
// Noise profiling
// --------------------------------------------------------------------------

// Reduce a log line to its SHAPE, so lines that differ only in their variable
// parts count as one thing. Rules are ordered: the specific ones must run before
// the general ones, or a timestamp gets eaten by the number rule and two
// different shapes collapse into one.
//
// Designed against real lines from this instance — Java stack frames, "... 193
// common frames omitted", thread names carrying a counter, and Foo.java:5377.
const NOISE_RULES = [
  // A stack frame is pure noise: every frame differs by class, and keeping them
  // apart turns one exception into fifty "distinct" shapes.
  [/^\s*at [\w$.]+\(.*\)\s*$/, "at <stack frame>"],
  [/\.\.\.\s+\d+\s+common frames omitted/g, "... <n> common frames omitted"],
  // Timestamps, in the forms this instance actually emits.
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>"],
  [/\d{1,2}\/[A-Za-z]{3}\/\d{4}(?::\d{2}:\d{2}:\d{2})?/g, "<ts>"],
  [/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<ts>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/(?:::ffff:)?\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ip>"],
  [/\b[0-9a-f]{8,}\b/gi, "<hex>"],
  [/\b\d+\b/g, "<n>"],
];

export function normaliseLogLine(line = "") {
  let s = String(line);
  for (const [re, replacement] of NOISE_RULES) {
    if (re.source.startsWith("^")) {
      if (re.test(s)) return replacement;
    } else {
      s = s.replace(re, replacement);
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

// A ready-to-paste LogQL fragment that removes a shape from a query. The longest
// run of text carrying no placeholder is the most specific thing stable across
// every occurrence of that shape.
//
// Stack frames are special-cased: their only literal is "at", which is far too
// short to exclude on, yet they are the commonest thing anyone wants gone — so
// they get a line-start regex instead.
export function suggestExclusion(shape = "") {
  if (shape === "at <stack frame>") return '!~ `^\\s+at `';
  const literals = String(shape)
    .split(/<[a-z ]+>/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
  if (!literals.length) return null;
  const longest = literals.sort((a, b) => b.length - a.length)[0];
  // Backticks would terminate the LogQL string literal.
  return `!= \`${longest.replace(/`/g, "")}\``;
}

// Count shapes across a sample. Percentages describe THE SAMPLE, never the whole
// window: Loki fills a limit backwards from the window end, so a sample is both
// capped and time-biased. The caller is told what the sample actually covered so
// the numbers are not read as a property of the range asked for.
export function profileNoise(lines = [], { maxShapes = 10, dominantPct = 40 } = {}) {
  const counts = new Map();
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const shape = normaliseLogLine(line);
    if (!shape) continue;
    const seen = counts.get(shape);
    if (seen) seen.count++;
    else counts.set(shape, { shape, count: 1, example: line.length > 300 ? `${line.slice(0, 300)}…` : line });
  }
  const sampled = [...counts.values()].reduce((n, s) => n + s.count, 0);
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  const shapes = ranked.slice(0, maxShapes).map((s) => ({
    shape: s.shape,
    count: s.count,
    percent_of_sample: sampled ? Math.round((s.count / sampled) * 1000) / 10 : 0,
    example: s.example,
    ...(sampled && (s.count / sampled) * 100 >= dominantPct
      ? { dominant: true, suggested_exclusion: suggestExclusion(s.shape) }
      : {}),
  }));
  return {
    sampled_lines: sampled,
    distinct_shapes: ranked.length,
    shapes,
    shapes_truncated: ranked.length > maxShapes ? ranked.length - maxShapes : 0,
  };
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

// ---------------------------------------------------------------------------
// HTTP request logs
// ---------------------------------------------------------------------------

// Where a customer's HTTP request logs actually live.
//
// This is the single most costly gap the adapter had. Every customer-scoped tool
// resolves `client` to the customer's OWN namespaces (`acme-prod`,
// `apim-dp-<cp>-<dp>`), and those namespaces hold application logs only. The
// access logs — status code, request duration, upstream response time — are
// emitted by the shared ingress controller, which runs in the `ingress-nginx`
// namespace and is identified by the CLUSTER label. No namespace-scoped query
// can ever reach them.
//
// The consequence is not a missing feature but a wrong answer: an investigation
// asks "is the Management API slow for this customer", every namespace-scoped
// probe comes back empty, and the empty results read as evidence that the data
// does not exist. It does exist, one label away.
export const INGRESS_JOB = "flow/ingress-nginx-ingress-nginx";

// There are TWO ingress controllers, and they carry different traffic.
//
// ingress-nginx fronts gateways and the management API. The AKS app-routing
// add-on (namespace `app-routing-system`) fronts the bridge: every data plane's
// `/_bridge/...` sync call to its control plane. Searching only ingress-nginx for
// bridge failures returns a clean, scanned, empty result — a false negative that
// hid the key evidence of an incident, where bridge calls to one pod IP returned
// 499 after 1s while calls to its sibling returned 200 in 2ms. Both controllers
// write the same access-log format, so both are parsed identically.
export const INGRESS_JOBS = Object.freeze({
  nginx: INGRESS_JOB,
  "app-routing": "flow/app-routing-system-",
});

export function ingressJobs(ingress = "all") {
  if (ingress === "all" || ingress === undefined || ingress === null) return Object.values(INGRESS_JOBS);
  const job = INGRESS_JOBS[ingress];
  if (!job) {
    throw new Error(`Unknown ingress "${ingress}". Use one of: ${Object.keys(INGRESS_JOBS).join(", ")}, all.`);
  }
  return [job];
}

export function ingressName(job) {
  const hit = Object.entries(INGRESS_JOBS).find(([, j]) => j === job);
  return hit ? hit[0] : job || null;
}

// The access-log line, parsed in two stages.
//
// The head — method through upstream name — is fixed-shape, so Loki's `pattern`
// parser handles it cheaply and readably. `<_>` discards a field without naming
// it, so the client address and referer never become labels.
//
// The tail cannot be a pattern. When nginx retries a request against another
// upstream it records every attempt, comma-separated, in each upstream field:
//
//   [ns-svc-82] [] 10.0.1.11:8082, 10.0.1.12:8082 0, 99 83.442, 0.502 502, 200 <req_id>
//
// A space-delimited pattern shifts every field after the first comma, so
// upstream_time came out as "0," — and one such value anywhere in the window
// made Loki reject the entire unwrap query with HTTP 400. That is why the tool
// failed on longer windows: they were more likely to contain a retry. Retried
// requests are also exactly the interesting ones. The regexp captures each
// field as a whole list instead. Verified live: head-only and head+tail match
// exactly the same lines, on both ingress controllers.
export const NGINX_PATTERN =
  '<_> - <_> [<_>] "<method> <path> <_>" <status> <_> "<_>" "<user_agent>" <_> <request_time> [<upstream>] <_>';

const UPSTREAM_LIST = "\\S+(?:(?:, | : )\\S+)*";
export const UPSTREAM_TAIL_REGEXP =
  `\\] \\[[^\\]]*\\] (?P<upstream_addr>${UPSTREAM_LIST}) ${UPSTREAM_LIST} ` +
  `(?P<upstream_time>${UPSTREAM_LIST}) (?P<upstream_status>${UPSTREAM_LIST}) [0-9a-f]{32}`;

// Only a request that went to more than one upstream has a list here.
export const RETRIED_MATCHER = " | upstream_addr =~ `.*(?:, | : ).*`";

// Numeric operations only on values that ARE numbers. An unwrap or a numeric
// comparison that meets a non-number does not skip the sample — it fails the
// whole query. Label matchers are fully anchored in LogQL, so this admits a
// single number and nothing else (not "0,", not "-", not an empty string).
export function numericGuard(field) {
  return ` | ${field} =~ \`[0-9]+(?:\\.[0-9]+)?\``;
}

export function unwrapNumeric(field) {
  return `${numericGuard(field)} | unwrap ${field}`;
}

// Translate a status filter into a LogQL label matcher.
// Accepts a code (`499`), a class (`5xx`), or a comma/space separated list of
// either. Label matchers are fully anchored in LogQL, so `5..` matches exactly a
// three-digit 5xx and cannot spill into other fields.
export function statusFilterExpr(statusFilter) {
  const terms = String(statusFilter || "")
    .split(/[,\s]+/)
    .filter(Boolean);
  if (!terms.length) return "";
  const patterns = terms.map((term) => {
    const klass = /^([1-5])xx$/i.exec(term);
    if (klass) return `${klass[1]}..`;
    if (/^[1-5]\d{2}$/.test(term)) return term;
    throw new Error(
      `Unrecognised status_filter "${term}". Use a status code (499), a class (5xx), or a list ("499, 5xx").`,
    );
  });
  return ` | status =~ \`${patterns.join("|")}\``;
}

// Build the LogQL for ingress access logs on one cluster.
//
// `upstreamNamespaces` scopes the result to one customer. It is REQUIRED on a
// cluster that hosts more than one tenant and pointless on a dedicated one, so
// the caller decides — see resolveIngressScope in server.js, which decides from
// what is actually deployed on the cluster rather than from a naming convention.
export function buildIngressQuery({
  cluster,
  ingress = "all",
  upstreamNamespaces = [],
  pathFilter,
  statusFilter,
  method,
  minDurationSeconds,
} = {}) {
  if (!cluster) throw new Error("cluster is required");
  const jobs = ingressJobs(ingress);
  const ns = [...new Set((upstreamNamespaces || []).filter(Boolean))];
  const alternation = ns.map((n) => escapeRegex(n)).join("|");
  const jobMatcher =
    jobs.length === 1 ? `job=\`${jobs[0]}\`` : `job=~\`${jobs.map((j) => escapeRegex(j)).join("|")}\``;

  const parts = [`{cluster=\`${cluster}\`, ${jobMatcher}}`];
  // A line filter runs on raw bytes, before any parser, so this cuts the volume
  // the parsers touch. It is an optimisation only — the authority is the
  // `upstream` matcher below, which cannot be fooled by the namespace name
  // appearing somewhere else in the line.
  if (ns.length) parts.push(` |~ \`\\[(${alternation})-\``);
  parts.push(` | pattern \`${NGINX_PATTERN}\``);
  parts.push(` | regexp \`${UPSTREAM_TAIL_REGEXP}\``);
  // Access-log lines only. Both controllers also log their own lifecycle and
  // errors to the same stream; those have no status and must neither be counted
  // as requests nor reach an unwrap.
  parts.push(" | status =~ `[1-5][0-9][0-9]`");
  if (ns.length) parts.push(` | upstream =~ \`(${alternation})-.*\``);
  if (method) parts.push(` | method = \`${String(method).replace(/`/g, "").toUpperCase()}\``);
  if (statusFilter) parts.push(statusFilterExpr(statusFilter));
  // Case-insensitive for the same reason line filters are: a wrong-case path
  // fragment returns a clean, believable, empty result.
  if (pathFilter) parts.push(` | path =~ \`(?i).*${escapeRegex(String(pathFilter).replace(/`/g, ""))}.*\``);
  if (Number.isFinite(minDurationSeconds) && minDurationSeconds > 0) {
    parts.push(`${numericGuard("request_time")} | request_time > ${minDurationSeconds}`);
  }
  return parts.join("");
}

// The same line, parsed in JS for sample mode — where each attempt matters
// individually. A retried request that ended 200 after two 502s is a success to
// the client and a failure of two specific pods; flattening it to one status and
// one address loses the second fact, which is the one that finds a bad node.
const JS_LIST = "\\S+(?:(?:, | : )\\S+)*";
const ACCESS_LINE = new RegExp(
  '^(\\S+) - (\\S+) \\[([^\\]]+)\\] "(\\S+) (\\S+) ([^"]*)" (\\d{3}) (\\d+) "([^"]*)" "([^"]*)" (\\d+) ([\\d.]+) ' +
    `\\[([^\\]]*)\\] \\[[^\\]]*\\] (${JS_LIST}) (${JS_LIST}) (${JS_LIST}) (${JS_LIST}) ([0-9a-f]{32})`,
);

export function parseAccessLogLine(line) {
  const m = ACCESS_LINE.exec(String(line || ""));
  if (!m) return null;
  const list = (s) => String(s).split(/, | : /);
  const num = (s) => (s === undefined || s === "-" || s === "" ? null : Number(s));
  const addrs = list(m[14]);
  const times = list(m[16]);
  const statuses = list(m[17]);
  const attempts = addrs.map((addr, i) => ({
    addr,
    // `-` is kept literally: "the upstream never answered" is the finding.
    status: statuses[i] ?? null,
    response_time: num(times[i]),
  }));
  return {
    method: m[4],
    path: m[5],
    status: Number(m[7]),
    request_time: Number(m[12]),
    user_agent: m[10],
    upstream: m[13] || null,
    attempts,
    retried: attempts.length > 1,
  };
}

// Grafana Adaptive Logs marks a sampled stream with this label. Its presence
// means lines were DISCARDED before reaching Loki. It is attached at query time:
// /series and the label-values endpoints do not return it, only results do.
export const ADAPTIVE_LOGS_LABEL = "__adaptive_logs_sampled__";

// Report that Adaptive Logs is discarding lines from these streams.
//
// The label is already on every stream Loki returns; nothing read it, so a
// sampled stream was indistinguishable from a complete one. That matters most
// exactly where it is least visible: a stack trace arrives as separate Loki
// entries, so sampling can keep the exception header and drop its frames,
// producing a truncated trace that reads as "the log is incomplete" rather than
// "these lines were deliberately discarded, and an exemption can be requested".
export function detectSampling(streams = [], { noun = "streams" } = {}) {
  const values = new Set();
  let sampled = 0;
  for (const s of streams) {
    const v = s?.labels?.[ADAPTIVE_LOGS_LABEL];
    if (v !== undefined && v !== null && String(v) !== "") {
      sampled++;
      values.add(String(v));
    }
  }
  if (!sampled) return null;
  return {
    sampled_streams: sampled,
    total_streams: streams.length,
    label_values: [...values].sort(),
    warning:
      `Grafana Adaptive Logs is sampling ${sampled} of ${streams.length} matched ${noun} ` +
      `(${ADAPTIVE_LOGS_LABEL} = ${[...values].sort().join(", ")}), so lines were discarded before they ` +
      "reached Loki. Counts from this stream are LOWER BOUNDS, not totals. Multi-line content is affected " +
      "worst: an exception header can survive while its stack frames are dropped, which looks like a " +
      "truncated log rather than a sampling rule. A per-cluster/job exemption can be requested from the " +
      "Platform team.",
  };
}

// Describe what a query did and did not search.
//
// Derived from the selector actually sent, not from the caller's intent, so it
// cannot drift out of step with it. The point is narrow: a negative from a
// customer-scoped query and a negative from a cluster-wide one are reported
// identically today, and the difference between them is entire categories of
// infrastructure. Stating the scope alongside the verdict makes the premise
// visible at the moment it is being relied on, instead of leaving every caller
// to remember that `client` means "application logs only".
// Namespaces that belong to the platform on every cluster, never to a customer.
const INFRA_NAMESPACE =
  /^(?:ingress-nginx|app-routing-system|kube-[a-z0-9-]+|cert-manager|monitoring|flow|default|external-dns|velero|calico-system|gatekeeper-system)$/;

function namespaceMatcherValues(q) {
  const values = [];
  for (const m of q.matchAll(/(?:^|[{,\s])namespace\s*(=~|=)\s*["`]([^"`]*)["`]/g)) {
    if (m[1] === "=") values.push(m[2]);
    else for (const alt of m[2].split("|")) values.push(alt.replace(/^\^/, "").replace(/\$$/, ""));
  }
  return values.filter(Boolean);
}

export function scopeNote(query = "") {
  const q = String(query || "");
  const namespaceScoped = /(^|[{,\s])namespace\s*=~?/.test(q);
  const clusterScoped = /(^|[{,\s])cluster\s*=~?/.test(q);
  const nsValues = namespaceMatcherValues(q);
  // Checked before anything else: an ingress namespace is the OPPOSITE of
  // customer scope — every tenant's traffic on the cluster — and calling it
  // "application logs only" inverted the warning exactly where it mattered.
  if (namespaceScoped && nsValues.length && nsValues.every((v) => INFRA_NAMESPACE.test(v))) {
    return (
      `Scoped to shared infrastructure namespace(s) (${[...new Set(nsValues)].join(", ")}), not to a customer. ` +
      "An ingress namespace holds HTTP request logs for EVERY tenant on its cluster, so results include other " +
      "customers' traffic unless narrowed. grafana_http_requests scopes ingress logs to one customer."
    );
  }
  if (clusterScoped) {
    return (
      "Scoped to the whole cluster, so shared infrastructure IS included — and on a multi-tenant cluster " +
      "that means other customers' traffic unless the query narrows it further."
    );
  }
  if (namespaceScoped) {
    return (
      "Scoped to customer namespaces: APPLICATION logs only. Shared cluster infrastructure was NOT " +
      "searched — ingress-nginx, cert-manager and other cluster-level namespaces are outside this scope. " +
      "HTTP request logs (status codes, request durations, upstream response times) live in the ingress " +
      "namespace and are NOT covered here; use grafana_http_requests for those."
    );
  }
  return null;
}

// Downgrade a scanned-but-empty verdict when the stream is being sampled.
//
// "The streams exist and were searched" is true of a sampled stream and still
// not a trustworthy negative: a specific request id, trace id or exception can
// have been discarded before it reached Loki. Reporting EMPTY_BUT_SCANNED there
// told an investigation a request never happened.
export function applySamplingToCoverage(entry, sampling) {
  if (!entry || !sampling) return entry;
  entry.adaptive_logs_sampling = entry.adaptive_logs_sampling || sampling;
  if (entry.coverage === "EMPTY_BUT_SCANNED") {
    entry.coverage = "EMPTY_BUT_SAMPLED";
    delete entry.coverage_note;
    entry.coverage_warning =
      "No matching lines, and the streams were scanned — but Adaptive Logs is discarding lines from them " +
      `(${sampling.label_values.join(", ")}). Absence of a specific line (a request id, a trace id, one ` +
      "exception) is NOT proof it was never logged. Counts from these streams are lower bounds.";
  }
  return entry;
}

// The stream selector of a LogQL expression: the first `{...}`, respecting
// quoted and backtick-quoted strings (which may contain braces).
export function extractStreamSelector(expr = "") {
  const s = String(expr || "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  let quote = null;
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "`") quote = c;
    else if (c === "}") return s.slice(start, i + 1);
  }
  return null;
}

// The query step Grafana should use, in milliseconds.
//
// /api/ds/query does not derive a step from maxDataPoints: without intervalMs
// both the Loki and Prometheus backends evaluate at 1s, so a 1h range returned
// 3,601 points per series whatever max_data_points said — too many to read and,
// raw, over the tool-result limit. An explicit step wins; otherwise the range is
// divided across the requested number of points.
export function queryIntervalMs({ startMs, endMs, maxDataPoints = 1000, step } = {}) {
  if (step) {
    const seconds = durationSeconds(step);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`Unrecognised step "${step}". Use a duration such as 30s, 5m, 1h.`);
    }
    return seconds * 1000;
  }
  const span = Math.max(0, Number(endMs) - Number(startMs));
  return Math.max(1000, Math.ceil(span / Math.max(1, maxDataPoints)));
}

// A compact timeline: [timestamp, value] pairs per series, at the step the
// query ran at. The digest's first/last/min/max/avg answers "how big"; only the
// points answer "when", and raw frames were too large to return.
export function timelineFromPayload(payload = {}, { maxSeries = 20, maxPoints = 500 } = {}) {
  const out = {};
  for (const [refId, res] of Object.entries(payload.results || {})) {
    const series = [];
    for (const frame of Array.isArray(res?.frames) ? res.frames : []) {
      const kind = classifyFrame(frame);
      if (kind === "logs" || kind === "table") continue;
      const fields = frame?.schema?.fields || [];
      const timeIdx = fields.findIndex((f) => f?.type === "time");
      if (timeIdx === -1) continue;
      const times = frame?.data?.values?.[timeIdx] || [];
      for (let idx = 0; idx < fields.length; idx++) {
        if (fields[idx]?.type !== "number") continue;
        const values = frame?.data?.values?.[idx] || [];
        const points = [];
        for (let i = 0; i < times.length; i++) {
          if (typeof values[i] !== "number") continue;
          points.push([new Date(Number(times[i])).toISOString(), values[i]]);
        }
        series.push({ labels: fields[idx]?.labels || {}, point_count: points.length, points });
      }
    }
    out[refId] = {
      status: res?.status ?? null,
      series_count: series.length,
      series: series.slice(0, maxSeries).map((s) =>
        s.points.length > maxPoints
          ? { ...s, points: s.points.slice(0, maxPoints), points_truncated: s.points.length - maxPoints }
          : s,
      ),
      series_truncated: series.length > maxSeries ? series.length - maxSeries : 0,
    };
  }
  return out;
}

// Sampling, read from a metric result grouped by the sampling label.
//
// Grouping by the label costs nothing extra on a count the tool runs anyway, and
// it is the only reliable way to see sampling once lines are aggregated into
// numbers. Reported as the share of counted lines that came from sampled
// streams, because that is what bounds how far the numbers can be trusted.
export function samplingFromGroupedCounts(result = [], { checked } = {}) {
  let total = 0;
  let sampledLines = 0;
  const values = new Set();
  for (const r of result || []) {
    const n = Number(r?.value?.[1]);
    if (!Number.isFinite(n)) continue;
    total += n;
    const v = r?.metric?.[ADAPTIVE_LOGS_LABEL];
    if (v !== undefined && v !== null && String(v) !== "") {
      sampledLines += n;
      values.add(String(v));
    }
  }
  if (!values.size) return null;
  const pct = total ? Math.round((sampledLines / total) * 1000) / 10 : 100;
  const labelValues = [...values].sort();
  return {
    sampled_share_pct: pct,
    label_values: labelValues,
    ...(checked ? { checked } : {}),
    warning:
      `Grafana Adaptive Logs is sampling these streams (${ADAPTIVE_LOGS_LABEL} = ${labelValues.join(", ")}): ` +
      `${pct}% of the lines counted came from sampled streams, and lines were discarded before they reached ` +
      "Loki. Counts are LOWER BOUNDS, and the absence of a specific line (a request id, a trace id, one " +
      "exception) is not proof it was never logged. A per-cluster/job exemption can be requested from the " +
      "Platform team.",
  };
}

// A matrix grouped by the sampling label, summed back into one series.
export function collapseSampledMatrix(result = []) {
  const merged = new Map();
  const totals = [];
  for (const r of result || []) {
    let sum = 0;
    for (const [t, v] of r?.values || []) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      merged.set(Number(t), (merged.get(Number(t)) || 0) + n);
      sum += n;
    }
    totals.push({ metric: r?.metric || {}, value: [0, String(sum)] });
  }
  const points = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => [t, String(v)]);
  return { points, sampling: samplingFromGroupedCounts(totals) };
}

// Attempts and failures per upstream address.
//
// Grouping requests by pod is what found the root cause of an incident: every
// failing pod sat on one node while siblings elsewhere were healthy. A retried
// request carries one address and one status PER ATTEMPT, and the failed
// attempts are the evidence — a request that ended 200 after two 502s is two
// bad pods and one good one — so the lists are split pairwise, not flattened.
// `-` as a status means that upstream never answered, which is a failure.
export function aggregateUpstreamAttempts(result = [], { limit = 20 } = {}) {
  const per = new Map();
  for (const r of result || []) {
    const n = Number(r?.value?.[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const addrs = String(r?.metric?.upstream_addr ?? "").split(/, | : /);
    const statuses = String(r?.metric?.upstream_status ?? "").split(/, | : /);
    addrs.forEach((addr, i) => {
      if (!addr || addr === "-") return;
      const status = statuses[i] ?? "-";
      const e = per.get(addr) || { addr, ingress: new Set(), attempts: 0, failed: 0, by_status: {} };
      e.attempts += n;
      e.by_status[status] = (e.by_status[status] || 0) + n;
      if (!/^[23]\d\d$/.test(status)) e.failed += n;
      if (r?.metric?.job) e.ingress.add(ingressName(r.metric.job));
      per.set(addr, e);
    });
  }
  const rows = [...per.values()].map((e) => ({
    upstream_addr: e.addr,
    ip: e.addr.replace(/:\d+$/, ""),
    ingress: [...e.ingress].sort(),
    attempts: e.attempts,
    failed_attempts: e.failed,
    failure_pct: e.attempts ? Math.round((e.failed / e.attempts) * 1000) / 10 : 0,
    by_status: e.by_status,
  }));
  rows.sort((a, b) => b.failed_attempts - a.failed_attempts || b.attempts - a.attempts);
  return { rows: rows.slice(0, limit), total_upstreams: rows.length };
}

// Roll upstream rows (with resolved pods) up to the node they ran on. One bad
// node shows up as one row carrying the failures while the others are clean.
export function rollupByNode(rows = []) {
  const per = new Map();
  for (const r of rows || []) {
    for (const p of r?.pods || []) {
      if (!p?.node) continue;
      const e = per.get(p.node) || { node: p.node, host_ip: p.host_ip || null, pods: new Set(), attempts: 0, failed: 0 };
      e.pods.add(p.pod);
      e.attempts += r.attempts || 0;
      e.failed += r.failed_attempts || 0;
      per.set(p.node, e);
    }
  }
  return [...per.values()]
    .map((e) => ({
      node: e.node,
      host_ip: e.host_ip,
      pod_count: e.pods.size,
      pods: [...e.pods].sort(),
      attempts: e.attempts,
      failed_attempts: e.failed,
      failure_pct: e.attempts ? Math.round((e.failed / e.attempts) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.failed_attempts - a.failed_attempts || b.attempts - a.attempts);
}

// ---------------------------------------------------------------------------
// Comparison against the same window, earlier
// ---------------------------------------------------------------------------
//
// An incident investigation took its baseline from earlier the same day — a
// low-traffic hour — and read a chronic 499 pattern and pre-existing restarts as
// incident impact. The error only surfaced when someone compared against the
// same window the day before. A fixed offset (1d, 7d) compares like with like:
// same time of day, same weekday.
//
// The comparison re-runs the identical query over a shifted window rather than
// rewriting it with `offset` modifiers. Rewriting is fragile (subqueries,
// existing offsets, languages without the modifier); shifting the window is
// exact for every datasource.

// "Similar" is a claim about LEVEL, and it used to be the only thing a comparison
// said. With a x0.5-x2 band a halving came back "similar ... already happening
// then" — true about presence, misleading about level. The two questions are
// answered separately now: `already_present` says whether the pattern existed in
// the baseline at all; `change` says whether its level moved, with a band tight
// enough that a halving is "lower". The band is symmetric: 0.75 = 1 / (4/3).
export const SIMILAR_BAND = Object.freeze({ low: 0.75, high: 4 / 3 });

export const CHANGE_LABELS_NOTE =
  "change compares the LEVEL against the baseline: similar = within x0.75-x1.33; higher above that; lower below " +
  "it; new = absent then while the streams existed; gone = absent now; none = absent in both; no_baseline = no " +
  "data at all in the baseline window (outside retention, or not yet deployed), which is evidence of nothing. " +
  "already_present answers separately whether it existed in the baseline at all: a pattern can be lower AND " +
  "already present, which means not new, but not at the same level either.";

export function parseCompareOffset(offset, { windowSeconds } = {}) {
  const raw = String(offset ?? "").trim().toLowerCase();
  let seconds;
  const weeks = /^(\d+)w$/.exec(raw);
  if (weeks) seconds = Number(weeks[1]) * 7 * 86400;
  else {
    try {
      seconds = durationSeconds(raw);
    } catch {
      throw new Error(`Unrecognised compare_offset "${offset}". Use a duration such as 1d, 7d or 1w.`);
    }
  }
  if (!(seconds > 0)) throw new Error(`compare_offset must be positive, got "${offset}".`);
  // A baseline that overlaps the window compares the window partly with itself,
  // and the overlap drags every ratio towards 1 — towards "similar".
  if (Number.isFinite(windowSeconds) && seconds < windowSeconds) {
    throw new Error(
      `compare_offset ${offset} is shorter than the ${windowSeconds}s window, so the baseline would overlap ` +
        "the period being compared. Use at least the window length; 1d or 7d compares like with like.",
    );
  }
  return seconds;
}

export function compareValues(current, baseline, { baselineAvailable = true } = {}) {
  const c = Number(current) || 0;
  const b = Number(baseline) || 0;
  // A baseline window with no data at all is not a baseline of zero. Calling
  // that "new" would turn retention limits into findings.
  if (!baselineAvailable) {
    return { current: c, baseline: null, ratio: null, change: "no_baseline", already_present: null };
  }
  if (b === 0) return { current: c, baseline: b, ratio: null, change: c === 0 ? "none" : "new", already_present: false };
  const r = c / b;
  let change = "similar";
  if (c === 0) change = "gone";
  else if (r >= SIMILAR_BAND.high) change = "higher";
  else if (r <= SIMILAR_BAND.low) change = "lower";
  return { current: c, baseline: b, ratio: Math.round(r * 100) / 100, change, already_present: true };
}

export function describeChange(cmp, offset, subject = "the volume") {
  const s = subject.charAt(0).toUpperCase() + subject.slice(1);
  switch (cmp?.change) {
    case "similar":
      return `${s} ${offset} earlier was similar (x${cmp.ratio}): this was already happening then, so do not read it as new in this window.`;
    case "higher":
      return (
        `${s} is x${cmp.ratio} what it was ${offset} earlier: higher. It was already present then, so this is an ` +
        "increase in an existing pattern, not a new one."
      );
    case "lower":
      return (
        `${s} is x${cmp.ratio} what it was ${offset} earlier: lower. It was already present then: not new in this ` +
        "window, but not at the same level either."
      );
    case "new":
      return `None ${offset} earlier, although the streams existed then: this is new since the baseline.`;
    case "gone":
      return `Present ${offset} earlier, absent now.`;
    case "none":
      return "Nothing in either window.";
    case "no_baseline":
      return (
        `No data at all ${offset} earlier (outside retention, or not yet deployed), so there is no baseline: ` +
        "this is not evidence that the pattern is new."
      );
    default:
      return null;
  }
}

// Baseline counts beside the current ones, by position. Both windows are built
// with the same step and length, so bucket i then is bucket i now.
export function attachBaselineBuckets(current = [], baseline = []) {
  return current.map((b, i) => ({ ...b, baseline: baseline[i]?.count ?? 0 }));
}

const labelKey = (labels) => JSON.stringify(Object.entries(labels || {}).sort());

export function compareQueryDigests(current = {}, baseline = {}, { baselineAvailable = true } = {}) {
  const out = {};
  for (const [refId, cur] of Object.entries(current.results || {})) {
    const base = baseline.results?.[refId] || {};
    const entry = {};
    if (cur.series_count !== undefined) {
      const remaining = new Map((base.series || []).map((s) => [labelKey(s.labels), s]));
      entry.series = (cur.series || []).map((s) => {
        const b = remaining.get(labelKey(s.labels));
        remaining.delete(labelKey(s.labels));
        return {
          labels: s.labels,
          avg: compareValues(s.avg, b?.avg, { baselineAvailable }),
          last: compareValues(s.last, b?.last, { baselineAvailable }),
          max: compareValues(s.max, b?.max, { baselineAvailable }),
        };
      });
      const gone = [...remaining.values()].map((s) => ({ labels: s.labels, avg: compareValues(0, s.avg) }));
      if (gone.length) entry.only_in_baseline = gone;
    }
    if (cur.line_count !== undefined) {
      entry.line_count = compareValues(cur.line_count, base.line_count ?? 0, { baselineAvailable });
      if (cur.coverage === "TRUNCATED" || base.coverage === "TRUNCATED") {
        entry.line_count_note =
          "At least one window hit max_lines, so this compares two caps, not two volumes. Use " +
          "grafana_logs_trend or a count_over_time query to compare volume.";
      }
    }
    if (cur.row_count !== undefined) {
      entry.row_count = compareValues(cur.row_count, base.row_count ?? 0, { baselineAvailable });
    }
    out[refId] = entry;
  }
  return out;
}

// Baseline points shifted forward by the offset, so their timestamps line up with
// the current points and a reader can compare row by row.
export function attachBaselineTimeline(current = {}, baseline = {}, offsetSeconds = 0) {
  for (const [refId, cur] of Object.entries(current)) {
    const base = new Map((baseline[refId]?.series || []).map((s) => [labelKey(s.labels), s]));
    for (const s of cur.series || []) {
      const b = base.get(labelKey(s.labels));
      // No counterpart is not a flat zero. An empty list read exactly like
      // "nothing happened then"; null plus a flag says "no baseline for this".
      if (!b) {
        s.baseline_points = null;
        s.baseline_missing = true;
        continue;
      }
      s.baseline_points = (b.points || []).map(([t, v]) => [new Date(Date.parse(t) + offsetSeconds * 1000).toISOString(), v]);
    }
  }
  return current;
}

// What a trend bucket's time means, stated in every result that has buckets.
export const BUCKET_COVERS_NOTE =
  "Each bucket's time is the START of the interval it counts: [time, time + interval). Loki stamps a " +
  "count_over_time point at the END of its interval; buckets are relabelled so an onset is not reported one " +
  "interval late. Edge buckets marked partial cover only the part inside the window, counted exactly. For the " +
  "exact first line, use grafana_first_occurrence.";

// The earliest line across every stream Loki returned. Loki orders a forward
// query per stream, so the minimum has to be taken across streams.
export function earliestLine(result = [], { maxLineChars = 1000 } = {}) {
  let best = null;
  for (const r of result || []) {
    for (const [ns, line] of r?.values || []) {
      let n;
      try {
        n = BigInt(ns);
      } catch {
        continue;
      }
      if (!best || n < best.n) best = { n, line, labels: r?.stream || {} };
    }
  }
  if (!best) return null;
  const text = String(best.line ?? "");
  return {
    time: new Date(Number(best.n / 1000000n)).toISOString(),
    ns: best.n.toString(),
    line: text.length > maxLineChars ? `${text.slice(0, maxLineChars)}…[truncated]` : text,
    labels: best.labels,
  };
}

// What the first line in a window does and does not establish.
//
// Two traps. A window edge is not an onset: if the pattern was already running
// before `from`, the first line in the window marks where the window starts, and
// presenting it as "when this started" is the same class of error as reading a
// chronic pattern as incident impact. And on a sampled stream the first line
// that reached Loki need not be the first line written.
export function describeOnset({ firstTimeIso, windowStartIso, preWindowMinutes, preWindowLines, sampling } = {}) {
  const alreadyPresent = Number(preWindowLines) > 0;
  const parts = [];
  if (alreadyPresent) {
    parts.push(
      `Not an onset: ${preWindowLines} matching line(s) in the ${preWindowMinutes} minutes before the window ` +
        `(${windowStartIso}). The first line inside the window marks where the WINDOW starts, not where this ` +
        "started. Widen from to find the real first occurrence.",
    );
  } else if (preWindowLines === null || preWindowLines === undefined) {
    parts.push(
      `First matching line in the window: ${firstTimeIso}. The minutes before the window could not be checked, ` +
        "so this may not be the first occurrence overall.",
    );
  } else {
    parts.push(
      `First occurrence: ${firstTimeIso}, with none earlier in the window and none in the ${preWindowMinutes} ` +
        "minutes before it.",
    );
  }
  if (sampling) {
    parts.push(
      `Adaptive Logs is sampling these streams (${(sampling.label_values || []).join(", ")}): this is the earliest ` +
        "line that REACHED Loki. The true first occurrence can be earlier, and at low volume the first minutes are " +
        "the likeliest to be missing.",
    );
  }
  return { already_present_before_window: alreadyPresent, note: parts.join(" ") };
}

// Replace the counts of partial edge buckets with exact counts of the part inside
// the window. `exact` maps bucket time -> count, or null when the exact count
// could not be obtained — then the Loki count stays and is flagged as inexact
// rather than silently trusted.
export function applyEdgeCounts(buckets = [], exact = {}) {
  return buckets.map((b) => {
    if (!b.partial || !Object.prototype.hasOwnProperty.call(exact, b.time)) return b;
    const v = exact[b.time];
    if (v === null || v === undefined || !Number.isFinite(Number(v))) {
      return { ...b, partial: { ...b.partial, count_exact: false } };
    }
    return { ...b, count: Number(v), partial: { ...b.partial, count_exact: true } };
  });
}

// ---------------------------------------------------------------------------
// Who owns a broad result
// ---------------------------------------------------------------------------
//
// Sync errors on "126 namespaces across 10 clusters" read as a global problem.
// They were all data planes of 19 control planes — which own data planes in every
// region, so trouble on the control-plane side surfaces everywhere at once. A
// Gravitee Cloud data-plane namespace carries its control plane's id in its name
// (verified: every live apim-dp-* namespace has the shape, and every derived id
// has a live apim-cp-<id> namespace), so the spread can be rolled up to its owners
// exactly — no map lookup needed for the attribution itself.

const DATA_PLANE_NAMESPACE = /^apim-dp-((?:trial-)?[a-z0-9]+)-[a-z0-9]+$/;
export const OWNER_ROLLUP_MIN_NAMESPACES = 3;

export function controlPlaneOfNamespace(namespace) {
  const m = DATA_PLANE_NAMESPACE.exec(String(namespace || ""));
  return m ? m[1] : null;
}

// Per-namespace weight across EVERY frame of a raw payload. Built from the payload
// rather than the digest: the digest keeps 50 series, and a rollup over a
// truncated list would undercount exactly the broad results it exists for.
export function namespaceWeightsFromPayload(payload = {}) {
  const weights = new Map();
  const add = (labels, { series = 0, value = 0, lines = 0 }) => {
    const ns = labels?.namespace;
    if (!ns) return;
    const w = weights.get(ns) || { clusters: new Set(), series: 0, value: 0, lines: 0 };
    if (labels.cluster) w.clusters.add(labels.cluster);
    w.series += series;
    w.value += value;
    w.lines += lines;
    weights.set(ns, w);
  };
  for (const res of Object.values(payload.results || {})) {
    for (const frame of Array.isArray(res?.frames) ? res.frames : []) {
      const kind = classifyFrame(frame);
      const fields = frame?.schema?.fields || [];
      const values = frame?.data?.values || [];
      if (kind === "logs") {
        for (const labels of values[findField(fields, "labels")] || []) add(labels, { lines: 1 });
      } else if (kind !== "table") {
        for (let i = 0; i < fields.length; i++) {
          if (fields[i]?.type !== "number") continue;
          const nums = (values[i] || []).filter((v) => typeof v === "number");
          const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
          add(fields[i]?.labels, { series: 1, value: avg });
        }
      }
    }
  }
  return weights;
}

export function buildOwnerRollup(weights, { controlPlaneClusters = {}, customersByControlPlane = {}, limit = 20 } = {}) {
  const byCp = new Map();
  const dpClusters = new Set();
  let dpCount = 0;
  let other = 0;
  for (const [ns, w] of weights || []) {
    const cp = controlPlaneOfNamespace(ns);
    if (!cp) {
      other++;
      continue;
    }
    dpCount++;
    const e = byCp.get(cp) || { id: cp, dataPlanes: 0, clusters: new Set(), series: 0, value: 0, lines: 0 };
    e.dataPlanes++;
    for (const c of w.clusters) {
      e.clusters.add(c);
      dpClusters.add(c);
    }
    e.series += w.series;
    e.value += w.value;
    e.lines += w.lines;
    byCp.set(cp, e);
  }
  if (dpCount < OWNER_ROLLUP_MIN_NAMESPACES) return null;

  const weightOf = (r) => r.lines || r.value || 0;
  const rows = [...byCp.values()]
    .map((e) => {
      const cpNs = `apim-cp-${e.id}`;
      return {
        control_plane_id: e.id,
        control_plane_namespace: cpNs,
        control_plane_clusters: controlPlaneClusters[cpNs] || [],
        customers: customersByControlPlane[e.id] || [],
        data_planes: e.dataPlanes,
        data_plane_clusters: [...e.clusters].sort(),
        ...(e.series ? { series: e.series, value: Math.round(e.value * 1000) / 1000 } : {}),
        ...(e.lines ? { lines: e.lines } : {}),
      };
    })
    .sort((a, b) => weightOf(b) - weightOf(a) || b.data_planes - a.data_planes);

  const byCluster = new Map();
  for (const r of rows) {
    for (const c of r.control_plane_clusters.length ? r.control_plane_clusters : ["unknown"]) {
      const e = byCluster.get(c) || { cluster: c, control_planes: 0, data_planes: 0 };
      e.control_planes++;
      e.data_planes += r.data_planes;
      byCluster.set(c, e);
    }
  }
  const clusterRows = [...byCluster.values()].sort((a, b) => b.data_planes - a.data_planes);
  const known = clusterRows.filter((c) => c.cluster !== "unknown");

  let note =
    `${dpCount} data-plane namespace(s)${dpClusters.size ? ` across ${dpClusters.size} cluster(s)` : ""} ` +
    `belong to ${rows.length} control plane(s)`;
  if (known.length) {
    note += `, which run on ${known.length} cluster(s): ${known.slice(0, 5).map((c) => `${c.cluster} (${c.control_planes})`).join(", ")}`;
  }
  note += ".";
  if (known.length && dpClusters.size > known.length) {
    note +=
      " The result spreads across more data-plane clusters than its control planes run on. Data planes sync from " +
      "their control plane wherever they run, so check the control-plane side before reading this as a global problem.";
  }

  return {
    data_plane_namespaces: dpCount,
    ...(dpClusters.size ? { data_plane_clusters: dpClusters.size } : {}),
    control_planes: rows.length,
    by_control_plane: rows.slice(0, limit),
    ...(rows.length > limit ? { by_control_plane_truncated: rows.length - limit } : {}),
    by_control_plane_cluster: clusterRows,
    ...(other ? { other_namespaces: other } : {}),
    note,
  };
}

// ---------------------------------------------------------------------------
// Is it the application, or the node?
// ---------------------------------------------------------------------------
//
// The root cause of an incident only became clear once errors were grouped by
// pod and pods joined to nodes: every failing pod sat on one node, and sibling
// pods on other nodes were healthy. That took three manual queries across Loki
// and Prometheus. The verdict compares each node's share of matching lines with
// its share of pods — a node running most of the pods is expected to carry most
// of the errors, so error share alone would mislead.

export const TOPOLOGY_THRESHOLDS = Object.freeze({
  // The fewest nodes carrying at least this share of matching lines...
  concentratedErrorSharePct: 80,
  // ...run at most this share of the pods...
  concentratedMaxPodSharePct: 50,
  // ...carry at least this multiple of their pod share...
  concentratedMinRatio: 2,
  // ...and are at most this fraction of the nodes (always at least one).
  concentratedMaxNodeFraction: 0.25,
  // Otherwise: spread when the distributions of lines and pods over nodes
  // differ by less than this in total.
  spreadMaxDistancePct: 30,
});

export function buildFailureTopology({ errorRows = [], siblingPods = [], podInfo = [], maxNodes = 25, maxPodsPerNode = 20 } = {}) {
  // "|" cannot appear in a cluster, namespace, node or pod name.
  const key = (c, n, p) => `${c || ""}|${n || ""}|${p || ""}`;
  const loose = (n, p) => `${n || ""}|${p || ""}`;
  const pods = new Map();
  const touch = (m) => {
    if (!m?.pod) return null;
    const k = key(m.cluster, m.namespace, m.pod);
    let e = pods.get(k);
    if (!e) {
      e = { cluster: m.cluster || null, namespace: m.namespace || null, pod: m.pod, errors: 0, sampled: 0 };
      pods.set(k, e);
    }
    return e;
  };
  for (const s of siblingPods || []) touch(s);
  for (const r of errorRows || []) {
    const e = touch(r?.metric);
    const n = Number(r?.value?.[1]);
    if (!e || !Number.isFinite(n)) continue;
    e.errors += n;
    const sv = r.metric?.[ADAPTIVE_LOGS_LABEL];
    if (sv !== undefined && sv !== null && String(sv) !== "") e.sampled += n;
  }

  const info = new Map();
  const infoLoose = new Map();
  for (const m of podInfo || []) {
    if (!m?.pod || !m?.node) continue;
    info.set(key(m.cluster, m.namespace, m.pod), m);
    infoLoose.set(loose(m.namespace, m.pod), m);
  }

  const nodes = new Map();
  const withoutNode = [];
  let matching = 0;
  for (const p of pods.values()) {
    matching += p.errors;
    const m = info.get(key(p.cluster, p.namespace, p.pod)) || infoLoose.get(loose(p.namespace, p.pod));
    if (!m) {
      withoutNode.push(p);
      continue;
    }
    const nk = `${m.cluster || p.cluster || ""}|${m.node}`;
    const n = nodes.get(nk) || { node: m.node, host_ip: m.host_ip || null, cluster: m.cluster || p.cluster || null, pods: [], errors: 0 };
    n.pods.push(p);
    n.errors += p.errors;
    nodes.set(nk, n);
  }

  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const placedPods = [...nodes.values()].reduce((a, n) => a + n.pods.length, 0);
  const placedErrors = [...nodes.values()].reduce((a, n) => a + n.errors, 0);
  const ranked = [...nodes.values()]
    .map((n) => ({
      ...n,
      error_share_pct: pct(n.errors, placedErrors),
      pod_share_pct: pct(n.pods.length, placedPods),
      affected: n.pods.filter((p) => p.errors > 0).length,
    }))
    .sort((a, b) => b.errors - a.errors || b.pods.length - a.pods.length);

  const T = TOPOLOGY_THRESHOLDS;
  const erroring = [...pods.values()].filter((p) => p.errors > 0);
  const notes = [];
  let verdict;
  let concentration = null;
  let distance = null;
  if (!matching) {
    verdict = "no_errors";
    notes.push(`No matching lines on any of the ${pods.size} pod(s) in scope.`);
  } else if (!ranked.length) {
    verdict = "insufficient";
    notes.push("No pod could be placed on a node, so there is nothing to compare across nodes.");
  } else if (ranked.length === 1) {
    verdict = "single_node";
    notes.push(`Every placed pod runs on one node (${ranked[0].node}), so errors cannot be compared across nodes.`);
  } else {
    // How far the distribution of matching lines over nodes is from the
    // distribution of pods over nodes: half the summed absolute difference of
    // the shares (total variation distance), in percent. 0 means the errors
    // follow the pods exactly. Measured over the whole fleet because a per-node
    // gap cannot see concentration on several nodes: live, every "mongo" line
    // across 777 control-plane pods sat on 5 of 39 nodes, each only ~25 points
    // over its pod share — and a per-node check called that "spread".
    distance = Math.round((ranked.reduce((a, n) => a + Math.abs(n.error_share_pct - n.pod_share_pct), 0) / 2) * 10) / 10;

    // The fewest nodes that carry most of the matching lines, and how much of
    // the fleet they are.
    let k = 0;
    let lineShare = 0;
    let podShare = 0;
    for (const n of ranked) {
      if (lineShare >= T.concentratedErrorSharePct) break;
      k++;
      lineShare += n.error_share_pct;
      podShare += n.pod_share_pct;
    }
    lineShare = Math.round(lineShare * 10) / 10;
    podShare = Math.round(podShare * 10) / 10;
    const hot = ranked.slice(0, k);
    const cleanElsewhere = ranked.slice(k).reduce((a, n) => a + n.pods.filter((p) => p.errors === 0).length, 0);
    concentration = { nodes_carrying_most_lines: k, their_line_share_pct: lineShare, their_pod_share_pct: podShare };
    const maxNodes = Math.max(1, Math.floor(ranked.length * T.concentratedMaxNodeFraction));
    const concentrated =
      lineShare >= T.concentratedErrorSharePct &&
      podShare <= T.concentratedMaxPodSharePct &&
      podShare > 0 &&
      lineShare / podShare >= T.concentratedMinRatio &&
      k <= maxNodes &&
      cleanElsewhere > 0;

    if (concentrated && k === 1) {
      verdict = "node_concentrated";
      const top = hot[0];
      notes.push(
        `${top.error_share_pct}% of matching lines come from node ${top.node}, which runs ${top.pod_share_pct}% of the ` +
          `pods in scope (${top.affected} of its ${top.pods.length} affected), while ${cleanElsewhere} sibling pod(s) on ` +
          "other nodes have none. That points at the node rather than the application.",
      );
    } else if (concentrated) {
      verdict = "nodes_concentrated";
      const names = hot.slice(0, 5).map((n) => n.node).join(", ") + (k > 5 ? ", …" : "");
      notes.push(
        `${lineShare}% of matching lines come from ${k} of ${ranked.length} nodes (${names}), which run ${podShare}% of ` +
          `the pods in scope, while ${cleanElsewhere} sibling pod(s) on the other nodes have none. Concentrated on a ` +
          "few nodes: check what they share (a node pool, a zone, a recent roll) before reading this as the application.",
      );
    } else if (distance < T.spreadMaxDistancePct) {
      verdict = "spread";
      notes.push(
        `Matching lines follow the pods: across all ${ranked.length} nodes, where the lines are differs from where the ` +
          `pods are by ${distance}% in total (under ${T.spreadMaxDistancePct}%). Not node-specific.`,
      );
    } else {
      verdict = "uneven";
      notes.push(
        `Uneven across nodes (${distance}% total difference between where the lines are and where the pods are), but ` +
          `not concentrated enough to single out a node or a few: the ${k} busiest node(s) carry ${lineShare}% of ` +
          `matching lines with ${podShare}% of the pods.`,
      );
    }
  }

  const sampledErroring = erroring.filter((p) => p.sampled > 0);
  if (sampledErroring.length) {
    notes.push(
      `Adaptive Logs is sampling lines on ${sampledErroring.length} of ${erroring.length} erroring pod(s), so per-pod ` +
        "counts are lower bounds and not strictly comparable: a pod whose lines are not sampled can look worse than " +
        "a sampled sibling.",
    );
  }
  const unplacedErroring = withoutNode.filter((p) => p.errors > 0).length;
  if (withoutNode.length) {
    notes.push(
      `${withoutNode.length} pod(s) could not be placed on a node and are listed separately` +
        `${unplacedErroring ? `, ${unplacedErroring} of them with matching lines` : ""}.`,
    );
  }

  const podOut = (p) => ({
    ...(p.cluster ? { cluster: p.cluster } : {}),
    namespace: p.namespace,
    pod: p.pod,
    errors: p.errors,
    ...(p.sampled ? { sampled_errors: p.sampled } : {}),
  });
  const byPodErrors = (a, b) => b.errors - a.errors || String(a.pod).localeCompare(String(b.pod));
  return {
    verdict,
    note: notes.join(" "),
    pods_in_scope: pods.size,
    pods_with_errors: erroring.length,
    healthy_pods: pods.size - erroring.length,
    matching_lines: matching,
    nodes: ranked.length,
    nodes_with_errors: ranked.filter((n) => n.errors > 0).length,
    ...(distance !== null ? { distribution_distance_pct: distance } : {}),
    ...(concentration ? { concentration } : {}),
    by_node: ranked.slice(0, maxNodes).map((n) => ({
      node: n.node,
      host_ip: n.host_ip,
      cluster: n.cluster,
      pod_count: n.pods.length,
      pods_with_errors: n.affected,
      errors: n.errors,
      error_share_pct: n.error_share_pct,
      pod_share_pct: n.pod_share_pct,
      pods: [...n.pods].sort(byPodErrors).slice(0, maxPodsPerNode).map(podOut),
      ...(n.pods.length > maxPodsPerNode ? { pods_truncated: n.pods.length - maxPodsPerNode } : {}),
    })),
    ...(ranked.length > maxNodes ? { by_node_truncated: ranked.length - maxNodes } : {}),
    ...(withoutNode.length ? { pods_without_node: [...withoutNode].sort(byPodErrors).slice(0, 50).map(podOut) } : {}),
    ...(sampledErroring.length
      ? {
          sampling: {
            erroring_pods_with_sampled_lines: sampledErroring.length,
            erroring_pods: erroring.length,
            sampled_matching_lines: sampledErroring.reduce((a, p) => a + p.sampled, 0),
          },
        }
      : {}),
    thresholds: T,
  };
}

// ---------------------------------------------------------------------------
// Explore links
// ---------------------------------------------------------------------------
//
// Multi-query and split-pane Explore links had to be URL-encoded by hand during
// an incident. The format below was verified on the live instance (Grafana 13.3)
// by opening each shape and reading back the URL Grafana rewrote itself to:
// split panes keyed by any id, a pane holding queries for several datasources
// via the Mixed datasource, absolute epoch-millisecond ranges and relative ones.
// Grafana adds editor state of its own on load (editorMode, direction, compact);
// none of it is needed in the link.
//
// Time zone: Explore displays times in the VIEWER's preference and ignores a
// timezone parameter in the URL. Absolute epoch milliseconds are the same
// instant for every viewer, which is why links default to an absolute range —
// and a relative range pasted into a ticket shows a different window tomorrow.

export const MIXED_DATASOURCE_UID = "-- Mixed --";
// Explore's split view shows two panes.
export const EXPLORE_MAX_PANES = 2;

const refIdFor = (i) => (i < 26 ? String.fromCharCode(65 + i) : `Q${i + 1}`);

function exploreQuery(q, i) {
  const { type, uid } = q.datasource || {};
  if (!uid || !type) throw new Error(`query ${i + 1} needs a datasource uid and type`);
  const pinned = { refId: q.refId || refIdFor(i), datasource: { type, uid } };
  if (type === "loki") {
    if (!q.expr) throw new Error(`query ${i + 1} (loki) needs expr`);
    return { ...pinned, expr: q.expr, queryType: q.instant ? "instant" : "range" };
  }
  if (type === "prometheus") {
    if (!q.expr) throw new Error(`query ${i + 1} (prometheus) needs expr`);
    return { ...pinned, expr: q.expr, range: !q.instant, instant: Boolean(q.instant) };
  }
  if (!q.query || typeof q.query !== "object") {
    throw new Error(`query ${i + 1} (${type}) needs a native query object; expr is for Loki and Prometheus only`);
  }
  // Native fields first, so they cannot replace the refId or datasource.
  return { ...q.query, ...pinned };
}

export function buildExploreLink({ panes = [], from = "now-1h", to = "now", absolute = true, now = Date.now() } = {}) {
  if (!Array.isArray(panes) || !panes.length) throw new Error("at least one pane with at least one query is required");
  if (panes.length > EXPLORE_MAX_PANES) {
    throw new Error(`Explore's split view shows ${EXPLORE_MAX_PANES} panes; got ${panes.length}. Put more queries in a pane instead.`);
  }
  const win = resolvedWindow(from, to, 3600, now);
  if (!(win.end_ms > win.start_ms)) throw new Error("to must be after from");
  const range = absolute
    ? { from: String(Math.round(win.start_ms)), to: String(Math.round(win.end_ms)) }
    : { from: String(from), to: String(to) };

  const out = {};
  panes.forEach((pane, p) => {
    const queries = pane?.queries || [];
    if (!queries.length) throw new Error(`pane ${p + 1} has no queries`);
    const built = queries.map(exploreQuery);
    const uids = [...new Set(built.map((q) => q.datasource.uid))];
    out[`p${p + 1}`] = { datasource: uids.length === 1 ? uids[0] : MIXED_DATASOURCE_UID, queries: built, range };
  });

  return {
    url: `${BASE_URL}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(out))}`,
    panes: out,
    range,
    range_utc: `${win.from_utc} .. ${win.to_utc}`,
    absolute,
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";

// helpers.js imports BASE_URL from grafanaClient.js, which reads env at import
// time. Set a deterministic base url before importing so buildExploreUrl is
// predictable.
process.env.GRAFANA_BASE_URL = "https://g.example.com";

const {
  summarizeQueryResult,
  escapeRegex,
  buildLogsQuery,
  buildExploreUrl,
  buildDrilldownUrl,
  toLokiNs,
  editDistance,
  rankClientSuggestions,
} = await import("./helpers.js");

// ---------------------------------------------------------------------------
// summarizeQueryResult
// ---------------------------------------------------------------------------

// A minimal /ds/query payload: one refId, one frame, a time field + a number
// field carrying labels and values.
function frame(labels, values) {
  return {
    schema: {
      fields: [
        { type: "time" },
        { type: "number", labels },
      ],
    },
    data: { values: [values.map((_, i) => i), values] },
  };
}

test("summarizeQueryResult: collapses each series to labels + numeric digest", () => {
  const payload = { results: { A: { status: 200, frames: [frame({ job: "api" }, [2, 4, 6])] } } };
  const out = summarizeQueryResult(payload);
  assert.equal(out.results.A.status, 200);
  assert.equal(out.results.A.series_count, 1);
  assert.equal(out.results.A.truncated, 0);
  assert.deepEqual(out.results.A.series[0], {
    labels: { job: "api" },
    count: 3,
    first: 2,
    last: 6,
    min: 2,
    max: 6,
    avg: 4,
  });
});

test("summarizeQueryResult: empty series reports count 0 and no digest stats", () => {
  const payload = { results: { A: { status: 200, frames: [frame({}, [])] } } };
  const out = summarizeQueryResult(payload);
  assert.deepEqual(out.results.A.series[0], { labels: {}, count: 0 });
});

test("summarizeQueryResult: slices to maxSeries and reports truncated count", () => {
  const frames = Array.from({ length: 5 }, (_, i) => frame({ i: String(i) }, [i]));
  const out = summarizeQueryResult({ results: { A: { frames } } }, { maxSeries: 2 });
  // series_count is the total before slicing; the array is capped to maxSeries
  // and `truncated` carries how many were dropped.
  assert.equal(out.results.A.series_count, 5);
  assert.equal(out.results.A.series.length, 2);
  assert.equal(out.results.A.truncated, 3);
});

test("summarizeQueryResult: tolerates missing results / frames", () => {
  assert.deepEqual(summarizeQueryResult(), { results: {} });
  assert.deepEqual(summarizeQueryResult({ results: { A: {} } }).results.A, {
    status: null,
    series_count: 0,
    series: [],
    truncated: 0,
  });
});

// ---------------------------------------------------------------------------
// escapeRegex
// ---------------------------------------------------------------------------

test("escapeRegex: escapes regex metacharacters", () => {
  assert.equal(escapeRegex("a.b*c+"), "a\\.b\\*c\\+");
  assert.equal(escapeRegex("plain"), "plain");
});

// ---------------------------------------------------------------------------
// buildLogsQuery
// ---------------------------------------------------------------------------

test("buildLogsQuery: client only -> case-insensitive substring selector", () => {
  assert.equal(buildLogsQuery({ client: "april" }), '{service_name=~"(?i).*april.*"}');
});

test("buildLogsQuery: client + component join with .*", () => {
  assert.equal(
    buildLogsQuery({ client: "april", component: "gateway" }),
    '{service_name=~"(?i).*april.*gateway.*"}',
  );
});

test("buildLogsQuery: multi-word fragment joins words with .* (not a literal space)", () => {
  // `service_name` is dash-separated, so "april prod" must become april.*prod —
  // a literal space would never match `…-april-prod-…`. Note "prod" is an env
  // token, so it is anchored to a whole segment (see env-token test below).
  assert.equal(
    buildLogsQuery({ client: "april prod", component: "gateway" }),
    '{service_name=~"(?i).*april.*(?:^|[-_.])prod(?:[-_.]|$).*gateway.*"}',
  );
});

test("buildLogsQuery: anchors env tokens so 'prod' doesn't match 'nonprod'/'preprod'", () => {
  // 'prod' is anchored to a whole segment; a non-env word like 'april' stays a
  // plain substring (so partial customer names keep matching).
  const q = buildLogsQuery({ client: "april prod" });
  assert.equal(q, '{service_name=~"(?i).*april.*(?:^|[-_.])prod(?:[-_.]|$).*"}');
  // (?i) is Loki/Go inline-flag syntax; JS RegExp needs the literal stripped and
  // the "i" flag passed instead.
  const re = new RegExp(q.match(/service_name=~"(?:\(\?i\))?([^"]*)"/)[1], "i");
  assert.ok(re.test("graviteeio-am-april-prod-gateway"));
  assert.equal(re.test("graviteeio-am-april-nonprod-gateway"), false);
  assert.equal(re.test("graviteeio-am-april-preprod-gateway"), false);
});

test("buildLogsQuery: non-env partial words stay substrings (arcelor matches arcelor-mittal)", () => {
  const q = buildLogsQuery({ client: "arcelor" });
  const re = new RegExp(q.match(/service_name=~"(?:\(\?i\))?([^"]*)"/)[1], "i");
  assert.ok(re.test("graviteeio-apim-arcelor-mittal-prod-gateway"));
});

test("buildLogsQuery: collapses extra/leading/trailing whitespace in a fragment", () => {
  assert.equal(buildLogsQuery({ client: "  am   prod  " }), '{service_name=~"(?i).*am.*(?:^|[-_.])prod(?:[-_.]|$).*"}');
});

test("buildLogsQuery: escapes regex metachars in client/component", () => {
  assert.equal(buildLogsQuery({ client: "a.b" }), '{service_name=~"(?i).*a\\.b.*"}');
});

test("buildLogsQuery: line_filter appends a backtick line filter, stripping backticks", () => {
  assert.equal(
    buildLogsQuery({ client: "april", lineFilter: "error `x`" }),
    '{service_name=~"(?i).*april.*"} |= `error x`',
  );
});

test("buildLogsQuery: throws when client missing", () => {
  assert.throws(() => buildLogsQuery({}), /client is required/);
});

// ---------------------------------------------------------------------------
// buildExploreUrl
// ---------------------------------------------------------------------------

test("buildExploreUrl: builds a Grafana 11+ panes deep link", () => {
  const url = buildExploreUrl({
    datasourceUid: "grafanacloud-logs",
    query: '{service_name=~"(?i).*april.*"}',
    from: "now-1h",
    to: "now",
  });
  assert.ok(url.startsWith("https://g.example.com/explore?schemaVersion=1&orgId=1&panes="));
  // Legacy <=10 form must not be emitted.
  assert.equal(url.includes("left="), false);
  const panes = JSON.parse(decodeURIComponent(new URL(url).searchParams.get("panes")));
  assert.deepEqual(panes.logs.range, { from: "now-1h", to: "now" });
  assert.equal(panes.logs.datasource, "grafanacloud-logs");
  assert.equal(panes.logs.queries[0].datasource.type, "loki");
  assert.equal(panes.logs.queries[0].expr, '{service_name=~"(?i).*april.*"}');
});

// ---------------------------------------------------------------------------
// buildDrilldownUrl
// ---------------------------------------------------------------------------

test("buildDrilldownUrl: single service_name -> exact (=) filter", () => {
  const url = buildDrilldownUrl({
    namespace: "april-prod",
    serviceNames: ["graviteeio-apim-april-prod-gateway"],
    from: "now-1h",
    to: "now",
  });
  assert.ok(url.startsWith("https://g.example.com/a/grafana-lokiexplore-app/explore/namespace/april-prod/logs?"));
  const params = new URL(url).searchParams;
  assert.equal(params.get("var-ds"), "grafanacloud-logs");
  assert.equal(params.get("visualizationType"), '"logs"');
  // namespace pin + exact service_name match (NOT a raw LogQL regex, which the
  // app treats as a literal).
  assert.deepEqual(params.getAll("var-filters"), [
    "namespace|=|april-prod",
    "service_name|=|graviteeio-apim-april-prod-gateway",
  ]);
});

test("buildDrilldownUrl: multiple service_names -> escaped =~ alternation", () => {
  const url = buildDrilldownUrl({
    namespace: "apim-dp-ba813-a200c4",
    serviceNames: ["prod-apim-dp-ba813-a200c4-gateway", "prod-apim-dp-ba813-8123e2-gateway"],
    from: "now-1h",
    to: "now",
  });
  // Hyphens aren't regex metachars (outside a char class), so they're left as-is.
  assert.deepEqual(new URL(url).searchParams.getAll("var-filters"), [
    "namespace|=|apim-dp-ba813-a200c4",
    "service_name|=~|prod-apim-dp-ba813-a200c4-gateway|prod-apim-dp-ba813-8123e2-gateway",
  ]);
});

test("buildDrilldownUrl: omits the service_name filter when none given", () => {
  const url = buildDrilldownUrl({ namespace: "apim-cp-ba813", from: "now-15m", to: "now" });
  assert.deepEqual(new URL(url).searchParams.getAll("var-filters"), ["namespace|=|apim-cp-ba813"]);
});

test("buildDrilldownUrl: de-duplicates service_names", () => {
  const url = buildDrilldownUrl({
    namespace: "april-prod",
    serviceNames: ["svc-a", "svc-a"],
    from: "now-1h",
    to: "now",
  });
  assert.deepEqual(new URL(url).searchParams.getAll("var-filters"), ["namespace|=|april-prod", "service_name|=|svc-a"]);
});

test("buildDrilldownUrl: throws when namespace missing", () => {
  assert.throws(() => buildDrilldownUrl({ from: "now-1h", to: "now" }), /namespace is required/);
});

// ---------------------------------------------------------------------------
// toLokiNs
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed epoch ms

test("toLokiNs: empty value falls back to now - fallbackSecondsAgo, in ns", () => {
  assert.equal(toLokiNs("", 3600, NOW), `${(NOW - 3600 * 1000) * 1e6}`);
  assert.equal(toLokiNs(undefined, 0, NOW), `${NOW * 1e6}`);
});

test("toLokiNs: 'now' resolves to now in ns", () => {
  assert.equal(toLokiNs("now", 0, NOW), `${NOW * 1e6}`);
});

test("toLokiNs: 'now-15m' subtracts the relative amount", () => {
  assert.equal(toLokiNs("now-15m", 0, NOW), `${(NOW - 15 * 60000) * 1e6}`);
  assert.equal(toLokiNs("now-2h", 0, NOW), `${(NOW - 2 * 3_600_000) * 1e6}`);
  assert.equal(toLokiNs("now-1d", 0, NOW), `${(NOW - 86_400_000) * 1e6}`);
});

test("toLokiNs: epoch ms passes through (converted to ns)", () => {
  assert.equal(toLokiNs(NOW, 0, NOW), `${NOW * 1e6}`);
  assert.equal(toLokiNs(String(NOW), 0, NOW), `${NOW * 1e6}`);
});

test("toLokiNs: unparseable value falls back", () => {
  assert.equal(toLokiNs("garbage", 60, NOW), `${(NOW - 60 * 1000) * 1e6}`);
});

// ---------------------------------------------------------------------------
// editDistance
// ---------------------------------------------------------------------------

test("editDistance: basic Levenshtein cases", () => {
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("abc", ""), 3);
  assert.equal(editDistance("april", "april"), 0);
  assert.equal(editDistance("aprl", "april"), 1);
  assert.equal(editDistance("kitten", "sitting"), 3);
});

// ---------------------------------------------------------------------------
// rankClientSuggestions
// ---------------------------------------------------------------------------

const VALUES = [
  "graviteeio-ae-april-rec-engine",
  "dev-apim-cloudgate-1ca08d-gateway",
  "graviteeio-ae-alliander-ui",
];

test("rankClientSuggestions: substring matches rank first", () => {
  const out = rankClientSuggestions(VALUES, "april");
  assert.equal(out[0], "graviteeio-ae-april-rec-engine");
});

test("rankClientSuggestions: close typo surfaces via segment edit distance", () => {
  // 'aprl' is edit distance 1 from the 'april' segment.
  const out = rankClientSuggestions(VALUES, "aprl");
  assert.ok(out.includes("graviteeio-ae-april-rec-engine"));
});

test("rankClientSuggestions: empty needle returns nothing", () => {
  assert.deepEqual(rankClientSuggestions(VALUES, ""), []);
});

test("rankClientSuggestions: de-duplicates and caps at 10", () => {
  const many = Array.from({ length: 25 }, (_, i) => `svc-april-${i}`);
  const out = rankClientSuggestions([...many, ...many], "april");
  assert.equal(out.length, 10);
  assert.equal(new Set(out).size, out.length);
});

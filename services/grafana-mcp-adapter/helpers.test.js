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
  buildExactLogsQuery,
  buildExploreUrl,
  buildDrilldownUrl,
  buildLineFilterToken,
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

test("summarizeQueryResult: digests a large series without overflowing the stack", () => {
  // A wide metric query can return 100k+ points. min/max must NOT be computed via
  // Math.min(...values) — spreading that many args throws a RangeError.
  const N = 200000;
  const values = Array.from({ length: N }, (_, i) => i);
  const out = summarizeQueryResult({ results: { A: { frames: [frame({}, values)] } } });
  const d = out.results.A.series[0];
  assert.equal(d.count, N);
  assert.equal(d.min, 0);
  assert.equal(d.max, N - 1);
  assert.equal(d.first, 0);
  assert.equal(d.last, N - 1);
  assert.equal(d.avg, (N - 1) / 2);
});

test("summarizeQueryResult: wide frame emits one digest per numeric field", () => {
  // A single Grafana frame can carry several numeric fields (one per series).
  // Every numeric field must produce its own digest — not just the first.
  const wide = {
    schema: {
      fields: [
        { type: "time" },
        { type: "number", labels: { series: "a" } },
        { type: "number", labels: { series: "b" } },
      ],
    },
    data: { values: [[0, 1, 2], [2, 4, 6], [10, 20, 30]] },
  };
  const out = summarizeQueryResult({ results: { A: { status: 200, frames: [wide] } } });
  assert.equal(out.results.A.series_count, 2);
  assert.deepEqual(out.results.A.series[0], {
    labels: { series: "a" }, count: 3, first: 2, last: 6, min: 2, max: 6, avg: 4,
  });
  assert.deepEqual(out.results.A.series[1], {
    labels: { series: "b" }, count: 3, first: 10, last: 30, min: 10, max: 30, avg: 20,
  });
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

// Without pinned namespaces the selector searches service_name outside Gravitee
// Cloud namespaces.
const OUTSIDE_CLOUD = 'namespace!~"(?i)apim-(dp|cp)-.+"';
const unpinned = (serviceName) => `{${OUTSIDE_CLOUD}, ${serviceName}}`;

test("buildLogsQuery: client only -> case-insensitive substring selector", () => {
  assert.equal(buildLogsQuery({ client: "kestrel" }), unpinned('service_name=~"(?i).*kestrel.*"'));
});

test("buildLogsQuery: without pinned namespaces, Gravitee Cloud namespaces are left out", () => {
  // Regression: "cp11" named no customer, and {service_name=~"(?i).*cp11.*"}
  // reached the shared apim-cp-cp1111 and data planes of two customers through
  // the ids in their service names (prod-apim-dp-cp1111-dp0001-gateway).
  const q = buildLogsQuery({ client: "cp11" });
  assert.equal(q, unpinned('service_name=~"(?i).*cp11.*"'));
  // Pinned namespaces were chosen by the resolver, Cloud ones included: no exclusion.
  assert.equal(
    buildLogsQuery({ client: "acme", namespaces: ["apim-dp-cp1111-dp0001"] }),
    '{namespace=~"^apim-dp-cp1111-dp0001$"}',
  );
});

test("buildLogsQuery: client + component join with .*", () => {
  assert.equal(
    buildLogsQuery({ client: "kestrel", component: "gateway" }),
    unpinned('service_name=~"(?i).*kestrel.*gateway.*"'),
  );
});

test("buildLogsQuery: multi-word fragment joins words with .* (not a literal space)", () => {
  // `service_name` is dash-separated, so "kestrel prod" must become kestrel.*prod —
  // a literal space would never match `…-kestrel-prod-…`. Note "prod" is an env
  // token, so it is anchored to a whole segment (see env-token test below).
  assert.equal(
    buildLogsQuery({ client: "kestrel prod", component: "gateway" }),
    unpinned('service_name=~"(?i).*kestrel.*(?:^|[-_.])prod(?:[-_.]|$).*gateway.*"'),
  );
});

test("buildLogsQuery: anchors env tokens so 'prod' doesn't match 'nonprod'/'preprod'", () => {
  // 'prod' is anchored to a whole segment; a non-env word like 'kestrel' stays a
  // plain substring (so partial customer names keep matching).
  const q = buildLogsQuery({ client: "kestrel prod" });
  assert.equal(q, unpinned('service_name=~"(?i).*kestrel.*(?:^|[-_.])prod(?:[-_.]|$).*"'));
  // (?i) is Loki/Go inline-flag syntax; JS RegExp needs the literal stripped and
  // the "i" flag passed instead.
  const re = new RegExp(q.match(/service_name=~"(?:\(\?i\))?([^"]*)"/)[1], "i");
  assert.ok(re.test("graviteeio-am-kestrel-prod-gateway"));
  assert.equal(re.test("graviteeio-am-kestrel-nonprod-gateway"), false);
  assert.equal(re.test("graviteeio-am-kestrel-preprod-gateway"), false);
});

test("buildLogsQuery: non-env partial words stay substrings (arcelor matches arcelor-mittal)", () => {
  const q = buildLogsQuery({ client: "arcelor" });
  const re = new RegExp(q.match(/service_name=~"(?:\(\?i\))?([^"]*)"/)[1], "i");
  assert.ok(re.test("graviteeio-apim-arcelor-mittal-prod-gateway"));
});

test("buildLogsQuery: collapses extra/leading/trailing whitespace in a fragment", () => {
  assert.equal(
    buildLogsQuery({ client: "  am   prod  " }),
    unpinned('service_name=~"(?i).*am.*(?:^|[-_.])prod(?:[-_.]|$).*"'),
  );
});

test("buildLogsQuery: escapes regex metachars in client/component", () => {
  assert.equal(buildLogsQuery({ client: "a.b" }), unpinned('service_name=~"(?i).*a\\.b.*"'));
});

test("buildLogsQuery: line_filter appends a backtick line filter, stripping backticks", () => {
  assert.equal(
    buildLogsQuery({ client: "kestrel", lineFilter: "error `x`" }),
    `${unpinned('service_name=~"(?i).*kestrel.*"')} |= \`error x\``,
  );
});

test("buildLogsQuery: throws when client missing", () => {
  assert.throws(() => buildLogsQuery({}), /client is required/);
});

test("buildLogsQuery: a blank client throws instead of matching every stream", () => {
  assert.throws(() => buildLogsQuery({ client: "   " }), /client is required/);
  assert.throws(() => buildLogsQuery({ client: " \t ", component: "gateway" }), /client is required/);
});

test("buildLogsQuery: a pinned namespace carries the environment, so service_name does not repeat it", () => {
  // The namespaces were chosen from the whole phrase (or from the map with the
  // env filter already applied), so repeating the env against service_name only
  // removes results: customers who call production `plt-live` or `multitenant`
  // returned nothing for `prod` while logging happily.
  assert.equal(
    buildLogsQuery({ client: "orbit prod", component: "gateway", namespaces: ["orbit-plt-live"] }),
    '{namespace=~"^orbit-plt-live$", service_name=~"(?i).*gateway.*"}',
  );
  assert.equal(
    buildLogsQuery({ client: "orbit prod", namespaces: ["orbit-plt-live"] }),
    '{namespace=~"^orbit-plt-live$"}',
  );
  // Unpinned, the client text still has to do the work against service_name.
  assert.match(buildLogsQuery({ client: "orbit prod" }), /service_name=~"\(\?i\).*orbit/);
});

test("buildLogsQuery: multiple namespaces -> anchored alternation", () => {
  assert.equal(
    buildLogsQuery({ client: "april", namespaces: ["april-prod", "april-rec"] }),
    '{namespace=~"^april-prod$|^april-rec$"}',
  );
});

test("buildLogsQuery: namespace-pinned, no component/env -> service_name matcher omitted", () => {
  // Nothing left to narrow by inside the namespace: emit only the namespace pin,
  // not an empty `service_name=~"(?i).*.*"`.
  assert.equal(buildLogsQuery({ client: "april", namespaces: ["april-prod"] }), '{namespace=~"^april-prod$"}');
});

// ---------------------------------------------------------------------------
// buildExactLogsQuery
// ---------------------------------------------------------------------------

test("buildExactLogsQuery: single service_name -> exact `=` matchers", () => {
  assert.equal(
    buildExactLogsQuery({ namespace: "ghd-prod", serviceNames: ["graviteeio-apim3-gateway"] }),
    '{namespace="ghd-prod", service_name="graviteeio-apim3-gateway"}',
  );
});

test("buildExactLogsQuery: multiple service_names -> `=~` alternation, regex-escaped", () => {
  assert.equal(
    buildExactLogsQuery({
      namespace: "ghd-prod",
      serviceNames: ["graviteeio-apim-ghd-prod-apim3-gateway", "graviteeio-apim3-gateway"],
    }),
    '{namespace="ghd-prod", service_name=~"graviteeio-apim-ghd-prod-apim3-gateway|graviteeio-apim3-gateway"}',
  );
});

test("buildExactLogsQuery: line_filter appends a backtick `|=` filter, stripping backticks", () => {
  assert.equal(
    buildExactLogsQuery({
      namespace: "ghd-prod",
      serviceNames: ["graviteeio-apim3-gateway"],
      lineFilter: "ConnectTimeoutException",
    }),
    '{namespace="ghd-prod", service_name="graviteeio-apim3-gateway"} |= `ConnectTimeoutException`',
  );
});

test("buildExactLogsQuery: no service_names -> namespace-only selector", () => {
  assert.equal(buildExactLogsQuery({ namespace: "ghd-prod" }), '{namespace="ghd-prod"}');
});

test("buildExactLogsQuery: dedupes service_names", () => {
  assert.equal(
    buildExactLogsQuery({ namespace: "ghd-prod", serviceNames: ["a", "a"] }),
    '{namespace="ghd-prod", service_name="a"}',
  );
});

test("buildExactLogsQuery: throws when namespace missing", () => {
  assert.throws(() => buildExactLogsQuery({ serviceNames: ["a"] }), /namespace is required/);
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
    datasourceUid: "logs-uid",
    namespace: "april-prod",
    serviceNames: ["graviteeio-apim-april-prod-gateway"],
    from: "now-1h",
    to: "now",
  });
  assert.ok(url.startsWith("https://g.example.com/a/grafana-lokiexplore-app/explore/namespace/april-prod/logs?"));
  const params = new URL(url).searchParams;
  assert.equal(params.get("var-ds"), "logs-uid");
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
    datasourceUid: "logs-uid",
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
  const url = buildDrilldownUrl({ datasourceUid: "logs-uid", namespace: "apim-cp-cp8888", from: "now-15m", to: "now" });
  assert.deepEqual(new URL(url).searchParams.getAll("var-filters"), ["namespace|=|apim-cp-cp8888"]);
});

test("buildDrilldownUrl: de-duplicates service_names", () => {
  const url = buildDrilldownUrl({
    datasourceUid: "logs-uid",
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

test("buildDrilldownUrl and buildExploreUrl: no link without a datasource uid", () => {
  // Regression: buildDrilldownUrl filled in "grafanacloud-logs", a uid right for
  // one Grafana org only, and buildExploreUrl left the datasource out, which
  // opens the viewer's default one. Either way, a plausible link to the wrong logs.
  for (const datasourceUid of [undefined, ""]) {
    assert.throws(
      () => buildDrilldownUrl({ namespace: "orbit-prod", datasourceUid, from: "now-1h", to: "now" }),
      /datasourceUid is required/,
    );
    assert.throws(() => buildExploreUrl({ datasourceUid, query: "{}", from: "now-1h", to: "now" }), /datasourceUid is required/);
  }
});

test("buildDrilldownUrl: line filter populates var-lineFilters, V2 stays empty", () => {
  const url = buildDrilldownUrl({
    datasourceUid: "logs-uid",
    namespace: "sedex-prod",
    serviceNames: ["sedex-prod-gateway"],
    from: "now-7d",
    to: "now",
    lineFilter: "An error occurs during user authentication",
  });
  const params = new URL(url).searchParams;
  // key|operator|value, app's exact format: caseSensitive,0 + escaped `|=`.
  assert.equal(
    params.get("var-lineFilters"),
    "caseSensitive,0|__gfp__=|An error occurs during user authentication"
  );
  // The in-progress single-filter var stays empty (matches the app's own links).
  assert.equal(params.get("var-lineFilterV2"), "");
  // Spaces must be percent/plus-encoded in the raw URL, never literal.
  assert.ok(!/var-lineFilters=[^&]* /.test(url));
});

test("buildDrilldownUrl: no line filter leaves var-lineFilters empty", () => {
  const url = buildDrilldownUrl({ datasourceUid: "logs-uid", namespace: "harbor-prod", from: "now-1h", to: "now" });
  assert.equal(new URL(url).searchParams.get("var-lineFilters"), "");
});

// ---------------------------------------------------------------------------
// buildLineFilterToken
// ---------------------------------------------------------------------------

test("buildLineFilterToken: empty -> empty string", () => {
  assert.equal(buildLineFilterToken(""), "");
  assert.equal(buildLineFilterToken(undefined), "");
});

test("buildLineFilterToken: plain substring", () => {
  assert.equal(buildLineFilterToken("boom"), "caseSensitive,0|__gfp__=|boom");
});

test("buildLineFilterToken: escapes structural delimiters in the value", () => {
  // A `|` or `,` in the text would otherwise be read as a part/filter separator.
  assert.equal(buildLineFilterToken("a|b,c"), "caseSensitive,0|__gfp__=|a__gfp__b__gfc__c");
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

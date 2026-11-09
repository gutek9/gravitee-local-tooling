import { test } from "node:test";
import assert from "node:assert/strict";

// helpers.js imports BASE_URL from grafanaClient.js, which reads env at import
// time. Set a deterministic base url before importing so buildExploreUrl is
// predictable.
process.env.GRAFANA_BASE_URL = "https://g.example.com";

const {
  summarizeQueryResult,
  isLogFrame,
  classifyFrame,
  requireDatasourceUid,
  durationSeconds,
  chooseInterval,
  buildTrendBuckets,
  summarizeTrend,
  summarizePatterns,
  escapeRegex,
  buildLogsQuery,
  buildExactLogsQuery,
  buildExploreUrl,
  buildDrilldownUrl,
  buildLineFilterToken,
  lineFilterExpr,
  toLokiNs,
  resolvedWindow,
  coverageVerdict,
  statusFilterExpr,
  buildIngressQuery,
  detectSampling,
  scopeNote,
  INGRESS_JOB,
  NGINX_PATTERN,
  INGRESS_JOBS,
  ingressJobs,
  UPSTREAM_TAIL_REGEXP,
  unwrapNumeric,
  parseAccessLogLine,
  applySamplingToCoverage,
  extractStreamSelector,
  queryIntervalMs,
  timelineFromPayload,
  samplingFromGroupedCounts,
  collapseSampledMatrix,
  aggregateUpstreamAttempts,
  rollupByNode,
  parseCompareOffset,
  compareValues,
  describeChange,
  attachBaselineBuckets,
  compareQueryDigests,
  attachBaselineTimeline,
  earliestLine,
  describeOnset,
  BUCKET_COVERS_NOTE,
  applyEdgeCounts,
  controlPlaneOfNamespace,
  namespaceWeightsFromPayload,
  buildOwnerRollup,
  buildFailureTopology,
  buildExploreLink,
  MIXED_DATASOURCE_UID,
  mergeContextStreams,
  normaliseLogLine,
  profileNoise,
  suggestExclusion,
  editDistance,
  rankClientSuggestions,
  splitClientEnv,
  matchNamespaces,
  matchNamespacesPhrase,
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
// summarizeQueryResult — Loki log frames
// ---------------------------------------------------------------------------

// A Loki log frame exactly as Grafana's /ds/query returns it: frameType
// `LabeledTimeValues`, and fields labels/Time/Line/tsNs/labelTypes/id. The
// point of this fixture is that NOT ONE of those fields has type "number" —
// the numeric digest path skips all of them, so without log handling this
// frame reports `series_count: 0` for a query that matched every line.
function logFrame(rows, { stats } = {}) {
  return {
    schema: {
      refId: "A",
      meta: {
        custom: { frameType: "LabeledTimeValues" },
        ...(stats ? { stats } : {}),
      },
      fields: [
        { name: "labels", type: "other" },
        { name: "Time", type: "time" },
        { name: "Line", type: "string" },
        { name: "tsNs", type: "string" },
        { name: "labelTypes", type: "other" },
        { name: "id", type: "string" },
      ],
    },
    data: {
      values: [
        rows.map((r) => r.labels),
        rows.map((r) => r.time),
        rows.map((r) => r.line),
        rows.map((r) => String(r.time * 1e6)),
        rows.map(() => ({})),
        rows.map((r) => `${r.time}_x`),
      ],
    },
  };
}

const NS = { namespace: "demo-qa", service_name: "apim-api" };

test("summarizeQueryResult: log frames are counted, not silently dropped", () => {
  // Regression: log fields are string/time/other, never number. The numeric
  // path skips every field, so this used to report series_count 0 — a false
  // "no matches" for a query that matched three lines.
  const payload = {
    results: {
      A: {
        status: 200,
        frames: [
          logFrame([
            { labels: NS, time: 1700000002000, line: "boom c" },
            { labels: NS, time: 1700000001000, line: "boom b" },
            { labels: NS, time: 1700000000000, line: "boom a" },
          ]),
        ],
      },
    },
  };
  const out = summarizeQueryResult(payload);
  assert.equal(out.results.A.frame_type, "logs");
  assert.equal(out.results.A.line_count, 3);
  assert.notEqual(out.results.A.line_count, 0);
});

test("summarizeQueryResult: log digest reports time range, streams and a sample", () => {
  const other = { namespace: "demo-qa", service_name: "apim-gateway" };
  const out = summarizeQueryResult({
    results: {
      A: {
        status: 200,
        frames: [
          logFrame([
            { labels: NS, time: 1700000002000, line: "newest" },
            { labels: other, time: 1700000001000, line: "middle" },
            { labels: NS, time: 1700000000000, line: "oldest" },
          ]),
        ],
      },
    },
  });
  const r = out.results.A;
  assert.equal(r.line_count, 3);
  // Range spans oldest..newest regardless of the order rows arrive in.
  assert.equal(r.time_range.from, "2023-11-14T22:13:20.000Z");
  assert.equal(r.time_range.to, "2023-11-14T22:13:22.000Z");
  // Two distinct label sets, ordered by line count (busiest stream first).
  assert.equal(r.stream_count, 2);
  assert.deepEqual(r.streams[0], { labels: NS, lines: 2 });
  assert.deepEqual(r.streams[1], { labels: other, lines: 1 });
  assert.equal(r.streams_truncated, 0);
  // Sample keeps frame order (Loki returns newest first).
  // Three distinct kinds, so three entries, each seen once.
  assert.deepEqual(r.sample_lines.map((s) => s.line), ["newest", "middle", "oldest"]);
  assert.deepEqual(r.sample_lines.map((s) => s.occurrences), [1, 1, 1]);
  assert.equal(r.distinct_line_kinds, 3);
  // Each sample carries its instant, so a caller can hand one straight to
  // grafana_logs_context to read what surrounded it.
  assert.equal(r.sample_lines[0].time, "2023-11-14T22:13:22.000Z");
  assert.equal(r.sample_kinds_truncated, 0);
});

test("summarizeQueryResult: repeated lines collapse to one entry with a count", () => {
  // The reason for deduplicating: twenty lines differing only by a number are
  // ONE kind of event. Showing twenty (or the first three) says no more than
  // showing one, while costing twenty times the customer log content.
  const rows = Array.from({ length: 20 }, (_, i) => ({ labels: NS, time: 1700000000000 + i, line: `line ${i}` }));
  const out = summarizeQueryResult({ results: { A: { frames: [logFrame(rows)] } } }, { maxSampleLines: 3 });
  const r = out.results.A;
  assert.equal(r.line_count, 20, "the true line count is unaffected");
  assert.equal(r.distinct_line_kinds, 1);
  assert.equal(r.sample_lines.length, 1);
  assert.equal(r.sample_lines[0].occurrences, 20);
  assert.equal(r.sample_kinds_truncated, 0);
});

test("summarizeQueryResult: distinct kinds are ranked, and the list is capped", () => {
  // Genuinely different messages must not be collapsed into each other, and the
  // commonest kind should lead.
  const rows = [
    ...Array.from({ length: 5 }, () => ({ labels: NS, time: 1700000000000, line: "connection refused" })),
    ...Array.from({ length: 2 }, () => ({ labels: NS, time: 1700000000000, line: "timeout waiting for upstream" })),
    { labels: NS, time: 1700000000000, line: "a rare and interesting failure" },
  ];
  const out = summarizeQueryResult({ results: { A: { frames: [logFrame(rows)] } } }, { maxSampleLines: 2 });
  const r = out.results.A;
  assert.equal(r.line_count, 8);
  assert.equal(r.distinct_line_kinds, 3);
  assert.deepEqual(r.sample_lines.map((s) => s.occurrences), [5, 2]);
  assert.equal(r.sample_lines[0].line, "connection refused");
  assert.equal(r.sample_kinds_truncated, 1, "the rare kind was dropped by the cap - and said so");
});

test("summarizeQueryResult: an over-long log line is clipped, not passed through whole", () => {
  const rows = [{ labels: NS, time: 1700000000000, line: "x".repeat(1000) }];
  const out = summarizeQueryResult({ results: { A: { frames: [logFrame(rows)] } } }, { maxLineChars: 10 });
  assert.equal(out.results.A.sample_lines[0].line, "xxxxxxxxxx\u2026[truncated]");
});

test("summarizeQueryResult: reaching the requested line cap is reported as partial", () => {
  // The cap is the whole reason a caller can be misled: 100 lines back from a
  // 100-line limit means "at least 100", never "exactly 100".
  const rows = Array.from({ length: 5 }, (_, i) => ({ labels: NS, time: 1700000000000 + i, line: `l${i}` }));
  const out = summarizeQueryResult({ results: { A: { frames: [logFrame(rows)] } } }, { limit: 5 });
  assert.equal(out.results.A.limit_reached, true);
  assert.match(out.results.A.note, /max_lines/);
});

test("summarizeQueryResult: staying under the line cap is not flagged as partial", () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ labels: NS, time: 1700000000000 + i, line: `l${i}` }));
  const out = summarizeQueryResult({ results: { A: { frames: [logFrame(rows)] } } }, { limit: 5 });
  assert.equal(out.results.A.limit_reached, undefined);
  assert.equal(out.results.A.note, undefined);
});

test("summarizeQueryResult: surfaces Loki stats without passing them off as a match count", () => {
  const out = summarizeQueryResult({
    results: {
      A: {
        frames: [
          logFrame([{ labels: NS, time: 1700000000000, line: "one" }], {
            stats: [
              { displayName: "Summary: total lines processed", value: 70986 },
              { displayName: "Summary: total bytes processed", value: 14584743 },
              { displayName: "Summary: exec time", value: 0.021639 },
            ],
          }),
        ],
      },
    },
  });
  // lines_processed is how much Loki READ, not how much matched. The match
  // count stays line_count; conflating the two would overstate results ~70000x.
  assert.equal(out.results.A.stats.lines_processed, 70986);
  assert.equal(out.results.A.line_count, 1);
});

test("summarizeQueryResult: a pure log result omits the numeric keys entirely", () => {
  // `series_count: 0` next to a real line_count reads as "nothing found" — the
  // same misleading zero the log digest exists to remove.
  const out = summarizeQueryResult({
    results: { A: { frames: [logFrame([{ labels: NS, time: 1700000000000, line: "a" }])] } },
  });
  assert.equal(out.results.A.line_count, 1);
  assert.equal(out.results.A.series_count, undefined);
  assert.equal(out.results.A.series, undefined);
  assert.equal(out.results.A.truncated, undefined);
});

test("summarizeQueryResult: a result with both frame kinds keeps both digests", () => {
  const out = summarizeQueryResult({
    results: {
      A: {
        frames: [logFrame([{ labels: NS, time: 1700000000000, line: "a" }]), frame({ job: "api" }, [1, 3])],
      },
    },
  });
  assert.equal(out.results.A.line_count, 1);
  assert.equal(out.results.A.series_count, 1);
});

test("summarizeQueryResult: metric frames keep the numeric digest and gain no log keys", () => {
  const out = summarizeQueryResult({ results: { A: { status: 200, frames: [frame({ job: "api" }, [1, 3])] } } });
  assert.equal(out.results.A.series_count, 1);
  assert.equal(out.results.A.frame_type, undefined);
  assert.equal(out.results.A.line_count, undefined);
});

test("isLogFrame: detects by frameType, and falls back to the Line field", () => {
  assert.equal(isLogFrame(logFrame([])), true);
  // No frameType meta, but a Line string field -> still a log frame.
  assert.equal(
    isLogFrame({ schema: { fields: [{ name: "Time", type: "time" }, { name: "Line", type: "string" }] } }),
    true,
  );
  assert.equal(isLogFrame(frame({}, [1])), false);
  assert.equal(isLogFrame(undefined), false);
});

// ---------------------------------------------------------------------------
// classifyFrame / table digest (Tempo traces, Elasticsearch raw documents)
// ---------------------------------------------------------------------------

// Shapes captured from the live instance.
const PROM_FRAME = { schema: { meta: { type: "timeseries-multi" }, fields: [{ name: "Time", type: "time" }, { name: "up", type: "number", labels: { job: "api" } }] }, data: { values: [[0], [1]] } };
const ES_AGG_FRAME = { schema: { meta: { type: "timeseries-multi" }, fields: [{ name: "Time", type: "time" }, { name: "Value", type: "number" }] }, data: { values: [[0], [7]] } };

function tempoFrame(rows) {
  return {
    schema: {
      meta: { preferredVisualisationType: "table" },
      fields: [
        { name: "traceID", type: "string" },
        { name: "startTime", type: "time" },
        { name: "traceName", type: "string" },
        { name: "traceDuration", type: "number" },
        { name: "nested", type: "other" },
      ],
    },
    data: {
      values: [
        rows.map((r) => r.id),
        rows.map((r) => r.start),
        rows.map((r) => r.name),
        rows.map((r) => r.duration),
        rows.map(() => ({ deep: true })),
      ],
    },
  };
}

test("classifyFrame: a numeric table with no time axis is a table, not a series", () => {
  // Elasticsearch terms aggregations return `status` + `Count`, both numeric and
  // no time field. Treated as a series this yields the min/max/avg of HTTP status
  // codes — arithmetic over identifiers, reported as if it were a measurement.
  const termsFrame = {
    schema: { fields: [{ name: "status", type: "number" }, { name: "Count", type: "number" }] },
    data: { values: [[200, 401, 500], [3691597, 3019, 13]] },
  };
  assert.equal(classifyFrame(termsFrame), "table");

  const out = summarizeQueryResult({ results: { A: { status: 200, frames: [termsFrame] } } });
  assert.equal(out.results.A.frame_type, "table");
  assert.equal(out.results.A.row_count, 3);
  assert.equal(out.results.A.series_count, undefined, "status codes must not be digested as a series");
  // The term and its count stay paired, which is the entire content of the result.
  assert.deepEqual(out.results.A.sample_rows[0], { status: 200, Count: 3691597 });
  assert.deepEqual(out.results.A.columns.map((c) => c.name), ["status", "Count"]);
});

test("classifyFrame: recognises each shape this Grafana actually returns", () => {
  assert.equal(classifyFrame(PROM_FRAME), "timeseries");
  assert.equal(classifyFrame(ES_AGG_FRAME), "timeseries");
  assert.equal(classifyFrame(tempoFrame([])), "table");
  assert.equal(classifyFrame(logFrame([])), "logs");
  // A bare Time+number frame with no meta is still a timeseries (back-compat).
  assert.equal(classifyFrame(frame({}, [1, 2])), "timeseries");
});

test("summarizeQueryResult: Elasticsearch aggregations digest as an ordinary timeseries", () => {
  // ES returns meta.type timeseries-multi, so it needs no special handling —
  // this pins that, so a future change cannot quietly break it.
  const out = summarizeQueryResult({ results: { A: { status: 200, frames: [ES_AGG_FRAME] } } });
  assert.equal(out.results.A.series_count, 1);
  assert.equal(out.results.A.series[0].count, 1);
});

test("summarizeQueryResult: Tempo traces digest as a table, not as a bogus series", () => {
  // Regression: traceDuration is a `number` field, so the numeric path would
  // digest trace durations into a "series" with no labels — silently
  // meaningless output rather than an obvious failure.
  const out = summarizeQueryResult({
    results: {
      A: {
        status: 200,
        frames: [
          tempoFrame([
            { id: "abc", start: 1700000000000, name: "GET /x", duration: 12 },
            { id: "def", start: 1700000001000, name: "GET /y", duration: 34 },
          ]),
        ],
      },
    },
  });
  const r = out.results.A;
  assert.equal(r.frame_type, "table");
  assert.equal(r.row_count, 2);
  assert.equal(r.series_count, undefined, "trace durations must not be reported as a series");
  assert.deepEqual(
    r.columns.map((c) => c.name),
    ["traceID", "startTime", "traceName", "traceDuration", "nested"],
  );
  assert.equal(r.sample_rows[0].traceID, "abc");
  // Object columns are summarised, never inlined - they can be arbitrarily large.
  assert.equal(r.sample_rows[0].nested, "{object}");
});

test("summarizeQueryResult: table sample is capped and over-long cells clipped", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: "x".repeat(50), start: i, name: `n${i}`, duration: i }));
  const out = summarizeQueryResult({ results: { A: { frames: [tempoFrame(rows)] } } }, { maxSampleRows: 2, maxCellChars: 10 });
  assert.equal(out.results.A.row_count, 9);
  assert.equal(out.results.A.sample_rows.length, 2);
  assert.equal(out.results.A.sample_rows_truncated, 7);
  assert.equal(out.results.A.sample_rows[0].traceID, "xxxxxxxxxx\u2026[truncated]");
});

test("summarizeQueryResult: an unrecognised frame is reported, never silently empty", () => {
  // The whole point: a shape nobody anticipated must still produce a visible
  // row count and column list rather than a confident zero.
  const odd = {
    schema: { fields: [{ name: "thing", type: "string" }, { name: "other", type: "other" }] },
    data: { values: [["a", "b", "c"], [1, 2, 3]] },
  };
  const out = summarizeQueryResult({ results: { A: { frames: [odd] } } });
  assert.equal(out.results.A.frame_type, "table");
  assert.equal(out.results.A.row_count, 3);
});

// ---------------------------------------------------------------------------
// trend helpers
// ---------------------------------------------------------------------------

test("durationSeconds: parses Loki-style durations and rejects junk", () => {
  assert.equal(durationSeconds("30s"), 30);
  assert.equal(durationSeconds("5m"), 300);
  assert.equal(durationSeconds("1h"), 3600);
  assert.equal(durationSeconds("2d"), 172800);
  for (const bad of ["", "5", "5x", "m", "-1m", "1.5h", undefined]) {
    assert.throws(() => durationSeconds(bad), /invalid interval/);
  }
});

test("chooseInterval: keeps the bucket count readable across ranges", () => {
  // A day of one-minute buckets is 1440 numbers - unreadable and expensive.
  assert.equal(chooseInterval(3600), "5m", "1h at 1m would be 60 buckets, over the cap");
  assert.equal(chooseInterval(6 * 3600), "15m");
  assert.equal(chooseInterval(24 * 3600), "30m");
  assert.equal(chooseInterval(7 * 24 * 3600), "6h");
  for (const range of [600, 3600, 6 * 3600, 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600]) {
    assert.ok(range / durationSeconds(chooseInterval(range)) <= 48, `too many buckets for ${range}s`);
  }
});

test("buildTrendBuckets: fills empty steps so a gap is not mistaken for a shape", () => {
  // Loki omits empty steps entirely. Without filling, a quiet hour and a missing
  // hour look identical, and the onset cannot be read off the series.
  const start = 1000, end = 1000 + 5 * 60;
  const points = [[1060, "3"], [1240, "7"]];
  const buckets = buildTrendBuckets(points, { startSeconds: start, endSeconds: end, stepSeconds: 60 });
  assert.deepEqual(buckets.map((b) => b.count), [0, 3, 0, 0, 7, 0]);
  assert.equal(buckets[0].time, new Date(960 * 1000).toISOString());
});

test("buildTrendBuckets: snaps off-grid points instead of dropping them", () => {
  // Loki's step alignment need not match ours; a point landing mid-bucket must
  // still be counted.
  const buckets = buildTrendBuckets([[1037, "2"], [1059, "1"]], {
    startSeconds: 1000,
    endSeconds: 1120,
    stepSeconds: 60,
  });
  assert.equal(buckets.reduce((n, b) => n + b.count, 0), 3);
});

test("buildTrendBuckets: is bounded so a tiny interval cannot flood the response", () => {
  const buckets = buildTrendBuckets([], { startSeconds: 0, endSeconds: 10_000_000, stepSeconds: 1, maxBuckets: 50 });
  assert.equal(buckets.length, 50);
});

test("summarizeTrend: reports total, onset, last and peak", () => {
  const buckets = [
    { time: "t0", count: 0 },
    { time: "t1", count: 2 },
    { time: "t2", count: 9 },
    { time: "t3", count: 1 },
    { time: "t4", count: 0 },
  ];
  const s = summarizeTrend(buckets);
  assert.equal(s.total, 12);
  assert.equal(s.onset, "t1", "onset is the FIRST non-empty bucket - the 'when did this start' answer");
  assert.equal(s.last_seen, "t3");
  assert.deepEqual(s.peak, { time: "t2", count: 9 });
});

test("summarizeTrend: an all-zero series has no onset rather than a false one", () => {
  const s = summarizeTrend([{ time: "t0", count: 0 }, { time: "t1", count: 0 }]);
  assert.equal(s.total, 0);
  assert.equal(s.onset, null);
  assert.equal(s.peak, null);
});

// ---------------------------------------------------------------------------
// summarizePatterns
// ---------------------------------------------------------------------------

// Shape captured from Loki: {pattern, level, samples: [[unixSeconds, count]]}.
const PATTERNS = [
  { pattern: "<_> INFO destroying service <_>", level: "info", samples: [[1000, 400], [1060, 172]] },
  { pattern: "GET / HTTP/1.1 200 <_>", level: "unknown", samples: [[1000, 408]] },
  { pattern: "rare deserialization failure <_>", level: "error", samples: [[1120, 1]] },
  { pattern: "never seen", level: "info", samples: [] },
];

test("summarizePatterns: ranks patterns by volume and keeps the rare one visible", () => {
  const out = summarizePatterns(PATTERNS);
  assert.equal(out.pattern_count, 3, "a pattern with no samples is not a pattern");
  assert.deepEqual(out.patterns.map((p) => p.count), [572, 408, 1]);
  // The point of the tool: the 1-line error survives next to the 572-line noise.
  const rare = out.patterns.find((p) => p.level === "error");
  assert.equal(rare.count, 1);
  assert.equal(rare.first_seen, new Date(1120 * 1000).toISOString());
});

test("summarizePatterns: lines_in_patterns is named for what it is, not a line total", () => {
  // Loki assigns only some lines to patterns, so this must never be presented as
  // the number of lines in the range.
  const out = summarizePatterns(PATTERNS);
  assert.equal(out.lines_in_patterns, 981);
  assert.equal(out.line_count, undefined);
  assert.equal(out.total, undefined);
});

test("summarizePatterns: reports the volume floor so absence is not read as zero", () => {
  // Loki does not rank rare lines last, it omits them. Surfacing the smallest
  // pattern we DID get tells the caller what could be missing.
  const out = summarizePatterns(PATTERNS);
  assert.equal(out.smallest_pattern_count, 1);
  assert.equal(summarizePatterns([]).smallest_pattern_count, null);
});

test("summarizePatterns: caps the list and reports how many were dropped", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ pattern: `p${i}`, samples: [[1000, i + 1]] }));
  const out = summarizePatterns(many, { maxPatterns: 5 });
  assert.equal(out.pattern_count, 30);
  assert.equal(out.patterns.length, 5);
  assert.equal(out.patterns_truncated, 25);
  assert.equal(out.patterns[0].count, 30, "capped list keeps the BIGGEST patterns");
});

// ---------------------------------------------------------------------------
// mergeContextStreams
// ---------------------------------------------------------------------------

test("mergeContextStreams: interleaves streams into one time-ordered sequence", () => {
  // The reason for reading context at all: a logger formatting with a newline
  // emits two SEPARATE entries. The second carries the reason and none of the
  // filter's keywords, so it is only visible unfiltered and in order.
  const result = [
    { stream: { service_name: "api", pod: "api-1" }, values: [["1700000000000000000", "Problem while sending request."]] },
    { stream: { service_name: "gw", pod: "gw-1" }, values: [["1700000000500000000", "unrelated gateway line"]] },
    { stream: { service_name: "api", pod: "api-1" }, values: [["1700000000000900000", "  Caused by: connection refused"]] },
  ];
  const out = mergeContextStreams(result);
  assert.equal(out.total, 3);
  assert.deepEqual(out.lines.map((l) => l.line), [
    "Problem while sending request.",
    "  Caused by: connection refused",
    "unrelated gateway line",
  ]);
  assert.equal(out.lines[0].service_name, "api");
  assert.equal(out.lines[0].ts_ns, "1700000000000000000");
  assert.equal(out.lines[0].time, "2023-11-14T22:13:20.000Z");
});

test("mergeContextStreams: caps output and reports what was dropped", () => {
  const values = Array.from({ length: 10 }, (_, i) => [String(1700000000000000000 + i * 1000000), `l${i}`]);
  const out = mergeContextStreams([{ stream: { service_name: "api" }, values }], { maxLines: 4 });
  assert.equal(out.total, 10);
  assert.equal(out.lines.length, 4);
  assert.equal(out.truncated, 6);
  assert.equal(out.lines[0].line, "l0", "the cap keeps the EARLIEST lines, so the sequence still reads forward");
});

test("mergeContextStreams: clips an enormous line and tolerates junk", () => {
  const out = mergeContextStreams(
    [{ stream: {}, values: [["1700000000000000000", "y".repeat(50)], ["not-a-number", "dropped"]] }],
    { maxLineChars: 10 },
  );
  assert.equal(out.total, 1, "a row with an unparseable timestamp is dropped, not sorted randomly");
  assert.equal(out.lines[0].line, "yyyyyyyyyy\u2026[truncated]");
  assert.equal(out.lines[0].service_name, null);
});

test("toLokiNs: a nanosecond instant from a previous result passes through", () => {
  // Loki reports per-line timestamps in ns (~19 digits). Read as ms it would
  // land in the year 58000 and query an empty future window.
  assert.equal(toLokiNs("1700000000000000000", 0, NOW), "1700000000000000000");
  // ...while epoch ms (~13 digits) is still scaled up.
  assert.equal(toLokiNs("1700000000000", 0, NOW), `${1700000000000 * 1e6}`);
});

// ---------------------------------------------------------------------------
// noise profiling
// ---------------------------------------------------------------------------

test("normaliseLogLine: collapses the variable parts, keeping the message", () => {
  // Shapes taken from real lines on this instance.
  assert.equal(
    normaliseLogLine("15:18:23.213 [vert.x-eventloop-thread-1] [] WARN Error parsing"),
    "<ts> [vert.x-eventloop-thread-<n>] [] WARN Error parsing",
  );
  assert.equal(
    normaliseLogLine("::ffff:10.0.0.62 - - [01/Sep/2026:15:12:57 +0000] \"GET / HTTP/1.1\" 200 6597"),
    '<ip> - - [<ts> +<n>] "GET / HTTP/<n>.<n>" <n> <n>',
  );
  assert.equal(normaliseLogLine("channel 'a3f1c8de-1234-4bcd-9012-abcdef012345' closed"), "channel '<uuid>' closed");
});

test("normaliseLogLine: every stack frame is one shape", () => {
  // Otherwise a single exception fragments into fifty distinct 'shapes' and
  // hides whatever else is in the stream.
  const a = normaliseLogLine("\tat io.reactivex.rxjava3.core.Maybe.subscribe(Maybe.java:5377)");
  const b = normaliseLogLine("  at io.netty.handler.ssl.SslHandler.decode(SslHandler.java:1428)");
  assert.equal(a, "at <stack frame>");
  assert.equal(a, b);
  assert.equal(normaliseLogLine("... 193 common frames omitted"), "... <n> common frames omitted");
});

test("normaliseLogLine: specific rules run before general ones", () => {
  // A timestamp must not be eaten by the number rule, or two different shapes
  // collapse into one and the profile lies about what dominates.
  assert.equal(normaliseLogLine("2026-08-20T15:00:00.123Z done"), "<ts> done");
  assert.ok(!normaliseLogLine("2026-08-20T15:00:00Z done").includes("<n>"));
});

test("profileNoise: ranks shapes and flags a dominant one", () => {
  // The case from the field notes: one repeating message is most of the volume.
  const lines = [
    ...Array.from({ length: 90 }, (_, i) => `Ignoring ChannelEvent for channel '${i}' without any target`),
    "something genuinely interesting happened",
    "another one-off",
  ];
  const p = profileNoise(lines, { maxShapes: 3 });
  assert.equal(p.sampled_lines, 92);
  assert.equal(p.distinct_shapes, 3);
  assert.equal(p.shapes[0].count, 90);
  assert.equal(p.shapes[0].percent_of_sample, 97.8);
  assert.equal(p.shapes[0].dominant, true);
  assert.match(p.shapes[0].suggested_exclusion, /Ignoring ChannelEvent/);
  // The rare line survives next to the noise — the reason for profiling at all.
  assert.ok(p.shapes.some((s) => s.shape === "something genuinely interesting happened"));
});

test("profileNoise: a quiet stream has no dominant shape", () => {
  const p = profileNoise(["alpha message here", "beta message here", "gamma message here"]);
  assert.equal(p.shapes.every((s) => !s.dominant), true);
  assert.equal(p.shapes.every((s) => s.suggested_exclusion === undefined), true);
});

test("profileNoise: caps the list and tolerates junk", () => {
  const p = profileNoise(["a message", null, 42, undefined, "a message"], { maxShapes: 1 });
  assert.equal(p.sampled_lines, 2, "non-strings are skipped, not counted");
  assert.equal(p.shapes.length, 1);
  assert.deepEqual(profileNoise([]).shapes, []);
});

test("suggestExclusion: produces a pasteable LogQL fragment", () => {
  assert.equal(suggestExclusion("at <stack frame>"), "!~ `^\\s+at `");
  assert.equal(
    suggestExclusion("Ignoring ChannelEvent for channel '<n>'"),
    "!= `Ignoring ChannelEvent for channel '`",
  );
  // Nothing stable and long enough to exclude on.
  assert.equal(suggestExclusion("<ts> <n> <ip>"), null);
});

// ---------------------------------------------------------------------------
// requireDatasourceUid
// ---------------------------------------------------------------------------

test("requireDatasourceUid: returns the configured uid", () => {
  assert.equal(requireDatasourceUid("grafanacloud-logs"), "grafanacloud-logs");
  assert.equal(requireDatasourceUid("  padded-uid  "), "padded-uid");
});

test("requireDatasourceUid: unset/blank fails with an actionable message", () => {
  for (const bad of [undefined, null, "", "   "]) {
    assert.throws(() => requireDatasourceUid(bad), /GRAFANA_LOGS_DATASOURCE_UID is not set/);
  }
  // The message must say the uid can differ from the display name — the exact
  // assumption that cost time on this instance.
  assert.throws(() => requireDatasourceUid(""), /not always the same as the display name/);
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
  // Case-insensitive by default, so the term is regex-escaped for `|~`.
  assert.equal(
    buildLogsQuery({ client: "april", lineFilter: "error `x`" }),
    '{service_name=~"(?i).*april.*"} |~ `(?i)error x`',
  );
  assert.equal(
    buildLogsQuery({ client: "april", lineFilter: "error `x`", caseSensitive: true }),
    '{service_name=~"(?i).*april.*"} |= `error x`',
  );
});

test("buildLogsQuery: throws when client missing", () => {
  assert.throws(() => buildLogsQuery({}), /client is required/);
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

test("buildExactLogsQuery: line_filter is case-insensitive by default", () => {
  assert.equal(
    buildExactLogsQuery({
      namespace: "ghd-prod",
      serviceNames: ["graviteeio-apim3-gateway"],
      lineFilter: "ConnectTimeoutException",
    }),
    '{namespace="ghd-prod", service_name="graviteeio-apim3-gateway"} |~ `(?i)ConnectTimeoutException`',
  );
  assert.equal(
    buildExactLogsQuery({
      namespace: "ghd-prod",
      serviceNames: ["graviteeio-apim3-gateway"],
      lineFilter: "ConnectTimeoutException",
      caseSensitive: true,
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
// splitClientEnv
// ---------------------------------------------------------------------------

test("splitClientEnv: separates customer core from env tokens", () => {
  assert.deepEqual(splitClientEnv("blueyonder prod"), { core: "blueyonder", envs: ["prod"] });
  assert.deepEqual(splitClientEnv("equigy"), { core: "equigy", envs: [] });
  assert.deepEqual(splitClientEnv("  arcelor  nonprod "), { core: "arcelor", envs: ["nonprod"] });
  assert.deepEqual(splitClientEnv(""), { core: "", envs: [] });
});

// ---------------------------------------------------------------------------
// matchNamespaces
// ---------------------------------------------------------------------------

const NAMESPACES = [
  "prod",
  "nonprod",
  "april-prod",
  "april-rec",
  "blueyonder-plt-live",
  "blueyonder-multitenant",
  "skyport-prod",
];

test("matchNamespaces: returns the customer's own namespaces", () => {
  assert.deepEqual(matchNamespaces(NAMESPACES, "april"), ["april-prod", "april-rec"]);
  assert.deepEqual(matchNamespaces(NAMESPACES, "blueyonder"), ["blueyonder-plt-live", "blueyonder-multitenant"]);
});

test("matchNamespaces: customer with no dedicated namespace -> [] (fall back to service_name)", () => {
  // 'equigy' lives only in the shared `prod`/`nonprod` namespaces.
  assert.deepEqual(matchNamespaces(NAMESPACES, "equigy"), []);
});

test("matchNamespaces: empty core matches nothing (avoids matching every namespace)", () => {
  assert.deepEqual(matchNamespaces(NAMESPACES, ""), []);
  assert.deepEqual(matchNamespaces(NAMESPACES, "   "), []);
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

// Deliberately NOT the uid used by the Gravitee instance: if a default is ever
// reintroduced, these assertions fail instead of passing by coincidence.
const DS_UID = "loki-test-uid";

test("buildDrilldownUrl: requires the datasource uid instead of assuming one", () => {
  assert.throws(
    () => buildDrilldownUrl({ namespace: "april-prod", from: "now-1h", to: "now" }),
    /datasourceUid is required/,
  );
});

test("buildDrilldownUrl: single service_name -> exact (=) filter", () => {
  const url = buildDrilldownUrl({
    namespace: "april-prod",
    serviceNames: ["graviteeio-apim-april-prod-gateway"],
    datasourceUid: DS_UID,
    from: "now-1h",
    to: "now",
  });
  assert.ok(url.startsWith("https://g.example.com/a/grafana-lokiexplore-app/explore/namespace/april-prod/logs?"));
  const params = new URL(url).searchParams;
  assert.equal(params.get("var-ds"), DS_UID);
  assert.equal(params.get("visualizationType"), '"logs"');
  // namespace pin + exact service_name match (NOT a raw LogQL regex, which the
  // app treats as a literal).
  assert.deepEqual(params.getAll("var-filters"), [
    "namespace|=|april-prod",
    "service_name|=|graviteeio-apim-april-prod-gateway",
  ]);
});

test("buildDrilldownUrl: several service_names -> namespace-only, never a regex alternation", () => {
  // Regression (B3). Verified against the live Logs Drilldown app:
  //   - it treats a filter value as a LITERAL and regex-escapes it, so a `=~`
  //     alternation reaches Loki as service_name=~"a\\|b" and matches NOTHING;
  //   - its own multi-value operator (`=|`) silently keeps only the first two
  //     values (1->1, 2->2, 3->2, 5->2).
  // Both roads mislead, so a multi-service link is scoped to the namespace:
  // broader, but never silently wrong. The exact set travels in service_names
  // and in the explore_url.
  const url = buildDrilldownUrl({
    namespace: "demo-qa",
    serviceNames: ["svc-a", "svc-b", "svc-c"],
    datasourceUid: DS_UID,
    from: "now-1h",
    to: "now",
  });
  const filters = new URL(url).searchParams.getAll("var-filters");
  assert.deepEqual(filters, ["namespace|=|demo-qa"]);
  assert.ok(!url.includes("=~"), "must not emit a regex alternation the app cannot honour");
  assert.ok(!url.includes("__gfp__|svc"), "must not emit a multi-value filter the app truncates");
});

test("buildDrilldownUrl: every filter has exactly three parts, for any service count", () => {
  for (const n of [0, 1, 2, 5]) {
    const url = buildDrilldownUrl({
      namespace: "demo-qa",
      serviceNames: Array.from({ length: n }, (_, i) => `svc-${i}`),
      datasourceUid: DS_UID,
      from: "now-1h",
      to: "now",
    });
    const filters = new URL(url).searchParams.getAll("var-filters");
    // Exactly one service pins service_name; zero or several stay namespace-only.
    assert.equal(filters.length, n === 1 ? 2 : 1, `n=${n}`);
    for (const f of filters) assert.equal(f.split("|").length, 3, `n=${n} malformed: ${f}`);
  }
});

test("buildDrilldownUrl: a delimiter inside a label value is escaped, not emitted raw", () => {
  const url = buildDrilldownUrl({
    namespace: "ns,with|delims",
    serviceNames: ["svc,a"],
    datasourceUid: DS_UID,
    from: "now-1h",
    to: "now",
  });
  assert.deepEqual(new URL(url).searchParams.getAll("var-filters"), [
    "namespace|=|ns__gfc__with__gfp__delims",
    "service_name|=|svc__gfc__a",
  ]);
});

test("buildDrilldownUrl: omits the service_name filter when none given", () => {
  const url = buildDrilldownUrl({ namespace: "apim-cp-cp2222", datasourceUid: DS_UID, from: "now-15m", to: "now" });
  assert.deepEqual(new URL(url).searchParams.getAll("var-filters"), ["namespace|=|apim-cp-cp2222"]);
});

test("buildDrilldownUrl: de-duplicates service_names", () => {
  const url = buildDrilldownUrl({
    namespace: "april-prod",
    serviceNames: ["svc-a", "svc-a"],
    datasourceUid: DS_UID,
    from: "now-1h",
    to: "now",
  });
  assert.deepEqual(new URL(url).searchParams.getAll("var-filters"), ["namespace|=|april-prod", "service_name|=|svc-a"]);
});

test("buildDrilldownUrl: throws when namespace missing", () => {
  assert.throws(() => buildDrilldownUrl({ datasourceUid: DS_UID, from: "now-1h", to: "now" }), /namespace is required/);
});

test("buildDrilldownUrl: line filter populates var-lineFilters, V2 stays empty", () => {
  const url = buildDrilldownUrl({
    namespace: "sedex-prod",
    serviceNames: ["sedex-prod-gateway"],
    datasourceUid: DS_UID,
    from: "now-7d",
    to: "now",
    lineFilter: "An error occurs during user authentication",
  });
  const params = new URL(url).searchParams;
  // key|operator|value, app's exact format. Case-insensitive by default, so the
  // key is caseInsensitive and the operator the escaped `|~`.
  assert.equal(
    params.get("var-lineFilters"),
    "caseInsensitive,0|__gfp__~|An error occurs during user authentication"
  );
  // The in-progress single-filter var stays empty (matches the app's own links).
  assert.equal(params.get("var-lineFilterV2"), "");
  // Spaces must be percent/plus-encoded in the raw URL, never literal.
  assert.ok(!/var-lineFilters=[^&]* /.test(url));
});

test("buildDrilldownUrl: no line filter leaves var-lineFilters empty", () => {
  const url = buildDrilldownUrl({ namespace: "sedex-prod", datasourceUid: DS_UID, from: "now-1h", to: "now" });
  assert.equal(new URL(url).searchParams.get("var-lineFilters"), "");
});

// ---------------------------------------------------------------------------
// buildLineFilterToken
// ---------------------------------------------------------------------------

test("lineFilterExpr: defaults to a case-insensitive regex, not a literal match", () => {
  // `|=` is case-sensitive. Verified live on data containing "GET":
  //   |= get      -> 0 lines (a clean, believable, WRONG negative)
  //   |~ (?i)get  -> matches
  // A wrong-case filter fails silently, so insensitive is the default.
  assert.equal(lineFilterExpr("get"), " |~ `(?i)get`");
  assert.equal(lineFilterExpr("get", { caseSensitive: true }), " |= `get`");
  assert.equal(lineFilterExpr(""), "");
});

test("lineFilterExpr: escapes regex metacharacters in the insensitive form", () => {
  // `|~` takes a pattern, so an unescaped term would be interpreted rather than
  // matched — "a.b" must not match "axb".
  assert.equal(lineFilterExpr("a.b(c)"), " |~ `(?i)a\\.b\\(c\\)`");
  // ...while the case-sensitive form is a literal and must NOT be escaped.
  assert.equal(lineFilterExpr("a.b(c)", { caseSensitive: true }), " |= `a.b(c)`");
});

test("buildLogsQuery: line filter is case-insensitive by default", () => {
  assert.match(buildLogsQuery({ client: "april", lineFilter: "Timeout" }), /\|~ `\(\?i\)Timeout`/);
  assert.match(buildLogsQuery({ client: "april", lineFilter: "Timeout", caseSensitive: true }), /\|= `Timeout`/);
});

test("buildLineFilterToken: case-insensitive by default, matching the app's own format", () => {
  // Verified against the live Logs Drilldown app on data containing "GET":
  //   caseInsensitive,0|__gfp__~|get -> 281 lines
  //   caseSensitive,0|__gfp__=|get   -> 0 lines
  // so the key drives matching, it does not merely label the input box.
  assert.equal(buildLineFilterToken("get"), "caseInsensitive,0|__gfp__~|get");
  assert.equal(buildLineFilterToken("get", { caseSensitive: true }), "caseSensitive,0|__gfp__=|get");
});

test("buildLineFilterToken: empty -> empty string", () => {
  assert.equal(buildLineFilterToken(""), "");
  assert.equal(buildLineFilterToken(undefined), "");
});

test("buildLineFilterToken: plain substring", () => {
  assert.equal(buildLineFilterToken("boom"), "caseInsensitive,0|__gfp__~|boom");
  assert.equal(buildLineFilterToken("boom", { caseSensitive: true }), "caseSensitive,0|__gfp__=|boom");
});

test("buildLineFilterToken: escapes structural delimiters in the value", () => {
  // A `|` or `,` in the text would otherwise be read as a part/filter separator.
  assert.equal(buildLineFilterToken("a|b,c"), "caseInsensitive,0|__gfp__~|a__gfp__b__gfc__c");
  assert.equal(buildLineFilterToken("a|b,c", { caseSensitive: true }), "caseSensitive,0|__gfp__=|a__gfp__b__gfc__c");
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

test("toLokiNs: an explicit ISO instant is honoured", () => {
  assert.equal(toLokiNs("2026-08-20T15:00:00Z", 60, NOW), `${Date.parse("2026-08-20T15:00:00Z") * 1e6}`);
  assert.equal(toLokiNs("2026-08-20T15:00:00+02:00", 60, NOW), `${Date.parse("2026-08-20T15:00:00+02:00") * 1e6}`);
});

test("toLokiNs: a timestamp without a timezone is REFUSED, not guessed", () => {
  // Regression: this used to fall back to the default window, so asking about a
  // specific incident window silently reported on the last hour instead. Grafana
  // renders in the browser's timezone while log bodies are UTC, so a bare
  // timestamp is genuinely ambiguous.
  for (const naive of ["2026-08-20T15:00:00", "2026-08-20 15:00:00", "2026-08-20"]) {
    assert.throws(() => toLokiNs(naive, 60, NOW), /has no timezone/, `should refuse ${naive}`);
  }
});

test("toLokiNs: unparseable value is refused rather than silently defaulted", () => {
  assert.throws(() => toLokiNs("garbage", 60, NOW), /unrecognised time/);
  assert.throws(() => toLokiNs("yesterday", 60, NOW), /unrecognised time/);
  // An absent value still means "unspecified" and keeps the caller's default.
  assert.equal(toLokiNs("", 60, NOW), `${(NOW - 60 * 1000) * 1e6}`);
});

test("resolvedWindow: reports the UTC window a relative range resolved to", () => {
  const w = resolvedWindow("now-1h", "now", 3600, NOW);
  assert.equal(w.from_utc, new Date(NOW - 3_600_000).toISOString());
  assert.equal(w.to_utc, new Date(NOW).toISOString());
  assert.equal(w.duration_seconds, 3600);
});

// ---------------------------------------------------------------------------
// coverageVerdict
// ---------------------------------------------------------------------------

test("coverageVerdict: zero bytes scanned is never a negative finding", () => {
  // The whole point: "no logs" and "I looked nowhere" are different answers, and
  // the raw API returns the same empty list for both.
  assert.equal(coverageVerdict({ lineCount: 0, bytesProcessed: 0 }), "NO_DATA_SCANNED");
  assert.equal(coverageVerdict({ lineCount: 0, bytesProcessed: 144752 }), "EMPTY_BUT_SCANNED");
  assert.equal(coverageVerdict({ lineCount: 12, bytesProcessed: 144752 }), "OK");
  assert.equal(coverageVerdict({ lineCount: 100, bytesProcessed: 1, limitReached: true }), "TRUNCATED");
  // Truncation outranks everything: the answer is incomplete whatever else holds.
  assert.equal(coverageVerdict({ lineCount: 100, bytesProcessed: 0, limitReached: true }), "TRUNCATED");
  // No stats at all -> say so rather than implying a trustworthy negative.
  assert.equal(coverageVerdict({ lineCount: 0, bytesProcessed: undefined }), "UNKNOWN");
});

test("summarizeQueryResult: a scanned-but-empty log result is marked trustworthy", () => {
  const empty = logFrame([], {
    stats: [{ displayName: "Summary: total bytes processed", value: 144752 }],
  });
  const out = summarizeQueryResult({ results: { A: { status: 200, frames: [empty] } } });
  assert.equal(out.results.A.line_count, 0);
  assert.equal(out.results.A.coverage, "EMPTY_BUT_SCANNED");
  assert.match(out.results.A.coverage_note, /trustworthy negative/);
});

test("summarizeQueryResult: scanning nothing is flagged, not reported as absence", () => {
  const nothing = logFrame([], { stats: [{ displayName: "Summary: total bytes processed", value: 0 }] });
  const out = summarizeQueryResult({ results: { A: { status: 200, frames: [nothing] } } });
  assert.equal(out.results.A.coverage, "NO_DATA_SCANNED");
  assert.match(out.results.A.coverage_warning, /not a statement about whether the event happened/);
});

test("summarizeQueryResult: a truncated result reports how little of the window it covers", () => {
  // Loki fills the cap walking backwards from the window END. 5 lines spanning
  // 4 seconds of a 1-hour request means the other 59 minutes were never returned,
  // and an absence there is an artifact, not a finding.
  const base = 1700000000000;
  const rows = Array.from({ length: 5 }, (_, i) => ({ labels: NS, time: base + i * 1000, line: `l${i}` }));
  const out = summarizeQueryResult(
    { results: { A: { frames: [logFrame(rows)] } } },
    { limit: 5, window: { start_ms: base - 3_600_000, end_ms: base + 4000 } },
  );
  const r = out.results.A;
  assert.equal(r.coverage, "TRUNCATED");
  assert.equal(r.covered_window.covered_seconds, 4);
  assert.equal(r.covered_window.requested_seconds, 3604);
  assert.match(r.covered_window.warning, /never returned/);
});

test("summarizeQueryResult: no truncation warning when the lines span the window", () => {
  const base = 1700000000000;
  const rows = [
    { labels: NS, time: base, line: "a" },
    { labels: NS, time: base + 3_600_000, line: "b" },
  ];
  const out = summarizeQueryResult(
    { results: { A: { frames: [logFrame(rows)] } } },
    { limit: 2, window: { start_ms: base, end_ms: base + 3_600_000 } },
  );
  assert.equal(out.results.A.covered_window.warning, undefined);
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

// ---------------------------------------------------------------------------
// HTTP request logs (ingress access logs)
// ---------------------------------------------------------------------------

test("statusFilterExpr: accepts a code, a class, and a list of both", () => {
  assert.equal(statusFilterExpr("499"), " | status =~ `499`");
  assert.equal(statusFilterExpr("5xx"), " | status =~ `5..`");
  assert.equal(statusFilterExpr("499, 5xx"), " | status =~ `499|5..`");
  assert.equal(statusFilterExpr(""), "");
});

test("statusFilterExpr: refuses junk rather than matching nothing", () => {
  // A silently-unmatched filter is the failure this adapter keeps removing: the
  // query runs, returns zero, and the zero is read as a finding.
  assert.throws(() => statusFilterExpr("slow"), /Unrecognised status_filter/);
  assert.throws(() => statusFilterExpr("99"), /Unrecognised status_filter/);
  assert.throws(() => statusFilterExpr("6xx"), /Unrecognised status_filter/);
});

test("buildIngressQuery: a dedicated cluster needs no upstream filter", () => {
  const q = buildIngressQuery({ cluster: "gravitee-acme-aks-cluster", ingress: "nginx" });
  assert.ok(
    q.startsWith("{cluster=`gravitee-acme-aks-cluster`, job=`" + INGRESS_JOB + "`} | pattern `" + NGINX_PATTERN + "`"),
    q,
  );
  assert.ok(!q.includes("upstream =~"));
});

test("buildIngressQuery: a shared cluster is scoped to the customer's upstreams", () => {
  // Cluster-wide ingress on a multi-tenant cluster is every tenant's traffic.
  // The line filter is a prefilter; the `upstream` matcher is the authority.
  const q = buildIngressQuery({
    cluster: "shared-core-us-prod",
    upstreamNamespaces: ["acme-prod", "acme-uat"],
  });
  assert.ok(q.includes("|~ `\\[(acme-prod|acme-uat)-`"), q);
  assert.ok(q.includes("| upstream =~ `(acme-prod|acme-uat)-.*`"), q);
  assert.ok(q.indexOf("|~ `\\[") < q.indexOf("| pattern"), "prefilter must precede the parser");
});

test("buildIngressQuery: filters compose in a parseable order", () => {
  const q = buildIngressQuery({
    cluster: "gravitee-acme-aks-cluster",
    method: "post",
    statusFilter: "5xx",
    pathFilter: "_import/crd",
    minDurationSeconds: 4.5,
  });
  // Every label filter must come AFTER the parser that creates those labels.
  const parser = q.indexOf("| pattern");
  for (const frag of ["| method =", "| status =~", "| path =~", "| request_time >"]) {
    assert.ok(q.indexOf(frag) > parser, `${frag} must follow the parser`);
  }
  assert.ok(q.includes("| method = `POST`"), q);
  assert.ok(q.includes("| request_time > 4.5"), q);
  // Path is case-insensitive and regex-escaped: a wrong-case fragment returning
  // a clean empty result is the exact trap this repeats elsewhere.
  assert.ok(q.includes("| path =~ `(?i).*_import/crd.*`"), q);
});

test("buildIngressQuery: requires a cluster", () => {
  assert.throws(() => buildIngressQuery({}), /cluster is required/);
});

// ---------------------------------------------------------------------------
// Adaptive Logs sampling
// ---------------------------------------------------------------------------

test("detectSampling: silent when nothing is sampled", () => {
  assert.equal(detectSampling([{ labels: { namespace: "acme-prod" } }]), null);
  assert.equal(detectSampling([]), null);
});

test("detectSampling: reports sampled streams as a lower bound, not a total", () => {
  const out = detectSampling([
    { labels: { namespace: "acme-prod" } },
    { labels: { namespace: "acme-prod", __adaptive_logs_sampled__: "99.00" } },
    { labels: { namespace: "acme-prod", __adaptive_logs_sampled__: "91.00" } },
  ]);
  assert.equal(out.sampled_streams, 2);
  assert.equal(out.total_streams, 3);
  assert.deepEqual(out.label_values, ["91.00", "99.00"]);
  assert.match(out.warning, /LOWER BOUNDS/);
  // The actionable half: this is a retention rule someone can lift, not a hole
  // in the query. Reading it as the latter cost weeks once.
  assert.match(out.warning, /exemption/);
});

test("detectSampling: an empty label value is not sampling", () => {
  assert.equal(detectSampling([{ labels: { __adaptive_logs_sampled__: "" } }]), null);
});

test("summarizeQueryResult: surfaces sampling from the log digest", () => {
  // The label was on every stream all along; nothing read it, so a stream that
  // was dropping lines looked exactly like a complete one.
  const payload = {
    results: {
      A: {
        frames: [
          {
            schema: {
              meta: { custom: { frameType: "LabeledTimeValues" } },
              fields: [
                { name: "labels", type: "other" },
                { name: "Time", type: "time" },
                { name: "Line", type: "string" },
              ],
            },
            data: {
              values: [
                [{ namespace: "acme-prod", __adaptive_logs_sampled__: "95.00" }],
                [1755700000000],
                ["boom"],
              ],
            },
          },
        ],
      },
    },
  };
  const out = summarizeQueryResult(payload, { limit: 100 });
  assert.equal(out.results.A.adaptive_logs_sampling.sampled_streams, 1);
});

// ---------------------------------------------------------------------------
// Scope notes
// ---------------------------------------------------------------------------

test("scopeNote: a namespace-scoped query says what it did NOT search", () => {
  const note = scopeNote('{namespace=~"^acme-prod$", service_name=~"(?i).*gateway.*"}');
  assert.match(note, /APPLICATION logs only/);
  assert.match(note, /ingress-nginx/);
  assert.match(note, /grafana_http_requests/);
});

test("scopeNote: a cluster-scoped query warns about other tenants instead", () => {
  const note = scopeNote('{cluster=`shared-core-us-prod`, job=`' + INGRESS_JOB + '`}');
  assert.match(note, /other customers' traffic/);
  assert.ok(!/APPLICATION logs only/.test(note));
});

test("scopeNote: nothing to say about an unscoped query", () => {
  assert.equal(scopeNote('{service_name=~"(?i).*gateway.*"}'), null);
  assert.equal(scopeNote(""), null);
});

test("NGINX_PATTERN + tail: capture where the time went, not just how long it took", () => {
  for (const field of ["<method>", "<path>", "<status>", "<request_time>", "<upstream>"]) {
    assert.ok(NGINX_PATTERN.includes(field), `pattern must capture ${field}`);
  }
  for (const field of ["upstream_addr", "upstream_time", "upstream_status"]) {
    assert.ok(UPSTREAM_TAIL_REGEXP.includes(`(?P<${field}>`), `tail must capture ${field}`);
  }
  // The tail differs between clusters; anchoring past it matches nothing on half the estate.
  assert.ok(NGINX_PATTERN.endsWith("<_>"), NGINX_PATTERN);
  // Discarded fields must not become labels (series keys).
  for (const field of ["remote_addr", "referer", "req_id", "upstream_len"]) {
    assert.ok(!NGINX_PATTERN.includes(`<${field}>`), field);
    assert.ok(!UPSTREAM_TAIL_REGEXP.includes(`(?P<${field}>`), field);
  }
});

// ---------------------------------------------------------------------------
// Retries, both ingress controllers, guards, sampling, step
// ---------------------------------------------------------------------------

const SINGLE_LINE =
  '203.0.113.10 - - [10/Sep/2026:14:14:36 +0000] "PUT /management/v2/organizations/o1/environments/e1/apis/_import/crd?dryRun=true HTTP/2.0" 499 0 "-" "Go-http-client/2.0" 1651 12.851 [acme-prod-apim-api-83] [] 10.0.2.21:8083 0 12.850 - fedcba9876543210fedcba9876543210';
const RETRIED_LINE =
  '203.0.113.11 - - [10/Sep/2026:14:14:36 +0000] "GET /orders/v1/lookup HTTP/1.1" 500 208 "-" "axios/1.11.0" 1476 191.621 [apim-dp-cp1111-dp0001-prod-apim-dp-cp1111-dp0001-gateway-82] [] 10.0.1.11:8082, 10.0.1.12:8082, 10.0.1.13:8082 0, 0, 208 120.007, 71.153, 0.462 504, 502, 500 0123456789abcdef0123456789abcdef';
const TRAILING_LINE = `${SINGLE_LINE} scheme-https - 203.0.113.10 - 203.0.113.10`;

test("parseAccessLogLine: a single-attempt client timeout", () => {
  const r = parseAccessLogLine(SINGLE_LINE);
  assert.equal(r.status, 499);
  assert.equal(r.request_time, 12.851);
  assert.equal(r.retried, false);
  assert.deepEqual(r.attempts, [{ addr: "10.0.2.21:8083", status: "-", response_time: 12.85 }]);
  assert.equal(r.upstream, "acme-prod-apim-api-83");
});

test("parseAccessLogLine: a retried request keeps every attempt, aligned", () => {
  // The line shape that broke the tool: a space-delimited parser read
  // upstream_time as "0," and Loki rejected the whole query with HTTP 400.
  const r = parseAccessLogLine(RETRIED_LINE);
  assert.equal(r.status, 500);
  assert.equal(r.retried, true);
  assert.deepEqual(r.attempts, [
    { addr: "10.0.1.11:8082", status: "504", response_time: 120.007 },
    { addr: "10.0.1.12:8082", status: "502", response_time: 71.153 },
    { addr: "10.0.1.13:8082", status: "500", response_time: 0.462 },
  ]);
});

test("parseAccessLogLine: tolerates trailing fields, rejects non-request lines", () => {
  assert.equal(parseAccessLogLine(TRAILING_LINE)?.status, 499);
  assert.equal(parseAccessLogLine('I0910 18:43:23.800000 7 controller.go:214] "Backend successfully reloaded"'), null);
  assert.equal(parseAccessLogLine(""), null);
});

test("UPSTREAM_TAIL_REGEXP: captures whole lists, so a retry cannot shift fields", () => {
  // Loki's regexp is RE2 with (?P<name>); JS spells the groups (?<name>).
  const re = new RegExp(UPSTREAM_TAIL_REGEXP.replace(/\(\?P</g, "(?<"));
  const single = re.exec(SINGLE_LINE).groups;
  assert.deepEqual([single.upstream_addr, single.upstream_time, single.upstream_status], ["10.0.2.21:8083", "12.850", "-"]);
  const retried = re.exec(RETRIED_LINE).groups;
  assert.equal(retried.upstream_addr, "10.0.1.11:8082, 10.0.1.12:8082, 10.0.1.13:8082");
  assert.equal(retried.upstream_time, "120.007, 71.153, 0.462");
  assert.equal(retried.upstream_status, "504, 502, 500");
});

test("unwrapNumeric: the guard admits one number and nothing else", () => {
  assert.equal(unwrapNumeric("upstream_time"), " | upstream_time =~ `[0-9]+(?:\\.[0-9]+)?` | unwrap upstream_time");
  // LogQL label matchers are fully anchored; mirror that here.
  const guard = /^[0-9]+(?:\.[0-9]+)?$/;
  for (const ok of ["0", "12.850", "0.002"]) assert.ok(guard.test(ok), ok);
  for (const bad of ["0,", "-", "", "120.007, 71.153"]) assert.ok(!guard.test(bad), `must reject ${JSON.stringify(bad)}`);
});

test("ingressJobs: both controllers by default, one on request, refusal otherwise", () => {
  assert.deepEqual(ingressJobs(), ["flow/ingress-nginx-ingress-nginx", "flow/app-routing-system-"]);
  assert.deepEqual(ingressJobs("app-routing"), ["flow/app-routing-system-"]);
  assert.throws(() => ingressJobs("traefik"), /Unknown ingress/);
});

test("buildIngressQuery: every parameter combination yields a well-ordered query", () => {
  const combos = [];
  for (const ingress of ["all", "nginx", "app-routing"])
    for (const upstreamNamespaces of [[], ["acme-prod", "acme-uat"]])
      for (const method of [undefined, "post"])
        for (const statusFilter of [undefined, "499, 5xx"])
          for (const pathFilter of [undefined, "_bridge"])
            for (const minDurationSeconds of [undefined, 1.5])
              combos.push({ ingress, upstreamNamespaces, method, statusFilter, pathFilter, minDurationSeconds });
  assert.equal(combos.length, 96);

  for (const c of combos) {
    const q = buildIngressQuery({ cluster: "shared-core-us-prod", ...c });
    const label = JSON.stringify(c);
    assert.ok(q.startsWith("{cluster=`shared-core-us-prod`, job"), label);
    const pattern = q.indexOf("| pattern");
    const regexp = q.indexOf("| regexp");
    assert.ok(pattern > 0 && regexp > pattern, `parsers out of order: ${label}`);
    // Every label filter must follow the parsers that create its label.
    for (const m of q.matchAll(/\| (status|upstream|method|path|request_time) (=~|=|>)/g)) {
      assert.ok(m.index > regexp, `${m[0]} precedes the parsers: ${label}`);
    }
    // A numeric comparison is always guarded: one "-" would fail the query.
    if (c.minDurationSeconds) {
      assert.ok(q.includes("| request_time =~ `[0-9]+(?:\\.[0-9]+)?` | request_time > 1.5"), label);
    }
    assert.equal(q.includes("| upstream =~"), c.upstreamNamespaces.length > 0, label);
    const wanted = c.ingress === "all" ? Object.values(INGRESS_JOBS) : [INGRESS_JOBS[c.ingress]];
    for (const job of Object.values(INGRESS_JOBS)) {
      assert.equal(q.includes(job), wanted.includes(job), `${job}: ${label}`);
    }
    assert.equal((q.match(/`/g) || []).length % 2, 0, `unbalanced backticks: ${label}`);
  }
});

test("scopeNote: an ingress namespace is shared infrastructure, not customer scope", () => {
  // It said "APPLICATION logs only" here — the opposite of the truth, on the one
  // namespace that holds every tenant's request logs.
  const note = scopeNote('sum by (cluster) (count_over_time({namespace="app-routing-system"}[5m]))');
  assert.match(note, /shared infrastructure/);
  assert.match(note, /EVERY tenant/);
  assert.ok(!/APPLICATION logs only/.test(note));
  assert.match(scopeNote('{namespace=~"^acme-prod$|^acme-uat$"}'), /APPLICATION logs only/);
});

test("coverageVerdict: a sampled stream cannot give a trustworthy negative", () => {
  assert.equal(coverageVerdict({ lineCount: 0, bytesProcessed: 100, sampled: true }), "EMPTY_BUT_SAMPLED");
  assert.equal(coverageVerdict({ lineCount: 0, bytesProcessed: 100 }), "EMPTY_BUT_SCANNED");
  assert.equal(coverageVerdict({ lineCount: 0, bytesProcessed: 0, sampled: true }), "NO_DATA_SCANNED");
});

test("applySamplingToCoverage: downgrades a scanned empty result and says why", () => {
  // A request-id lookup came back EMPTY_BUT_SCANNED — "a trustworthy negative" —
  // when the line had most likely been sampled out.
  const entry = { coverage: "EMPTY_BUT_SCANNED", coverage_note: "trustworthy negative" };
  applySamplingToCoverage(entry, { label_values: ["91.00"], warning: "w" });
  assert.equal(entry.coverage, "EMPTY_BUT_SAMPLED");
  assert.equal(entry.coverage_note, undefined);
  assert.match(entry.coverage_warning, /NOT proof/);
  const ok = { coverage: "OK" };
  applySamplingToCoverage(ok, { label_values: ["91.00"], warning: "w" });
  assert.equal(ok.coverage, "OK");
  assert.ok(ok.adaptive_logs_sampling);
});

test("samplingFromGroupedCounts: reports the share of lines from sampled streams", () => {
  const out = samplingFromGroupedCounts([
    { metric: { __adaptive_logs_sampled__: "91.00" }, value: [0, "900"] },
    { metric: {}, value: [0, "100"] },
  ]);
  assert.equal(out.sampled_share_pct, 90);
  assert.deepEqual(out.label_values, ["91.00"]);
  assert.match(out.warning, /LOWER BOUNDS/);
  assert.equal(samplingFromGroupedCounts([{ metric: {}, value: [0, "5"] }]), null);
});

test("collapseSampledMatrix: splitting by the sampling label does not change the trend", () => {
  const { points, sampling } = collapseSampledMatrix([
    { metric: { __adaptive_logs_sampled__: "99.00" }, values: [[100, "3"], [160, "4"]] },
    { metric: {}, values: [[100, "1"], [220, "2"]] },
  ]);
  assert.deepEqual(points, [[100, "4"], [160, "4"], [220, "2"]]);
  assert.equal(sampling.sampled_share_pct, 70);
});

test("extractStreamSelector: the first selector, ignoring braces inside strings", () => {
  assert.equal(
    extractStreamSelector('sum by (status) (count_over_time({cluster="c", job=~"a|b"} | regexp `[0-9a-f]{32}` [5m]))'),
    '{cluster="c", job=~"a|b"}',
  );
  assert.equal(extractStreamSelector('{app="x}"} |= "y"'), '{app="x}"}');
  assert.equal(extractStreamSelector("up"), null);
});

test("queryIntervalMs: derives the step instead of evaluating every second", () => {
  // Without it a 1h query returned 3,601 points per series at any max_data_points.
  assert.equal(queryIntervalMs({ startMs: 0, endMs: 3_600_000, maxDataPoints: 60 }), 60_000);
  assert.equal(queryIntervalMs({ startMs: 0, endMs: 60_000, maxDataPoints: 1000 }), 1000);
  assert.equal(queryIntervalMs({ startMs: 0, endMs: 3_600_000, maxDataPoints: 60, step: "15m" }), 900_000);
  assert.throws(() => queryIntervalMs({ startMs: 0, endMs: 1, step: "soon" }));
});

test("timelineFromPayload: returns the points, not just their summary", () => {
  const t0 = 1789000000000;
  const payload = {
    results: {
      A: {
        status: 200,
        frames: [
          {
            schema: {
              meta: { type: "timeseries-multi" },
              fields: [
                { name: "Time", type: "time" },
                { name: "Value", type: "number", labels: { status: "499" } },
              ],
            },
            data: { values: [[t0, t0 + 900_000], [3, 215]] },
          },
        ],
      },
    },
  };
  const out = timelineFromPayload(payload);
  assert.deepEqual(out.A.series[0].labels, { status: "499" });
  assert.deepEqual(out.A.series[0].points, [
    [new Date(t0).toISOString(), 3],
    [new Date(t0 + 900_000).toISOString(), 215],
  ]);
});

test("aggregateUpstreamAttempts: splits retries pairwise and ranks by failures", () => {
  const { rows, total_upstreams } = aggregateUpstreamAttempts([
    { metric: { job: INGRESS_JOBS.nginx, upstream_addr: "10.0.1.12:8082", upstream_status: "200" }, value: [0, "50"] },
    { metric: { job: INGRESS_JOBS.nginx, upstream_addr: "10.0.1.11:8082, 10.0.1.12:8082", upstream_status: "502, 200" }, value: [0, "7"] },
    { metric: { job: INGRESS_JOBS["app-routing"], upstream_addr: "10.0.1.11:8082", upstream_status: "-" }, value: [0, "3"] },
  ]);
  assert.equal(total_upstreams, 2);
  // The bad pod: 7 failed retries plus 3 that never answered.
  assert.equal(rows[0].upstream_addr, "10.0.1.11:8082");
  assert.equal(rows[0].ip, "10.0.1.11");
  assert.equal(rows[0].failed_attempts, 10);
  assert.deepEqual(rows[0].ingress, ["app-routing", "nginx"]);
  // Its sibling served the retries: healthy, and kept for contrast.
  assert.equal(rows[1].attempts, 57);
  assert.equal(rows[1].failed_attempts, 0);
});

test("rollupByNode: failures concentrate on the node the bad pods share", () => {
  const nodes = rollupByNode([
    { attempts: 10, failed_attempts: 10, pods: [{ pod: "gw-a", node: "node-1", host_ip: "10.1.0.1" }] },
    { attempts: 12, failed_attempts: 9, pods: [{ pod: "gw-b", node: "node-1", host_ip: "10.1.0.1" }] },
    { attempts: 57, failed_attempts: 0, pods: [{ pod: "gw-c", node: "node-2", host_ip: "10.1.0.2" }] },
    { attempts: 5, failed_attempts: 5 },
  ]);
  assert.equal(nodes[0].node, "node-1");
  assert.equal(nodes[0].pod_count, 2);
  assert.equal(nodes[0].failed_attempts, 19);
  assert.equal(nodes[1].failure_pct, 0);
});

// ---------------------------------------------------------------------------
// Comparison against the same window, earlier
// ---------------------------------------------------------------------------

test("parseCompareOffset: days, weeks, and a refusal to overlap the window", () => {
  assert.equal(parseCompareOffset("1d"), 86400);
  assert.equal(parseCompareOffset("1w"), 604800);
  assert.equal(parseCompareOffset("7d", { windowSeconds: 3600 }), 604800);
  assert.throws(() => parseCompareOffset("soon"), /compare_offset/);
  // An overlapping baseline drags every ratio towards "similar".
  assert.throws(() => parseCompareOffset("1h", { windowSeconds: 6 * 3600 }), /overlap/);
});

test("compareValues: labels the change, and never calls a missing baseline 'new'", () => {
  assert.deepEqual(compareValues(215, 210), { current: 215, baseline: 210, ratio: 1.02, change: "similar", already_present: true });
  assert.equal(compareValues(500, 100).change, "higher");
  assert.equal(compareValues(10, 100).change, "lower");
  assert.equal(compareValues(0, 100).change, "gone");
  assert.equal(compareValues(12, 0).change, "new");
  assert.equal(compareValues(0, 0).change, "none");
  const unknown = compareValues(12, 0, { baselineAvailable: false });
  assert.equal(unknown.change, "no_baseline");
  assert.equal(unknown.ratio, null);
});

test("describeChange: 'similar' says the pattern predates the window", () => {
  // The error this exists to stop: a chronic pattern read as incident impact.
  assert.match(describeChange(compareValues(215, 210), "1d", "499 volume"), /already happening then/);
  assert.match(describeChange(compareValues(12, 0, { baselineAvailable: false }), "7d"), /not evidence/);
});

test("attachBaselineBuckets: aligns baseline counts by position", () => {
  const out = attachBaselineBuckets(
    [{ time: "t1", count: 5 }, { time: "t2", count: 9 }],
    [{ time: "b1", count: 4 }],
  );
  assert.deepEqual(out, [{ time: "t1", count: 5, baseline: 4 }, { time: "t2", count: 9, baseline: 0 }]);
});

test("compareQueryDigests: matches series by labels, and flags a capped log comparison", () => {
  const cur = {
    results: {
      A: {
        series_count: 2,
        series: [
          { labels: { status: "499" }, avg: 20, last: 22, max: 30 },
          { labels: { status: "502" }, avg: 5, last: 5, max: 5 },
        ],
      },
      B: { line_count: 100, coverage: "TRUNCATED" },
    },
  };
  const base = {
    results: {
      A: {
        series_count: 2,
        series: [
          { labels: { status: "200" }, avg: 7, last: 7, max: 7 },
          { labels: { status: "499" }, avg: 19, last: 21, max: 29 },
        ],
      },
      B: { line_count: 100, coverage: "OK" },
    },
  };
  const out = compareQueryDigests(cur, base);
  assert.equal(out.A.series[0].avg.change, "similar");
  assert.equal(out.A.series[1].avg.change, "new");
  assert.deepEqual(out.A.only_in_baseline[0].labels, { status: "200" });
  assert.equal(out.A.only_in_baseline[0].avg.change, "gone");
  assert.match(out.B.line_count_note, /two caps/);
});

test("attachBaselineTimeline: shifts baseline points onto the current timestamps", () => {
  const cur = { A: { series: [{ labels: { s: "1" }, points: [["2026-09-10T00:00:00.000Z", 5]] }] } };
  const base = { A: { series: [{ labels: { s: "1" }, points: [["2026-09-09T00:00:00.000Z", 4]] }] } };
  const out = attachBaselineTimeline(cur, base, 86400);
  assert.deepEqual(out.A.series[0].baseline_points, [["2026-09-10T00:00:00.000Z", 4]]);
});

test("attachBaselineTimeline: a series with no counterpart is null and flagged, not an empty line", () => {
  const cur = { A: { series: [{ labels: { s: "1" }, points: [["2026-09-10T00:00:00.000Z", 5]] }] } };
  const out = attachBaselineTimeline(cur, { A: { series: [] } }, 86400);
  assert.equal(out.A.series[0].baseline_points, null);
  assert.equal(out.A.series[0].baseline_missing, true);
});

// ---------------------------------------------------------------------------
// Onset: bucket semantics and the first line
// ---------------------------------------------------------------------------

test("buildTrendBuckets: a Loki point counts the interval BEFORE its timestamp", () => {
  // Verified live: a line at 17:13:33 is counted in the point stamped 17:15 at a
  // 5m step. Filed under 17:15, the onset reads one whole interval late.
  const base = Date.parse("2026-09-10T17:00:00Z") / 1000;
  const buckets = buildTrendBuckets([[base + 900, "1"]], { startSeconds: base, endSeconds: base + 1200, stepSeconds: 300 });
  assert.equal(summarizeTrend(buckets).onset, "2026-09-10T17:10:00.000Z");
  assert.match(BUCKET_COVERS_NOTE, /START of the interval/);
});

test("earliestLine: the minimum across streams, with its labels and exact nanoseconds", () => {
  const out = earliestLine([
    { stream: { pod: "b" }, values: [["1789099013676000500", "later"]] },
    { stream: { pod: "a" }, values: [["1789099013676000000", "first"], ["1789099020000000000", "x"]] },
  ]);
  assert.equal(out.ns, "1789099013676000000");
  assert.equal(out.line, "first");
  assert.deepEqual(out.labels, { pod: "a" });
  assert.equal(out.time, new Date(1789099013676).toISOString());
  assert.equal(earliestLine([]), null);
});

test("describeOnset: a window edge is not an onset", () => {
  const edge = describeOnset({ firstTimeIso: "t1", windowStartIso: "t0", preWindowMinutes: 10, preWindowLines: 42 });
  assert.equal(edge.already_present_before_window, true);
  assert.match(edge.note, /Not an onset/);
  const real = describeOnset({ firstTimeIso: "t1", windowStartIso: "t0", preWindowMinutes: 10, preWindowLines: 0 });
  assert.equal(real.already_present_before_window, false);
  assert.match(real.note, /First occurrence: t1/);
  const unknown = describeOnset({ firstTimeIso: "t1", preWindowMinutes: 10, preWindowLines: null });
  assert.match(unknown.note, /could not be checked/);
});

test("describeOnset: on a sampled stream the first line is only the first that reached Loki", () => {
  const out = describeOnset({ firstTimeIso: "t1", preWindowMinutes: 10, preWindowLines: 0, sampling: { label_values: ["91.00"] } });
  assert.match(out.note, /REACHED Loki/);
});

test("buildTrendBuckets: edge buckets reaching outside the window are marked partial", () => {
  // A 1h trend from 14:34 reported onset 14:00 and 18 lines for a window holding 6:
  // the first bucket's count included the 34 minutes before the window.
  const start = Date.parse("2026-09-10T14:34:00Z") / 1000;
  const end = Date.parse("2026-09-10T17:30:00Z") / 1000;
  const buckets = buildTrendBuckets([], { startSeconds: start, endSeconds: end, stepSeconds: 3600 });
  assert.deepEqual(buckets.map((b) => b.time.slice(11, 16)), ["14:00", "15:00", "16:00", "17:00"]);
  assert.deepEqual(buckets[0].partial, { from: "2026-09-10T14:34:00.000Z", to: "2026-09-10T15:00:00.000Z", seconds: 1560 });
  assert.equal(buckets[1].partial, undefined);
  assert.deepEqual(buckets[3].partial, { from: "2026-09-10T17:00:00.000Z", to: "2026-09-10T17:30:00.000Z", seconds: 1800 });
});

test("buildTrendBuckets: an aligned window has no partial buckets and no bucket at its end", () => {
  const start = Date.parse("2026-09-10T14:00:00Z") / 1000;
  const buckets = buildTrendBuckets([], { startSeconds: start, endSeconds: start + 3 * 3600, stepSeconds: 3600 });
  assert.equal(buckets.length, 3);
  assert.ok(buckets.every((b) => !b.partial));
});

test("applyEdgeCounts: exact edge counts replace Loki's; a failed one is flagged, not trusted", () => {
  const buckets = [
    { time: "t0", count: 12, partial: { seconds: 1560 } },
    { time: "t1", count: 6 },
    { time: "t2", count: 5, partial: { seconds: 1800 } },
  ];
  const out = applyEdgeCounts(buckets, { t0: 0, t2: null });
  assert.equal(out[0].count, 0);
  assert.equal(out[0].partial.count_exact, true);
  assert.equal(out[1].count, 6);
  assert.equal(out[2].count, 5);
  assert.equal(out[2].partial.count_exact, false);
  assert.equal(summarizeTrend(out).onset, "t1");
});

test("compareValues: a halving is lower, and still already present", () => {
  // Live: a total at x0.53 of the day before read "similar ... already happening
  // then". True about presence, wrong about level.
  const halved = compareValues(41462, 78410);
  assert.equal(halved.change, "lower");
  assert.equal(halved.already_present, true);
  assert.match(describeChange(halved, "1d", "request volume"), /lower.*already present/);
  // The band is x0.75-x1.33.
  assert.equal(compareValues(130, 102).change, "similar"); // x1.27
  assert.equal(compareValues(140, 102).change, "higher"); // x1.37
  assert.equal(compareValues(76, 100).change, "similar");
  assert.equal(compareValues(75, 100).change, "lower");
  // Presence is its own answer, and unknown when there is no baseline.
  assert.equal(compareValues(12, 0).already_present, false);
  assert.equal(compareValues(0, 100).already_present, true);
  assert.equal(compareValues(12, 0, { baselineAvailable: false }).already_present, null);
});

// ---------------------------------------------------------------------------
// Owner rollup
// ---------------------------------------------------------------------------

test("controlPlaneOfNamespace: reads the owner out of a data-plane namespace, trials included", () => {
  assert.equal(controlPlaneOfNamespace("apim-dp-cp1111-dp0001"), "cp1111");
  assert.equal(controlPlaneOfNamespace("apim-dp-trial-tt0001-dp0011"), "trial-tt0001");
  assert.equal(controlPlaneOfNamespace("apim-cp-cp1111"), null);
  assert.equal(controlPlaneOfNamespace("acme-prod"), null);
});

test("namespaceWeightsFromPayload: counts every frame, series and log lines alike", () => {
  const payload = {
    results: {
      A: {
        frames: [
          {
            schema: { meta: { type: "timeseries-multi" }, fields: [{ name: "Time", type: "time" }, { name: "V", type: "number", labels: { namespace: "apim-dp-cp1111-dp0001", cluster: "eu-a" } }] },
            data: { values: [[0, 1], [4, 6]] },
          },
        ],
      },
      B: {
        frames: [
          {
            schema: { meta: { custom: { frameType: "LabeledTimeValues" } }, fields: [{ name: "labels", type: "other" }, { name: "Time", type: "time" }, { name: "Line", type: "string" }] },
            data: { values: [[{ namespace: "apim-dp-cp1111-dp0001", cluster: "us-b" }, { namespace: "acme-prod" }], [1, 2], ["x", "y"]] },
          },
        ],
      },
    },
  };
  const w = namespaceWeightsFromPayload(payload);
  const dp = w.get("apim-dp-cp1111-dp0001");
  assert.equal(dp.series, 1);
  assert.equal(dp.value, 5);
  assert.equal(dp.lines, 1);
  assert.deepEqual([...dp.clusters].sort(), ["eu-a", "us-b"]);
  assert.equal(w.get("acme-prod").lines, 1);
});

test("buildOwnerRollup: a spread across clusters traces back to its control planes", () => {
  const w = (clusters, value) => ({ clusters: new Set(clusters), series: 1, value, lines: 0 });
  const weights = new Map([
    ["apim-dp-cp1111-dp0001", w(["eu-a"], 10)],
    ["apim-dp-cp1111-dp0002", w(["us-b"], 20)],
    ["apim-dp-cp1111-dp0003", w(["ap-c"], 5)],
    ["apim-dp-cp2222-dp0001", w(["us-b"], 1)],
    ["acme-prod", w(["eu-a"], 3)],
  ]);
  const out = buildOwnerRollup(weights, {
    controlPlaneClusters: { "apim-cp-cp1111": ["core-us"], "apim-cp-cp2222": ["core-us"] },
    customersByControlPlane: { cp1111: ["acme", "beacon"] },
  });
  assert.equal(out.data_plane_namespaces, 4);
  assert.equal(out.data_plane_clusters, 3);
  assert.equal(out.control_planes, 2);
  assert.equal(out.other_namespaces, 1);
  assert.deepEqual(out.by_control_plane[0], {
    control_plane_id: "cp1111",
    control_plane_namespace: "apim-cp-cp1111",
    control_plane_clusters: ["core-us"],
    customers: ["acme", "beacon"],
    data_planes: 3,
    data_plane_clusters: ["ap-c", "eu-a", "us-b"],
    series: 3,
    value: 35,
  });
  assert.deepEqual(out.by_control_plane_cluster, [{ cluster: "core-us", control_planes: 2, data_planes: 4 }]);
  assert.match(out.note, /4 data-plane namespace\(s\) across 3 cluster\(s\) belong to 2 control plane\(s\), which run on 1 cluster\(s\): core-us \(2\)/);
  assert.match(out.note, /check the control-plane side/);
});

test("buildOwnerRollup: nothing to roll up below the threshold", () => {
  const weights = new Map([
    ["apim-dp-cp1111-dp0001", { clusters: new Set(), series: 1, value: 1, lines: 0 }],
    ["apim-dp-cp1111-dp0002", { clusters: new Set(), series: 1, value: 1, lines: 0 }],
  ]);
  assert.equal(buildOwnerRollup(weights), null);
});

// ---------------------------------------------------------------------------
// Failure topology
// ---------------------------------------------------------------------------

const TOPO_CLUSTER = "shared-worker-us-east-prod";
function fleet(spec, { sampled = {} } = {}) {
  // spec: [pod, node, errors]
  return {
    siblingPods: spec.map(([pod]) => ({ cluster: TOPO_CLUSTER, namespace: "acme-prod", pod })),
    errorRows: spec
      .filter(([, , e]) => e > 0)
      .map(([pod, , e]) => ({
        metric: { cluster: TOPO_CLUSTER, namespace: "acme-prod", pod, ...(sampled[pod] ? { __adaptive_logs_sampled__: "99.00" } : {}) },
        value: [0, String(e)],
      })),
    podInfo: spec.filter(([, node]) => node).map(([pod, node]) => ({ cluster: TOPO_CLUSTER, namespace: "acme-prod", pod, node, host_ip: `10.0.0.${node.slice(-1)}` })),
  };
}

test("buildFailureTopology: failures on one node, healthy siblings elsewhere, is node_concentrated", () => {
  // The incident shape: every failing pod on one node, siblings clean.
  const out = buildFailureTopology(fleet([
    ["gw-a", "node-1", 30], ["gw-b", "node-1", 25], ["gw-c", "node-1", 20],
    ["gw-d", "node-2", 0], ["gw-e", "node-2", 1], ["gw-f", "node-3", 0], ["gw-g", "node-4", 0],
  ]));
  assert.equal(out.verdict, "node_concentrated");
  assert.equal(out.by_node[0].node, "node-1");
  assert.equal(out.by_node[0].pods_with_errors, 3);
  assert.equal(out.by_node[0].pod_share_pct, 42.9);
  assert.equal(out.by_node[0].error_share_pct, 98.7);
  assert.equal(out.pods_in_scope, 7);
  assert.equal(out.healthy_pods, 3);
  assert.match(out.note, /node node-1/);
  assert.match(out.note, /3 sibling pod\(s\) on other nodes have none/);
});

test("buildFailureTopology: a node with most of the pods carrying most of the errors is not concentration", () => {
  // Error share alone would single this node out; it simply runs most of the pods.
  const out = buildFailureTopology(fleet([
    ["gw-a", "node-1", 10], ["gw-b", "node-1", 10], ["gw-c", "node-1", 10], ["gw-d", "node-1", 10],
    ["gw-e", "node-2", 9],
  ]));
  assert.equal(out.verdict, "spread");
  assert.equal(out.by_node[0].pod_share_pct, 80);
});

test("buildFailureTopology: errors in proportion to pods are spread; a lopsided node is uneven", () => {
  assert.equal(buildFailureTopology(fleet([["a", "node-1", 10], ["b", "node-2", 12], ["c", "node-3", 9]])).verdict, "spread");
  assert.equal(buildFailureTopology(fleet([["a", "node-1", 60], ["b", "node-2", 20], ["c", "node-3", 20], ["d", "node-3", 0]])).verdict, "uneven");
});

test("buildFailureTopology: no errors, one node, and no placement each say so", () => {
  assert.equal(buildFailureTopology(fleet([["a", "node-1", 0], ["b", "node-2", 0]])).verdict, "no_errors");
  assert.equal(buildFailureTopology(fleet([["a", "node-1", 5], ["b", "node-1", 0]])).verdict, "single_node");
  const unplaced = buildFailureTopology(fleet([["a", null, 5], ["b", null, 0]]));
  assert.equal(unplaced.verdict, "insufficient");
  assert.equal(unplaced.pods_without_node.length, 2);
  assert.match(unplaced.note, /could not be placed/);
});

test("buildFailureTopology: uneven sampling across pods is called out", () => {
  // Live: two of five gateway pods had lines in a sampled group, three did not.
  const out = buildFailureTopology(
    fleet([["gw-a", "node-1", 30], ["gw-b", "node-2", 3], ["gw-c", "node-3", 0]], { sampled: { "gw-b": true } }),
  );
  assert.equal(out.sampling.erroring_pods_with_sampled_lines, 1);
  assert.equal(out.by_node.find((n) => n.node === "node-2").pods[0].sampled_errors, 3);
  assert.match(out.note, /not strictly comparable/);
});

test("buildFailureTopology: bounded output", () => {
  const spec = Array.from({ length: 30 }, (_, i) => [`p${i}`, `node-${i}`, i % 2]);
  const out = buildFailureTopology({ ...fleet(spec), maxNodes: 5 });
  assert.equal(out.by_node.length, 5);
  assert.equal(out.by_node_truncated, 25);
});

test("buildFailureTopology: every error on a few of many nodes is nodes_concentrated, not spread", () => {
  // Live: every "mongo" line across 777 control-plane pods sat on 5 of 39 nodes,
  // each only ~25 points over its pod share. A per-node gap check called that
  // "spread ... in proportion to where the pods run".
  const spec = [];
  for (let n = 0; n < 20; n++) {
    for (let j = 0; j < 5; j++) {
      let errors = 0;
      if ((n === 0 || n === 1) && j < 2) errors = 10;
      if (n === 2 && j === 0) errors = 10;
      spec.push([`p${n}-${j}`, `node-${n}`, errors]);
    }
  }
  const out = buildFailureTopology(fleet(spec));
  assert.equal(out.verdict, "nodes_concentrated");
  assert.deepEqual(out.concentration, { nodes_carrying_most_lines: 2, their_line_share_pct: 80, their_pod_share_pct: 10 });
  assert.ok(out.distribution_distance_pct > 30, String(out.distribution_distance_pct));
  assert.match(out.note, /2 of 20 nodes/);
  assert.match(out.note, /node pool, a zone, a recent roll/);
});

test("buildFailureTopology: errors on half the fleet are not 'a few nodes'", () => {
  const spec = Array.from({ length: 30 }, (_, i) => [`p${i}`, `node-${i}`, i % 2]);
  const out = buildFailureTopology(fleet(spec));
  assert.notEqual(out.verdict, "nodes_concentrated");
  assert.equal(out.verdict, "uneven");
});

// ---------------------------------------------------------------------------
// Explore links
// ---------------------------------------------------------------------------

const LOKI = { type: "loki", uid: "logs" };
const PROM = { type: "prometheus", uid: "prom" };
const decodePanes = (url) => JSON.parse(decodeURIComponent(new URL(url).searchParams.get("panes")));
const EXPLORE_NOW = Date.parse("2026-09-11T13:00:00Z");

test("buildExploreLink: one pane, absolute range by default, round-trips through the URL", () => {
  const out = buildExploreLink({ panes: [{ queries: [{ datasource: LOKI, expr: '{namespace="acme-prod"}' }] }], from: "now-1h", now: EXPLORE_NOW });
  assert.ok(out.url.startsWith("https://g.example.com/explore?schemaVersion=1&orgId=1&panes="), out.url);
  assert.deepEqual(decodePanes(out.url), out.panes);
  assert.deepEqual(out.panes.p1, {
    datasource: "logs",
    queries: [{ refId: "A", datasource: LOKI, expr: '{namespace="acme-prod"}', queryType: "range" }],
    range: { from: String(EXPLORE_NOW - 3_600_000), to: String(EXPLORE_NOW) },
  });
  assert.equal(out.range_utc, "2026-09-11T12:00:00.000Z .. 2026-09-11T13:00:00.000Z");
});

test("buildExploreLink: split panes, each with its own datasource fields", () => {
  const out = buildExploreLink({
    panes: [
      { queries: [{ datasource: LOKI, expr: "sum(count_over_time({a=\"b\"}[5m]))" }] },
      { queries: [{ datasource: PROM, expr: "sum(up)" }] },
    ],
    now: EXPLORE_NOW,
  });
  assert.deepEqual(Object.keys(out.panes), ["p1", "p2"]);
  assert.deepEqual(out.panes.p2.queries[0], { refId: "A", datasource: PROM, expr: "sum(up)", range: true, instant: false });
});

test("buildExploreLink: several datasources in one pane use the Mixed datasource", () => {
  const out = buildExploreLink({
    panes: [{ queries: [{ datasource: LOKI, expr: "x" }, { datasource: PROM, expr: "y", instant: true }] }],
    now: EXPLORE_NOW,
  });
  assert.equal(out.panes.p1.datasource, MIXED_DATASOURCE_UID);
  assert.deepEqual(out.panes.p1.queries.map((q) => [q.refId, q.datasource.uid]), [["A", "logs"], ["B", "prom"]]);
  assert.equal(out.panes.p1.queries[1].instant, true);
});

test("buildExploreLink: relative on request, and an ISO offset lands on the exact instant", () => {
  const rel = buildExploreLink({ panes: [{ queries: [{ datasource: LOKI, expr: "x" }] }], from: "now-15m", absolute: false, now: EXPLORE_NOW });
  assert.deepEqual(rel.panes.p1.range, { from: "now-15m", to: "now" });
  const iso = buildExploreLink({ panes: [{ queries: [{ datasource: LOKI, expr: "x" }] }], from: "2026-09-10T10:30:00-05:00", to: "2026-09-10T16:00:00Z", now: EXPLORE_NOW });
  assert.deepEqual(iso.panes.p1.range, { from: String(Date.parse("2026-09-10T15:30:00Z")), to: String(Date.parse("2026-09-10T16:00:00Z")) });
});

test("buildExploreLink: native queries keep their fields but cannot override refId or datasource", () => {
  const es = { type: "elasticsearch", uid: "es" };
  const out = buildExploreLink({
    panes: [{ queries: [{ datasource: es, query: { query: "status:499", refId: "Z", datasource: { uid: "evil" }, timeField: "@timestamp" } }] }],
    now: EXPLORE_NOW,
  });
  assert.deepEqual(out.panes.p1.queries[0], { query: "status:499", timeField: "@timestamp", refId: "A", datasource: es });
});

test("buildExploreLink: refuses what Explore cannot show or a query cannot run", () => {
  const q = { datasource: LOKI, expr: "x" };
  assert.throws(() => buildExploreLink({ panes: [] }), /at least one pane/);
  assert.throws(() => buildExploreLink({ panes: [{ queries: [q] }, { queries: [q] }, { queries: [q] }] }), /shows 2 panes/);
  assert.throws(() => buildExploreLink({ panes: [{ queries: [] }] }), /pane 1 has no queries/);
  assert.throws(() => buildExploreLink({ panes: [{ queries: [{ datasource: LOKI }] }] }), /needs expr/);
  assert.throws(() => buildExploreLink({ panes: [{ queries: [{ datasource: { type: "elasticsearch", uid: "es" }, expr: "x" }] }] }), /native query object/);
  assert.throws(() => buildExploreLink({ panes: [{ queries: [q] }], from: "now", to: "now-1h", now: EXPLORE_NOW }), /to must be after from/);
});

// ---------------------------------------------------------------------------
// Tiered namespace matching
// ---------------------------------------------------------------------------

const FLEET = [
  "acme-int", "acme-ppr", "acme-prod", "acme-rec", "acme-sandbox",
  "orbit-plt-live", "orbit-plt-live-ap", "orbit-plt-live-au", "orbit-multitenant",
  "beacon-management-prod1", "beacon-management-uat",
  "prod", "dev",
];

test("matchNamespaces: the whole name wins over its own siblings", () => {
  // Substring matching returned plt-live AND plt-live-ap/au for "orbit plt live".
  assert.deepEqual(matchNamespaces(FLEET, "orbit plt live"), ["orbit-plt-live"]);
  assert.deepEqual(matchNamespaces(FLEET, "beacon management uat"), ["beacon-management-uat"]);
});

test("matchNamespaces: a namespace that IS an environment word still resolves", () => {
  // splitClientEnv classified the whole phrase as environment, leaving no name.
  assert.deepEqual(matchNamespaces(FLEET, "prod"), ["prod"]);
  assert.deepEqual(matchNamespaces(FLEET, "dev"), ["dev"]);
});

test("matchNamespaces: a customer name alone returns their whole estate", () => {
  assert.deepEqual(matchNamespaces(FLEET, "acme"), ["acme-int", "acme-ppr", "acme-prod", "acme-rec", "acme-sandbox"]);
});

test("matchNamespaces: falls back from segments to substring", () => {
  // "plt live ap" are whole segments; "ultitenant" is only a substring.
  assert.deepEqual(matchNamespaces(FLEET, "orbit plt live ap"), ["orbit-plt-live-ap"]);
  assert.deepEqual(matchNamespaces(FLEET, "orbit ultitenant"), ["orbit-multitenant"]);
  assert.deepEqual(matchNamespaces(FLEET, "nosuchcustomer"), []);
  assert.deepEqual(matchNamespaces(FLEET, ""), []);
});

test("matchNamespacesPhrase: drops the tail only when the whole phrase names nothing, and returns it", () => {
  assert.deepEqual(matchNamespacesPhrase(FLEET, "acme rec"), { namespaces: ["acme-rec"], name: "acme rec", tail: [] });
  // "gatewaytesting" is a Cockpit environment: no hosted namespace has it, so the
  // tail comes back for the map to explain rather than being thrown away.
  assert.deepEqual(matchNamespacesPhrase(FLEET, "acme gatewaytesting"), {
    namespaces: ["acme-int", "acme-ppr", "acme-prod", "acme-rec", "acme-sandbox"],
    name: "acme",
    tail: ["gatewaytesting"],
  });
  assert.deepEqual(matchNamespacesPhrase(FLEET, "nobody here"), { namespaces: [], name: "", tail: ["nobody", "here"] });
});

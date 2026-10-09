import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ENABLED,
  BASE_URL,
  log,
  requireConfig,
  grafanaGet,
  grafanaPost,
  grafanaDatasourceProxyGet,
} from "./grafanaClient.js";
import {
  summarizeQueryResult,
  isLogFrame,
  requireDatasourceUid,
  buildLogsQuery,
  buildExploreUrl,
  buildDrilldownUrl,
  buildExactLogsQuery,
  toLokiNs,
  rankClientSuggestions,
  matchNamespaces,
  matchNamespacesPhrase,
  chooseInterval,
  durationSeconds,
  buildTrendBuckets,
  summarizeTrend,
  summarizePatterns,
  resolvedWindow,
  mergeContextStreams,
  profileNoise,
  scopeNote,
  escapeRegex,
  detectSampling,
  buildIngressQuery,
  INGRESS_JOB,
  NGINX_PATTERN,
  INGRESS_JOBS,
  ingressJobs,
  ingressName,
  unwrapNumeric,
  RETRIED_MATCHER,
  parseAccessLogLine,
  applySamplingToCoverage,
  extractStreamSelector,
  queryIntervalMs,
  timelineFromPayload,
  samplingFromGroupedCounts,
  collapseSampledMatrix,
  aggregateUpstreamAttempts,
  rollupByNode,
  ADAPTIVE_LOGS_LABEL,
  parseCompareOffset,
  compareValues,
  describeChange,
  attachBaselineBuckets,
  compareQueryDigests,
  attachBaselineTimeline,
  CHANGE_LABELS_NOTE,
  earliestLine,
  describeOnset,
  BUCKET_COVERS_NOTE,
  lineFilterExpr,
  applyEdgeCounts,
  namespaceWeightsFromPayload,
  buildOwnerRollup,
  controlPlaneOfNamespace,
  OWNER_ROLLUP_MIN_NAMESPACES,
  buildFailureTopology,
  buildExploreLink,
} from "./helpers.js";
import { loadCustomerMap, warmCustomerMap, resolveCustomerNamespaces, splitNameAndTail, matchCustomers, groupByCustomer, lookupById, dataPlaneNamespace, controlPlaneNamespace } from "./customerMap.js";

// Loki datasource uid for the logs tools. Required — deliberately NOT defaulted:
// a uid that is correct for one Grafana org is a silent, plausible failure in
// every other one. requireDatasourceUid() turns "unset" into a clear error at
// the point of use instead.
const LOGS_DATASOURCE_UID = (process.env.GRAFANA_LOGS_DATASOURCE_UID || "").trim();

// Optional Prometheus datasource scraping kube-state-metrics. Used only to turn
// the upstream IPs in an access log into pods and nodes; everything else works
// without it, and the result says how to enable it when it is unset.
const metricsDatasourceUid = () => (process.env.GRAFANA_METRICS_DATASOURCE_UID || "").trim();

// Allowlist of datasource types whose QUERY LANGUAGE cannot write. This is the
// whole basis of the read-only guarantee — it is not about token permissions, so
// every entry is a deliberate judgement, not a convenience.
//
// Allowed: PromQL/LogQL have no write statements; Grafana's Elasticsearch backend
// only issues _msearch; Graphite render, Pyroscope and the cardinality plugin are
// read paths.
//
// Deliberately NOT allowed, and each for a concrete reason:
//   alertmanager                  - the Alertmanager API can create silences
//   grafana-incident-datasource   - can create and modify incidents
//   k6-datasource                 - can trigger load test runs against real targets
//   cloudwatch                    - reads only, but Logs Insights starts billable
//                                   query executions; enable deliberately, not by default
//   grafana-knowledgegraph-datasource - unreviewed plugin surface
//   tempo                         - read-only, but unused here; not worth the
//                                   surface area, and it was never verified
//                                   against real trace data
const READONLY_QUERY_TYPES = new Set([
  "prometheus",
  "loki",
  "elasticsearch",
  "graphite",
  "grafana-pyroscope-datasource",
  "grafanacloud-cardinality-datasource",
  // cloudwatch is allowed for METRICS ONLY - see CLOUDWATCH_LOGS_FIELDS below.
  "cloudwatch",
]);

// CloudWatch is the one allowed type where the datasource type alone is not a
// sufficient guard. Its Metrics mode reads published metrics, but its Logs mode
// runs Logs Insights, which bills per GB SCANNED — an unbounded, open-ended cost
// that a single careless query can run up. So the query payload is inspected and
// anything that is not plainly a Metrics query is refused.
//
// Honest caveat: this blocks the unbounded cost, not literally every cost.
// GetMetricData (Metrics mode) is itself metered by AWS at a small per-request
// rate. There is no way to query CloudWatch at zero cost; the guard removes the
// failure mode that can produce a large bill.
const CLOUDWATCH_LOGS_FIELDS = ["logGroups", "logGroupNames", "logGroupName", "queryLanguage", "logsQuery"];

// Every CloudWatch query costs money, including the Metrics ones this adapter
// allows: AWS meters GetMetricData per request. The guard above removes the
// unbounded Logs Insights cost, but it cannot make CloudWatch free — so every
// CloudWatch result carries this notice rather than letting a caller assume the
// reads are free the way Loki and Prometheus reads are.
const CLOUDWATCH_BILLING_NOTICE =
  "BILLABLE: this query was run against CloudWatch, which AWS meters per request " +
  "(GetMetricData is charged per 1000 metrics requested). Unlike the Loki/Prometheus " +
  "datasources, CloudWatch reads are not free. Logs Insights queries, which bill per " +
  "GB scanned, are refused by this adapter.";

// Attach the notice as a sibling of `results` so it is visible on both the digest
// and the raw response, without disturbing either shape.
function withBillingNotice(out, type) {
  if (type !== "cloudwatch") return out;
  return { billing_notice: CLOUDWATCH_BILLING_NOTICE, ...out };
}

function assertCloudwatchNotBillableLogs(query = {}) {
  const mode = String(query.queryMode ?? "Metrics").trim().toLowerCase();
  if (mode !== "metrics") {
    throw new Error(
      `CloudWatch queryMode "${query.queryMode}" is refused: only "Metrics" is allowed. ` +
        "Logs Insights queries bill per GB scanned and are blocked by this adapter.",
    );
  }
  for (const field of CLOUDWATCH_LOGS_FIELDS) {
    if (query[field] !== undefined) {
      throw new Error(
        `CloudWatch query field "${field}" is refused: it selects a Logs Insights query, ` +
          "which bills per GB scanned and is blocked by this adapter.",
      );
    }
  }
  // `subtype: "StartQuery"` is how the Logs path is dispatched regardless of mode.
  if (String(query.subtype ?? "").toLowerCase() === "startquery") {
    throw new Error(
      'CloudWatch subtype "StartQuery" is refused: it starts a billable Logs Insights execution.',
    );
  }
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

// Grafana gates /api/datasources and /api/datasources/uid/:uid behind the
// `datasources:read` permission, which the built-in Viewer role does NOT have:
// a Viewer can QUERY a datasource but cannot read its configuration. This
// adapter is meant to run with a Viewer-scoped token, so nothing on the query
// path may depend on those endpoints — otherwise the read-only guard itself
// fails and grafana_query stops working entirely the moment the token is
// correctly scoped.
//
// /api/frontend/settings is what the Grafana UI loads on every page, so any
// authenticated user can read it, and each entry carries the uid/name/type we
// need. It is the least-privileged source for the datasource catalogue, and is
// used as the fallback wherever a privileged endpoint is tried first.
// The catalogue backs a security guard, so it is cached but never indefinitely:
// a stale entry must not be able to outlive a real permissions or configuration
// change. Past the TTL we re-fetch, and a failed re-fetch propagates rather than
// serving stale data — the guard fails closed.
const CATALOGUE_TTL_MS = 5 * 60 * 1000;
let dsCatalogue = null;
let dsCatalogueFetchedAt = 0;

async function fetchFrontendDatasources() {
  const settings = await grafanaGet("/frontend/settings");
  const byUid = new Map();
  for (const ds of Object.values(settings?.datasources || {})) {
    // `-- Mixed --` / `-- Dashboard --` are UI pseudo-datasources with no uid.
    if (!ds?.uid || !ds?.type) continue;
    byUid.set(ds.uid, { uid: ds.uid, name: ds.name ?? null, type: ds.type });
  }
  // defaultDatasource is keyed by NAME, not uid.
  return { byUid, defaultName: settings?.defaultDatasource ?? null };
}

async function frontendDatasources({ refresh = false } = {}) {
  const expired = Date.now() - dsCatalogueFetchedAt > CATALOGUE_TTL_MS;
  if (refresh || !dsCatalogue || expired) {
    dsCatalogue = await fetchFrontendDatasources();
    dsCatalogueFetchedAt = Date.now();
  }
  return dsCatalogue;
}

// Resolve one datasource by uid from the Viewer-safe catalogue. A miss refreshes
// once, so a datasource created since this process started is still found rather
// than being rejected from a stale cache.
async function lookupFrontendDatasource(uid) {
  let cat = await frontendDatasources();
  if (!cat.byUid.has(uid)) cat = await frontendDatasources({ refresh: true });
  return cat.byUid.get(uid) ?? null;
}

// Given a datasource uid, verify it is read-only against the allowlist defined by READONLY_QUERY_TYPES. 
// Throws if not allowed or not found. Returns the datasource's uid, name and type.
async function assertReadOnly(uid) {
  if (typeof uid !== "string" || uid.trim() === "") {
    throw new Error("datasource_uid is required");
  }

  // Prefer the authoritative datasource record, but treat its absence as a
  // permissions problem rather than a verification failure: a Viewer-scoped
  // token cannot read it. Fall back to the catalogue every authenticated user
  // can see. If NEITHER source can name the type we still refuse the query —
  // the guard fails closed, it just no longer requires Admin to pass.
  let ds = null;
  let primaryError = null;
  try {
    ds = await grafanaGet(`/datasources/uid/${encodeURIComponent(uid)}`);
  } catch (err) {
    primaryError = err;
    try {
      ds = await lookupFrontendDatasource(uid);
    } catch (fallbackErr) {
      throw new Error(
        `datasource "${uid}" could not be verified read-only: ${err.message} (fallback failed: ${fallbackErr.message})`,
      );
    }
  }
  if (!ds) {
    throw new Error(
      `datasource "${uid}" could not be verified read-only: ${primaryError ? primaryError.message : "not found"}`,
    );
  }

  const type = ds?.type ?? null;
  if (!type || !READONLY_QUERY_TYPES.has(type)) {
    throw new Error(
      `datasource "${uid}" (type "${type ?? "unknown"}") is not in the read-only allowlist ${JSON.stringify([...READONLY_QUERY_TYPES])}`
    )
  }

  return { uid: ds.uid ?? uid, name: ds.name ?? null, type };
}


// raw=true returns Grafana's frames untouched, which means a log result that hit
// the line cap is indistinguishable from a complete one. Attach a note (and only
// a note — the frames themselves stay verbatim) when the cap was reached.
function withRawTruncationNote(payload, limit) {
  for (const res of Object.values(payload?.results || {})) {
    const frames = Array.isArray(res?.frames) ? res.frames : [];
    const lines = frames.filter(isLogFrame).reduce((n, frame) => {
      const idx = (frame?.schema?.fields || []).findIndex((f) => f?.name === "Line");
      return n + (idx === -1 ? 0 : (frame?.data?.values?.[idx] || []).length);
    }, 0);
    if (lines >= limit) {
      res.limit_reached = true;
      res.note = `Returned ${lines} log lines, the maximum requested — more lines almost certainly match. Raise max_lines or narrow the range.`;
    }
  }
  return payload;
}

async function listDatasources() {
  try {
    const items = await grafanaGet("/datasources");
    const list = Array.isArray(items) ? items : [];
    return {
      count: list.length,
      source: "datasources",
      datasources: list.map((ds) => ({
        uid: ds.uid ?? null,
        name: ds.name || null,
        type: ds.type || null,
        is_default: ds.isDefault ?? false,
      })),
    };
  } catch (err) {
    // Expected under a Viewer-scoped token (no datasources:read). The catalogue
    // carries uid/name/type — everything needed to pick a uid for grafana_query
    // — but not the full datasource configuration.
    const cat = await frontendDatasources({ refresh: true });
    const list = [...cat.byUid.values()];
    return {
      count: list.length,
      source: "frontend_settings",
      note:
        `Listed from /frontend/settings because /api/datasources was refused (${err.message}). ` +
        "That is expected for a Viewer-scoped token. uid/name/type are accurate; other " +
        "datasource settings are not exposed by this endpoint.",
      datasources: list.map((ds) => ({
        uid: ds.uid,
        name: ds.name,
        type: ds.type,
        is_default: cat.defaultName != null && ds.name === cat.defaultName,
      })),
    };
  }
}


// Discover which log streams match a selector WITHOUT pulling any log lines.
// Loki's /series returns just the label sets of the matching streams (one object
// per stream, e.g. {namespace, service_name, pod, ...}); we only need namespace
// and service_name to build the link, so this is far cheaper than query_range
// (no log bodies, no timestamps). The `|= "..."` line filter is dropped from the
// selector here — /series matches on the stream selector only, and the
// service_name we need for the link doesn't depend on the line filter anyway.
async function fetchMatchingStreams({ query, from, to }) {
  const data = await grafanaDatasourceProxyGet(LOGS_DATASOURCE_UID, "loki/api/v1/series", {
    "match[]": query,
    start: toLokiNs(from, 60 * 60),
    end: toLokiNs(to, 0),
  });
  const series = data?.data || [];
  return series.map((s) => ({
    namespace: s.namespace || null,
    service_name: s.service_name || null,
  }));
}

// Resolve a free-text `client` to the customer's own namespace(s). Many
// customers have a dedicated namespace that names them (`april-prod`,
// `blueyonder-plt-live`) — that namespace is the most reliable customer
// identifier, more so than `service_name` (which for some tenants carries an
// opaque id, not the name). We fetch the `namespace` label values and keep the
// ones whose name contains the customer "core" (env tokens excluded — they
// aren't reliably in the namespace). Returns [] for customers that only live in
// a shared namespace (e.g. `prod`), which tells the caller to fall back to a
// plain `service_name` match.
// Resolve a free-text client to the namespaces holding its logs, by two routes:
//
//  1. The namespace label itself. Hosted/standalone customers get a namespace
//     named after them (`april-prod`, `demo-qa`), so matching label values works.
//
//  2. The Gravitee Cloud customer map. Cockpit tenants live in
//     `apim-dp-<controlPlaneId>-<dataPlaneId>` and carry their name NOWHERE in
//     their labels, so route 1 returns nothing for them however the name is
//     spelled — the customers this tooling is most useful for were exactly the
//     ones it could not find.
//
// Returns which route answered, and any warning about the map's freshness, so a
// caller can tell a live mapping from a fallback one.
async function resolveNamespaces(client, { from, control_plane_id } = {}) {
  const phrase = String(client || "").trim();
  if (!phrase) return { namespaces: [], via: "none" };

  let values = [];
  try {
    const data = await grafanaDatasourceProxyGet(LOGS_DATASOURCE_UID, "loki/api/v1/label/namespace/values", {
      start: toLokiNs(from, 60 * 60),
    });
    values = data?.data || [];
  } catch {
    values = [];
  }

  // BOTH routes, always — never stop at the first hit. A customer can exist in
  // both populations at once: acme has a hosted `acme-prod` namespace
  // AND Cockpit data planes under `apim-dp-cp1111-*`. Returning early on the
  // label match searched half its logs and reported that as the whole story.
  // Neither route classifies words. The namespace route matches the phrase as
  // typed and gives ground one trailing word at a time; the map route asks the
  // map where the customer name ends. What the caller meant by the last word is
  // decided by what exists, not by a list of known environment names.
  const label = matchNamespacesPhrase(values, phrase);
  const byLabel = label.namespaces;
  const map = await loadCustomerMap();
  const { core, tail } = splitNameAndTail(map.rows, phrase);
  const resolved = resolveCustomerNamespaces(map.rows, { core, qualifiers: tail, controlPlaneId: control_plane_id });
  const namespaces = [...new Set([...byLabel, ...resolved.namespaces])];

  // An ambiguous fragment contributes NOTHING from the map rather than merging
  // several customers together. The label route is unaffected — a hosted
  // customer that matched by name is still searched — but the caller is told
  // which Cockpit customers were withheld and why.
  // A customer that does not resolve may simply be missing from a stale map, and
  // that is a different answer from "no such customer".
  if (resolved.ambiguous) {
    return {
      namespaces: byLabel,
      via: byLabel.length ? "namespace_label" : "none",
      ambiguous_customer: true,
      candidates: resolved.candidates,
      note: resolved.reason,
      map_source: map.source,
      map_warning: map.warning,
    };
  }

  if (!namespaces.length) {
    return {
      namespaces: [],
      via: "none",
      map_source: map.source,
      map_generated_at: map.generated_at,
      map_generated_days_ago: map.generated_days_ago,
      map_warning: map.warning,
    };
  }

  const via =
    byLabel.length && resolved.namespaces.length
      ? "namespace_label+customer_map"
      : byLabel.length
        ? "namespace_label"
        : "customer_map";

  // The map is not complete or eternally fresh: measured against a 30-day window,
  // 129 of 462 live data planes are absent from it, and some customers' mapped
  // ids no longer exist because their deployment was recreated. A mapped
  // namespace that Loki has never heard of in this range would otherwise produce
  // a confident "no logs for this customer" — a false negative dressed as an
  // answer. Flag it instead.
  const liveNamespaces = new Set(values);
  const absent = resolved.namespaces.filter((n) => !liveNamespaces.has(n));

  return {
    namespaces,
    via,
    // The namespace route ignored the tail (no namespace carries it); say so, in
    // case the map did not explain it either.
    ...(label.tail.length && byLabel.length ? { namespace_match_ignored: label.tail.join(" ") } : {}),
    ...(absent.length ? { mapped_namespaces_absent_in_range: absent } : {}),
    ...(resolved.namespaces.length
      ? {
          map_source: map.source,
          map_generated_at: map.generated_at,
          map_generated_days_ago: map.generated_days_ago,
          map_warning: map.warning,
        }
      : {}),
    label_namespaces: byLabel,
    matched_deployments: resolved.matched.map((r) => ({
      customer: r.customer,
      data_plane_id: r.data_plane_id,
      region: r.region,
      provider: r.provider,
      env: r.env,
    })),
    env_filter_applied: resolved.env_filter_applied,
    control_plane_ids: resolved.control_plane_ids,
    ...(resolved.spans_multiple_organizations
      ? { spans_multiple_organizations: true, organizations_note: resolved.organizations_note }
      : {}),
    // Control-plane namespaces are SHARED by every customer on that control
    // plane, so they are never searched implicitly under one customer's name.
    // Reported so the caller knows they exist and can ask for them explicitly.
    shared_control_plane_namespaces: resolved.control_plane_namespaces,
  };
}

// Which cluster(s) hold these namespaces, and what else is deployed alongside.
//
// The cluster label is the ONLY handle on a customer's HTTP request logs: those
// are emitted by the shared ingress controller in the `ingress-nginx` namespace,
// so nothing derived from the customer's own namespaces can reach them. Every
// customer-scoped tool here takes `client`, resolves it to namespaces, and is
// therefore structurally incapable of returning a status code or a request
// duration. Reporting the cluster turns that from an unknown-unknown into a
// visible next step at the first tool call of an investigation.
//
// Uses /series, which returns label sets only — no log bodies, no timestamps.
//
// The neighbours matter as much as the cluster. A dedicated customer cluster can
// be queried whole; a shared one, where many Cockpit tenants live side by side,
// cannot, because a cluster-wide ingress query there returns other customers'
// requests. So this reports what else is on the cluster and lets the caller
// decide, rather than inferring tenancy from the cluster's name.
async function resolveClusters(namespaces = [], { from } = {}) {
  const ns = [...new Set((namespaces || []).filter(Boolean))];
  if (!ns.length) return { clusters: [], by_namespace: {} };

  const selector = `{namespace=~"${ns.map((n) => `^${escapeRegex(n)}$`).join("|")}"}`;
  let series = [];
  try {
    const data = await grafanaDatasourceProxyGet(LOGS_DATASOURCE_UID, "loki/api/v1/series", {
      "match[]": selector,
      start: toLokiNs(from, 30 * 24 * 3600),
      end: toLokiNs("now", 0),
    });
    series = data?.data || [];
  } catch {
    return { clusters: [], by_namespace: {}, error: "cluster lookup failed" };
  }

  const byNamespace = {};
  const clusters = new Set();
  for (const labels of series) {
    const cluster = labels?.cluster;
    const namespace = labels?.namespace;
    if (!cluster || !namespace) continue;
    clusters.add(cluster);
    (byNamespace[namespace] ||= new Set()).add(cluster);
  }
  return {
    clusters: [...clusters].sort(),
    by_namespace: Object.fromEntries(
      Object.entries(byNamespace).map(([k, v]) => [k, [...v].sort()]),
    ),
  };
}

// Every namespace live on a cluster, so single-tenancy can be established from
// what is deployed rather than assumed from the cluster's name. Infrastructure
// namespaces are shared on every cluster and say nothing about tenancy, so they
// are excluded from the judgement.
const INFRA_NAMESPACES = new Set([
  "ingress-nginx",
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "kube-state-metrics",
  "cert-manager",
  "monitoring",
  "flow",
  "default",
  "external-dns",
  "velero",
]);

async function clusterTenants(cluster, { from } = {}) {
  let series = [];
  try {
    const data = await grafanaDatasourceProxyGet(LOGS_DATASOURCE_UID, "loki/api/v1/series", {
      "match[]": `{cluster=\`${cluster}\`}`,
      start: toLokiNs(from, 7 * 24 * 3600),
      end: toLokiNs("now", 0),
    });
    series = data?.data || [];
  } catch {
    return null;
  }
  const namespaces = new Set();
  for (const labels of series) {
    const n = labels?.namespace;
    if (n && !INFRA_NAMESPACES.has(n)) namespaces.add(n);
  }
  return [...namespaces].sort();
}

// Decide how an ingress query on `cluster` must be scoped for this customer.
//
// Single-tenant: every workload namespace on the cluster belongs to the
// customer, so the cluster-wide ingress stream IS the customer's request log and
// needs no further filtering.
//
// Multi-tenant: it is not. Filtering on the upstream carried in each access-log
// line keeps the customer's own requests and excludes everyone else's. That
// filter has one honest limit, which is reported rather than hidden: a request
// rejected at the ingress before an upstream was chosen has no upstream to match
// on, so it is excluded even though it was aimed at this customer.
async function resolveIngressScope(cluster, namespaces, { from } = {}) {
  const own = new Set((namespaces || []).filter(Boolean));
  const tenants = await clusterTenants(cluster, { from });
  if (tenants === null) {
    return {
      cluster,
      single_tenant: false,
      tenancy: "unknown",
      upstream_namespaces: [...own],
      own_on_cluster: null,
      note:
        "Could not enumerate what else runs on this cluster, so the query is narrowed to this customer's " +
        "upstreams. That is the safe direction: it cannot return another tenant's requests, but a request " +
        "rejected at the ingress before an upstream was chosen is not included.",
    };
  }
  // Which of the customer's namespaces actually run here. An explicitly named
  // cluster that hosts none of them can only ever return a clean zero, and that
  // zero reads as "no traffic" — so the caller refuses it rather than running it.
  const ownOnCluster = tenants.filter((n) => own.has(n));
  const foreign = tenants.filter((n) => !own.has(n));
  if (!foreign.length) {
    return {
      cluster,
      single_tenant: true,
      tenancy: "dedicated",
      upstream_namespaces: [],
      own_on_cluster: ownOnCluster,
      note:
        `Every workload namespace on ${cluster} belongs to this customer, so the cluster-wide ingress ` +
        "stream is their request log in full — including requests rejected before an upstream was chosen.",
    };
  }
  return {
    cluster,
    single_tenant: false,
    tenancy: "shared",
    upstream_namespaces: ownOnCluster.length ? ownOnCluster : [...own],
    own_on_cluster: ownOnCluster,
    other_tenant_namespaces: foreign.slice(0, 20),
    other_tenant_count: foreign.length,
    note:
      `${cluster} also hosts ${foreign.length} namespace(s) belonging to other tenants, so the ingress ` +
      "stream is NOT this customer's alone. Results are filtered to requests whose upstream is one of this " +
      "customer's namespaces. Consequence to be aware of: a request rejected at the ingress before an " +
      "upstream was chosen (an unroutable host, a TLS failure) carries no upstream and is therefore not " +
      "included.",
  };
}

// Is the stream behind a Loki query being sampled?
//
// Needed exactly where results cannot say: an empty log result has no streams
// to carry the label, and a metric result has aggregated it away. Adaptive Logs
// attaches the label at query time — /series does not return it — so this is a
// small count over the stream selector alone, grouped by the label, over the
// last few minutes of the window. A spot check, and reported as one.
async function samplingSpotCheck(uid, expr, window) {
  const selector = extractStreamSelector(expr);
  if (!selector) return null;
  const endS = Math.floor(window.end_ms / 1000);
  const rangeS = Math.max(60, Math.min(300, Math.round((window.end_ms - window.start_ms) / 1000)));
  try {
    const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query", {
      query: `sum by (${ADAPTIVE_LOGS_LABEL}) (count_over_time(${selector} [${rangeS}s]))`,
      time: `${endS}000000000`,
    });
    return samplingFromGroupedCounts(data?.data?.result || [], {
      checked: `stream selector ${selector}, last ${rangeS}s of the window`,
    });
  } catch {
    return null;
  }
}

// Did the streams behind a query exist at all in a window?
//
// Separates a baseline of zero from no baseline. A comparison against a window
// outside retention, or before a deployment existed, sees nothing — and without
// this check every level would read as "new". /series is an index read: label
// sets only, no log bodies. If the check cannot answer, it says the streams
// existed, so the comparison never invents a "no baseline" it did not observe.
async function streamsExist(uid, expr, startSeconds, endSeconds) {
  const selector = extractStreamSelector(expr);
  if (!selector) return true;
  try {
    const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/series", {
      "match[]": selector,
      start: `${Math.floor(startSeconds)}000000000`,
      end: `${Math.floor(endSeconds)}000000000`,
    });
    return (data?.data || []).length > 0;
  } catch {
    return true;
  }
}

// Exact counts for trend buckets at the window edges.
//
// The step grid does not start at `from` or end at `to`, so Loki's count for an
// edge bucket includes lines outside the window: before `from` for the first
// bucket, after `to` for the last. A 1h trend from 14:34 reported its onset at
// 14:00 and 18 lines when the window held 6. Each partial bucket is re-counted
// over exactly the part inside the window — at most two small instant queries.
async function exactEdgeCounts(uid, logQuery, buckets) {
  const edges = (buckets || []).filter((b) => b.partial && b.partial.seconds > 0);
  if (!edges.length) return buckets;
  const exact = {};
  await Promise.all(
    edges.map(async (b) => {
      try {
        const d = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query", {
          query: `sum(count_over_time(${logQuery} [${b.partial.seconds}s]))`,
          time: `${Math.round(Date.parse(b.partial.to) / 1000)}000000000`,
        });
        exact[b.time] = Number(d?.data?.result?.[0]?.value?.[1] ?? 0);
      } catch {
        exact[b.time] = null;
      }
    }),
  );
  return applyEdgeCounts(buckets, exact);
}

// Node placement for a set of pods, via kube_pod_info.
//
// Queried per cluster, 40 namespaces at a time: a broad scope spans hundreds of
// namespaces, and one alternation of all of them would not fit in a URL.
// last_over_time over the window so a pod replaced during it is still placed.
async function kubePodInfo(pods, { start, end }) {
  const uid = metricsDatasourceUid();
  if (!uid) {
    return {
      note:
        "Pods were not placed on nodes: set GRAFANA_METRICS_DATASOURCE_UID to a Prometheus datasource that scrapes " +
        "kube-state-metrics.",
    };
  }
  try {
    const ds = await assertReadOnly(uid);
    if (ds.type !== "prometheus") {
      return { note: `GRAFANA_METRICS_DATASOURCE_UID is a ${ds.type} datasource, not prometheus; pods not placed on nodes.` };
    }
  } catch (err) {
    return { note: `Pods not placed on nodes: ${err.message}` };
  }
  const byCluster = new Map();
  for (const p of pods || []) {
    if (!p?.namespace || !p?.pod) continue;
    const c = p.cluster || "";
    if (!byCluster.has(c)) byCluster.set(c, new Set());
    byCluster.get(c).add(p.namespace);
  }
  const range = `${Math.max(end - start, 60)}s`;
  const queries = [];
  for (const [c, nsSet] of byCluster) {
    const ns = [...nsSet];
    for (let i = 0; i < ns.length; i += 40) {
      const alternation = ns.slice(i, i + 40).map((n) => escapeRegex(n)).join("|");
      const clusterMatch = c ? `cluster="${String(c).replace(/["\\]/g, "")}", ` : "";
      queries.push(
        "max by (cluster, namespace, pod, node, host_ip) (" +
          `last_over_time(kube_pod_info{${clusterMatch}namespace=~\`^(?:${alternation})$\`}[${range}]))`,
      );
    }
  }
  const MAX_QUERIES = 30;
  const settled = await Promise.allSettled(
    queries.slice(0, MAX_QUERIES).map((query) => grafanaDatasourceProxyGet(uid, "api/v1/query", { query, time: String(end) })),
  );
  const out = [];
  let failed = 0;
  for (const r of settled) {
    if (r.status === "fulfilled") for (const x of r.value?.data?.result || []) out.push(x?.metric || {});
    else failed++;
  }
  const notes = [];
  if (failed) notes.push(`${failed} of ${settled.length} node-placement queries failed; their pods are listed without a node.`);
  if (queries.length > MAX_QUERIES) notes.push("The scope spans too many namespaces to place every pod on a node; narrow it.");
  return { pods: out, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

// Upstream IPs -> pods and nodes, via kube-state-metrics.
//
// kube_pod_info carries node and host_ip but no pod IP; kube_pod_ips carries the
// pod IP. Joined on (namespace, pod) they map an access log's upstream address
// to the node it ran on — the step that turned "some pods are failing" into
// "every failing pod is on one node". last_over_time over the window so a pod
// that was replaced during it is still found; an IP can therefore list more
// than one pod, and the result says so.
async function podsByIp(cluster, ips, { start, end }) {
  if (!metricsDatasourceUid()) {
    return {
      note:
        "Upstream IPs were not resolved to pods: set GRAFANA_METRICS_DATASOURCE_UID to a Prometheus " +
        "datasource that scrapes kube-state-metrics.",
    };
  }
  const unique = [...new Set((ips || []).filter((ip) => /^[0-9a-f.:]+$/i.test(ip)))].slice(0, 100);
  if (!unique.length) return { pods: new Map() };
  try {
    const ds = await assertReadOnly(metricsDatasourceUid());
    if (ds.type !== "prometheus") {
      return { note: `GRAFANA_METRICS_DATASOURCE_UID is a ${ds.type} datasource, not prometheus; pods not resolved.` };
    }
  } catch (err) {
    return { note: `Pods not resolved: ${err.message}` };
  }
  const safeCluster = String(cluster).replace(/["\\]/g, "");
  const range = `${Math.max(end - start, 60)}s`;
  const query =
    "max by (ip, namespace, pod, node, host_ip) (" +
    `last_over_time(kube_pod_ips{cluster="${safeCluster}", ip=~\`${unique.map((ip) => escapeRegex(ip)).join("|")}\`}[${range}]) ` +
    "* on (namespace, pod) group_left (node, host_ip) " +
    `max by (namespace, pod, node, host_ip) (last_over_time(kube_pod_info{cluster="${safeCluster}"}[${range}])))`;
  try {
    const data = await grafanaDatasourceProxyGet(metricsDatasourceUid(), "api/v1/query", { query, time: String(end) });
    const pods = new Map();
    for (const r of data?.data?.result || []) {
      const m = r?.metric || {};
      if (!m.ip) continue;
      const list = pods.get(m.ip) || [];
      list.push({ pod: m.pod || null, namespace: m.namespace || null, node: m.node || null, host_ip: m.host_ip || null });
      pods.set(m.ip, list);
    }
    return { pods, query };
  } catch (err) {
    return { note: `Pods not resolved: ${err.reason || err.message}`, query };
  }
}

// When a logs query returns nothing, the `client` text often just doesn't match
// any `service_name`. Fetch the label's values and suggest the closest ones so
// the caller can correct the spelling. Returns a small, de-duplicated list.
async function suggestClients(client, { from } = {}) {
  let values = [];
  try {
    const data = await grafanaDatasourceProxyGet(LOGS_DATASOURCE_UID, "loki/api/v1/label/service_name/values", {
      start: toLokiNs(from, 60 * 60),
    });
    values = data?.data || [];
  } catch {
    return [];
  }
  return rankClientSuggestions(values, client);
}

// grafana_logs_trend / grafana_logs_patterns scope a customer exactly the way
// grafana_logs_link does — same namespace resolution, same selector — so the
// three tools always describe the same set of logs. Returns the selector plus the
// namespaces it resolved to.
async function resolveCustomerSelector({ client, component, lineFilter, from, controlPlaneId, caseSensitive = false }) {
  const resolution = await resolveNamespaces(client, { from, control_plane_id: controlPlaneId });
  const pinned = resolution.namespaces.length ? resolution.namespaces : undefined;
  return {
    resolution,
    namespaces: resolution.namespaces,
    selector: buildLogsQuery({ client, component, lineFilter, namespaces: pinned, caseSensitive }),
  };
}

// The parts of a resolution worth returning to the caller: how the customer was
// found, and whether the mapping behind it was live or a fallback.
function resolutionReport(resolution = {}) {
  const out = { resolved_via: resolution.via };
  for (const key of [
    "map_source",
    "map_generated_at",
    "map_generated_days_ago",
    "label_namespaces",
    "matched_deployments",
    "env_filter_applied",
    "namespace_match_ignored",
    "unknown_qualifiers",
    "known_environments",
    "known_regions",
    "qualifier_note",
    "shared_control_plane_namespaces",
    "ambiguous_customer",
    "candidates",
    "spans_multiple_organizations",
    "organizations_note",
    "control_plane_ids",
    "mapped_namespaces_absent_in_range",
  ]) {
    if (resolution[key] !== undefined && resolution[key] !== null) out[key] = resolution[key];
  }
  if (resolution.map_warning) out.map_warning = resolution.map_warning;
  if (resolution.note) out.customer_note = resolution.note;
  return out;
}

// Resolve a Grafana-style range to whole seconds for Loki's query_range.
function rangeSeconds(from, to) {
  const start = Math.floor(Number(toLokiNs(from, 24 * 3600)) / 1e9);
  const end = Math.floor(Number(toLokiNs(to, 0)) / 1e9);
  return { start, end };
}

async function withToolLogging(tool, fields, fn) {
  const start = Date.now();
  log("info", "Tool call started", { tool, ...fields });
  try {
    const result = await fn();
    log("info", "Tool call succeeded", { tool, duration_ms: Date.now() - start });
    return result;
  } catch (err) {
    log("error", "Tool call failed", {
      tool,
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MCP server + tool registration
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "grafana-mcp-adapter",
  version: "0.1.0",
});

// Registered tool handlers, keyed by tool name, so tests can invoke the tool
// orchestration directly (with fetch stubbed) without going through the stdio
// transport. `server.tool()` returns a registration object carrying `.handler`.
export const tools = {};
function registerTool(name, ...rest) {
  tools[name] = server.tool(name, ...rest).handler;
}

registerTool(
  "grafana_health",
  "Read-only Grafana health/config check. Reports reachability and whether the token " +
    "carries the optional datasources:read permission.",
  {},
  async () =>
    withToolLogging("grafana_health", {}, async () => {
      requireConfig();
      // Probe with an endpoint every authenticated user can read. Probing via
      // /api/datasources would make health report "unhealthy" for a correctly
      // Viewer-scoped token — failing on privilege rather than on reachability,
      // and contradicting this adapter's own advice to run as a Viewer.
      const cat = await frontendDatasources({ refresh: true });
      const probe = await listDatasources();
      const readable = probe.source === "datasources";
      return textResult({
        status: "ok",
        enabled: ENABLED,
        base_url: BASE_URL,
        reachable: true,
        datasource_count: readable ? probe.count : cat.byUid.size,
        // Surfaced because it has no default: unset means the logs tools cannot
        // work, and that should be visible from health rather than discovered
        // as an empty result later.
        logs_datasource_uid: LOGS_DATASOURCE_UID || null,
        logs_datasource_configured: Boolean(LOGS_DATASOURCE_UID),
        // Optional: queries work without it. Only the full datasource listing needs it.
        datasources_readable: readable,
        ...(readable
          ? {}
          : {
              note:
                "Token lacks the datasources:read permission, which is expected for a " +
                "Viewer-scoped token. Querying and log links are unaffected; the datasource " +
                "list comes from /frontend/settings (uid/name/type only).",
            }),
      });
    }),
);

registerTool(
  "grafana_list_datasources",
  "Read-only list of configured Grafana datasources. Returns uid, name, type and " +
    "is_default. Use a datasource uid with grafana_query.",
  {},
  async () => withToolLogging("grafana_list_datasources", {}, async () => textResult(await listDatasources())),
);

registerTool(
  "grafana_query",
  "Read-only metric/log query via Grafana's /api/ds/query. Provide the datasource " +
    "uid (from grafana_list_datasources) and either `expr` (PromQL/LogQL) or `query` " +
    "(the datasource's own query fields, for types that do not use `expr`), plus an " +
    "optional time range. `expr` works ONLY for Prometheus and Loki; other types reject " +
    "it. Use `query` for them, e.g. Elasticsearch: " +
    '{\"query\":\"*\",\"timeField\":\"@timestamp\",\"metrics\":[{\"id\":\"1\",\"type\":\"count\"}],' +
    '\"bucketAggs\":[{\"id\":\"2\",\"type\":\"date_histogram\",\"field\":\"@timestamp\",\"settings\":{\"interval\":\"auto\"}}]}; ' +
    'Graphite: {\"target\":\"some.metric\"}. ' +
    "CloudWatch is BILLABLE and METRICS ONLY: every CloudWatch query is metered by AWS " +
    "(unlike the free Loki/Prometheus reads), and Logs Insights queries are refused " +
    "outright because they bill per GB scanned. CloudWatch results carry a billing_notice. " +
    "Prefer another datasource when one can answer the question. " +
    "By default returns a compact " +
    "digest: for metrics, one entry per series (labels + count/first/last/min/max/avg); " +
    "for Loki log queries, the line count, time window, the streams the lines came from " +
    "and the DISTINCT KINDS of line present — near-identical lines are collapsed into one " +
    "entry with an `occurrences` count, so a repeated message is reported once rather than " +
    "filling the sample, and rarer kinds stay visible; for anything else (e.g. Elasticsearch " +
    "raw documents) " +
    "the row count, the columns and a few sample rows. Pass raw=true for the " +
    "full (potentially very large) " +
    "frames. Log queries are capped at max_lines lines (Grafana defaults to 100 when " +
    "unset); when the cap is hit the result says so, AND reports how much of the requested " +
    "window those lines actually span — Loki fills the cap backwards from the window end, so a " +
    "capped 1-hour query may cover only its last minute. Every log result carries a `coverage` " +
    "verdict: NO_DATA_SCANNED (Loki scanned zero bytes: wrong selector or window, NOT evidence of " +
    "absence), EMPTY_BUT_SCANNED (trustworthy negative), EMPTY_BUT_SAMPLED (scanned, but Adaptive Logs discards lines, so the absence of one line is not proof), TRUNCATED, or OK. Check it before " +
    "reporting any negative finding. Times accept 'now-1h', epoch ms, or ISO 8601 with an explicit " +
    "offset; a timestamp without a timezone is refused rather than guessed. " +
    "Only datasources whose query language is " +
    `read-only are allowed (types: ${[...READONLY_QUERY_TYPES].join(", ")}); a uid of ` +
    "any other type is rejected. For metric queries the step follows max_data_points (or pass step), and output='timeline' returns [timestamp, value] pairs to show WHEN something changed. compare_offset (1d, 7d) re-runs the query over the same window that much earlier and labels each series similar/higher/lower/new/gone — use it before calling any level incident impact. When a result spans several Gravitee Cloud data-plane namespaces (apim-dp-<cp>-<dp>), owner_rollup groups them by the control plane that owns them, where each control plane runs, and its customers: a spread over many namespaces and clusters often traces to a few control planes.",
  {
    datasource_uid: z.string().describe("Datasource uid from grafana_list_datasources."),
    expr: z.string().optional().describe("Query expression. Prometheus (PromQL) and Loki (LogQL) only."),
    query: z
      .record(z.any())
      .optional()
      .describe(
        "Native query fields for datasource types that do not use `expr` (Elasticsearch, " +
          "Graphite, Pyroscope). Merged into the query sent to Grafana. The " +
          "datasource is always pinned from datasource_uid and cannot be overridden here.",
      ),
    from: z.string().default("now-1h").describe("Range start, e.g. 'now-1h' or epoch ms."),
    to: z.string().default("now").describe("Range end, e.g. 'now' or epoch ms."),
    max_data_points: z
      .number().int().min(1).max(5000).default(1000).optional()
      .describe(
        "Resolution for METRIC queries: the range is divided into this many points (minimum step 1s). " +
          "Has no effect on log queries — use max_lines for those.",
      ),
    max_lines: z
      .number().int().min(1).max(5000).default(100).optional()
      .describe("Maximum log lines to return for a Loki log query. Grafana's own default is 100."),
    raw: z.boolean().default(false).optional().describe("Return the full raw frames instead of the digest. Can be very large."),
    step: z
      .string()
      .optional()
      .describe("Explicit step for METRIC queries (30s, 5m, 15m, 1h). Overrides max_data_points."),
    output: z
      .enum(["digest", "timeline"])
      .default("digest")
      .optional()
      .describe(
        "digest (default): per-series first/last/min/max/avg. timeline: [timestamp, value] pairs per series " +
          "at the step — use it to see WHEN something changed; the digest hides the shape.",
      ),
    compare_offset: z
      .string()
      .optional()
      .describe(
        "Also run the identical query over the same-length window this long EARLIER (1d, 7d, 1w) and report both " +
          "with a ratio and a change label. Do this before reading any level as incident impact: an earlier hour " +
          "the same day is a different traffic regime, and a chronic pattern compared against it reads as new.",
      ),
  },
  async ({ datasource_uid, expr, query, from = "now-1h", to = "now", max_data_points = 1000, max_lines = 100, raw = false, step, output = "digest", compare_offset }) =>
    withToolLogging("grafana_query", { datasource_uid }, async () => {
      if (!expr && !query) throw new Error("either expr (Prometheus/Loki) or query (other datasource types) is required");
      const ds = await assertReadOnly(datasource_uid);
      // Type-level allowlisting is not enough for CloudWatch: the same datasource
      // can run cheap metric reads or unbounded, billable Logs Insights scans.
      if (ds.type === "cloudwatch") {
        assertCloudwatchNotBillableLogs(query || {});
        log("warn", "Billable datasource queried", { tool: "grafana_query", datasource_uid, type: ds.type });
      }
      const window = resolvedWindow(from, to, 3600);
      if (compare_offset && raw) {
        throw new Error("compare_offset is not supported with raw=true: two raw payloads cannot be compared. Use the digest or output='timeline'.");
      }
      const offsetSeconds = compare_offset ? parseCompareOffset(compare_offset, { windowSeconds: window.duration_seconds }) : null;
      const intervalMs = queryIntervalMs({
        startMs: window.start_ms,
        endMs: window.end_ms,
        maxDataPoints: max_data_points,
        step,
      });
      const dsQuery = (qFrom, qTo) =>
        grafanaPost("/ds/query", {
        from: qFrom,
        to: qTo,
        queries: [
          {
            // `query` is spread FIRST so the fields below always win. The
            // datasource in particular must not be overridable: assertReadOnly
            // verified datasource_uid, so letting a caller-supplied field
            // replace it would route the query to an unverified datasource and
            // defeat the read-only guard entirely.
            ...(query || {}),
            refId: "A",
            datasource: { uid: datasource_uid, type: ds.type },
            ...(expr === undefined ? {} : { expr }),
            // maxDataPoints sets the resolution of a METRIC query. Grafana's
            // Loki backend ignores it for log queries and caps those with
            // maxLines instead (defaulting to 100 when neither the query nor
            // the datasource sets it), so both have to be sent explicitly —
            // otherwise the line cap is invisible and uncontrollable.
            maxDataPoints: max_data_points,
            // Without intervalMs, /api/ds/query evaluates Loki and Prometheus
            // metric queries at a 1s step regardless of maxDataPoints: 3,601
            // points for one hour, unreadable in the digest and over the result
            // limit raw.
            intervalMs,
            maxLines: max_lines,
          },
        ],
      });
      const payload = await dsQuery(from, to);
      // The same query, step and window length, compare_offset earlier.
      const baseline = offsetSeconds
        ? { start_ms: window.start_ms - offsetSeconds * 1000, end_ms: window.end_ms - offsetSeconds * 1000 }
        : null;
      const baselinePayload = baseline ? await dsQuery(String(baseline.start_ms), String(baseline.end_ms)) : null;
      const baselineWindowUtc = baseline
        ? `${new Date(baseline.start_ms).toISOString()} .. ${new Date(baseline.end_ms).toISOString()}`
        : null;
      if (raw) {
        // The raw frames carry the cap silently: a log query that hit it looks
        // exactly like one that didn't. Flag it rather than let a partial page
        // be read as the complete set.
        return textResult(withBillingNotice(withRawTruncationNote(payload, max_lines), ds.type));
      }
      // The scope note describes LOG scoping. On a Prometheus query it claimed
      // "application logs only" about kube_pod_info.
      const scope = ds.type === "loki" && expr && scopeNote(expr) ? { scope_applied: expr, scope_note: scopeNote(expr) } : {};
      const windowReport = {
        requested: { from, to },
        resolved_utc: `${window.from_utc} .. ${window.to_utc}`,
        step_seconds: Math.round(intervalMs / 1000),
      };
      if (output === "timeline") {
        const timeline = timelineFromPayload(payload, { maxPoints: max_data_points });
        let timelineComparison = null;
        if (baselinePayload) {
          attachBaselineTimeline(timeline, timelineFromPayload(baselinePayload, { maxPoints: max_data_points }), offsetSeconds);
          const all = Object.values(timeline).flatMap((r) => r.series || []);
          const missing = all.filter((x) => x.baseline_missing).length;
          timelineComparison = {
            offset: compare_offset,
            baseline_window_utc: baselineWindowUtc,
            series_with_baseline: all.length - missing,
            series_without_baseline: missing,
            note:
              "baseline_points are the same series compare_offset earlier, shifted forward so their timestamps line up with points." +
              (missing
                ? ` ${missing} series had no counterpart then (no data in that window, or different labels): baseline_points is null for those, not zero.`
                : ""),
          };
        }
        return textResult(
          withBillingNotice(
            { window: windowReport, ...scope, ...(timelineComparison ? { comparison: timelineComparison } : {}), results: timeline },
            ds.type,
          ),
        );
      }

      const digest = summarizeQueryResult(payload, { limit: max_lines, window });
      if (ds.type === "loki" && expr) {
        const entries = Object.values(digest.results || {});
        // An empty log result has no streams to carry the sampling label, and a
        // metric result has aggregated it away — exactly the two cases where a
        // number or an absence gets over-trusted. Check the stream directly.
        const needsCheck = entries.some(
          (e) => !e.adaptive_logs_sampling && (e.coverage === "EMPTY_BUT_SCANNED" || e.series_count !== undefined),
        );
        const spot = needsCheck ? await samplingSpotCheck(datasource_uid, expr, window) : null;
        for (const e of entries) {
          const sampling = e.adaptive_logs_sampling || spot;
          if (sampling) applySamplingToCoverage(e, sampling);
        }
      }

      let comparison = null;
      if (baselinePayload) {
        const baselineWindow = { ...baseline, from_utc: null, to_utc: null };
        const baselineDigest = summarizeQueryResult(baselinePayload, { limit: max_lines, window: baselineWindow });
        let baselineAvailable = Object.values(baselineDigest.results || {}).some(
          (e) => (e.series_count ?? 0) > 0 || (e.line_count ?? 0) > 0 || (e.row_count ?? 0) > 0 || (e.stats?.bytes_processed ?? 0) > 0,
        );
        if (!baselineAvailable && ds.type === "loki" && expr) {
          baselineAvailable = await streamsExist(datasource_uid, expr, baseline.start_ms / 1000, baseline.end_ms / 1000);
        }
        comparison = {
          offset: compare_offset,
          baseline_window_utc: baselineWindowUtc,
          baseline_available: baselineAvailable,
          results: compareQueryDigests(digest, baselineDigest, { baselineAvailable }),
          change_labels: CHANGE_LABELS_NOTE,
          ...(ds.type === "cloudwatch" ? { billing_note: "compare_offset ran this billable query twice." } : {}),
        };
      }
      // Who owns a broad result. A data-plane namespace carries its control plane's
      // id in its name, so a spread over many namespaces and clusters rolls up to
      // the control planes behind it — and to where THOSE run, which is where a
      // problem that surfaces on data planes in every region usually starts.
      // Built from the raw payload: the digest keeps only 50 series.
      let ownerRollup = null;
      try {
        const weights = namespaceWeightsFromPayload(payload);
        const dpNamespaces = [...weights.keys()].filter((n) => controlPlaneOfNamespace(n));
        if (dpNamespaces.length >= OWNER_ROLLUP_MIN_NAMESPACES) {
          const cps = [...new Set(dpNamespaces.map(controlPlaneOfNamespace))];
          const [clusterInfo, map] = await Promise.all([
            LOGS_DATASOURCE_UID
              ? resolveClusters(cps.slice(0, 100).map(controlPlaneNamespace), { from })
              : Promise.resolve({ by_namespace: {} }),
            loadCustomerMap().catch(() => ({ rows: [] })),
          ]);
          const customers = {};
          for (const row of map?.rows || []) {
            if (!row.control_plane_id || !cps.includes(row.control_plane_id)) continue;
            (customers[row.control_plane_id] ||= new Set()).add(row.customer);
          }
          ownerRollup = buildOwnerRollup(weights, {
            controlPlaneClusters: clusterInfo?.by_namespace || {},
            customersByControlPlane: Object.fromEntries(Object.entries(customers).map(([k, v]) => [k, [...v].sort()])),
          });
        }
      } catch (err) {
        ownerRollup = { error: `owner rollup unavailable: ${err.message}` };
      }

      return textResult(
        withBillingNotice(
          {
            // Echo the window the query actually ran over. A wrong window is the
            // commonest cause of a confident empty answer, and it belongs in the
            // result rather than being inferred from surprise at the results.
            window: windowReport,
            ...scope,
            ...digest,
            ...(comparison ? { comparison } : {}),
            ...(ownerRollup ? { owner_rollup: ownerRollup } : {}),
          },
          ds.type,
        ),
      );
    }),
);

registerTool(
  "grafana_logs_link",
  "Read-only: build a shareable Grafana logs link for a customer's logs. Discovers " +
    "which log streams match (via Loki's /series — label sets only, no log lines) so " +
    "the link is scoped to the exact service_name values that exist. Identify the " +
    "customer/component with free text (e.g. client='april', component='gateway') — it " +
    "matches case-insensitively against the `service_name` label, which encodes both. " +
    "Optionally pre-fill the link's line filter with line_filter. Default range is the " +
    "last 1 hour; widen with from/to (e.g. from='now-6h'). " +
    "link_style controls the link format: 'drilldown' (default) builds Grafana's Logs " +
    "Drilldown app links (the 'Logs' menu), navigated per-namespace, so the user can " +
    "filter/drill by hand; 'explore' builds a raw Explore (LogQL) deep link instead. " +
    "Returns { query, links, range, matched_count, matched_streams }; `links` is " +
    "per-namespace for drilldown (multitenant customers can span several). When a " +
    "line_filter is set, each drilldown link also carries an `explore_url`: the Logs " +
    "Drilldown app pre-fills the filter but doesn't apply it on load, so paste the " +
    "explore_url for evidence — it honours the filter immediately. Ask the user before " +
    "widening the range since logs are large. For several queries, split panes or other datasources, use grafana_explore_link.",
  {
    client: z.string().describe("Customer name fragment, e.g. 'april', 'alliander', 'apim-cloudgate'."),
    component: z.string().optional().describe("Component fragment, e.g. 'gateway', 'engine', 'ui'."),
    line_filter: z.string().optional().describe("Pre-fill the link's line filter with this substring (lines containing it)."),
    case_sensitive: z
      .boolean()
      .default(false)
      .optional()
      .describe(
        "Match line_filter case-sensitively. Default false: `|=` is case-sensitive, and a wrong-case " +
          "filter returns a clean, believable empty result rather than an error.",
      ),
    link_style: z
      .enum(["drilldown", "explore"])
      .default("drilldown")
      .describe("Link format: 'drilldown' (Logs Drilldown app, per-namespace; default) or 'explore' (raw LogQL Explore)."),
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization when a customer name spans several (see grafana_find_customer)."),
    from: z.string().default("now-1h").describe("Range start, e.g. 'now-1h', 'now-6h', or epoch ms."),
    to: z.string().default("now").describe("Range end, e.g. 'now' or epoch ms."),
  },
  async ({ client, component, line_filter, link_style = "drilldown", control_plane_id, case_sensitive = false, from = "now-1h", to = "now" }) =>
    withToolLogging("grafana_logs_link", { client, component, link_style, from, to }, async () => {
      // Fail loudly and once, rather than querying a nonexistent datasource and
      // reporting "no log streams matched" for what is really a config error.
      requireDatasourceUid(LOGS_DATASOURCE_UID);
      // Prefer the customer's own namespace when it has one (`april-prod`,
      // `blueyonder-plt-live`): the namespace names the customer reliably,
      // whereas `service_name` doesn't for every tenant. Customers that only
      // live in a shared namespace (`prod`) resolve to [] and fall back to the
      // plain service_name match.
      const resolution = await resolveNamespaces(client, { from, control_plane_id });
      const namespaces = resolution.namespaces;
      const pinned = namespaces.length ? namespaces : undefined;
      // The selector we discover streams with carries no line filter — /series
      // matches on the stream selector only, and the line_filter is applied in
      // the generated link itself, not here.
      let query = buildLogsQuery({ client, component, namespaces: pinned, caseSensitive: case_sensitive });
      let streams = await fetchMatchingStreams({ query, from, to });

      // Re-attach the line filter to the reported query so the caller sees the
      // full LogQL (the discovery query above intentionally omitted it). Only
      // rebuild when there's actually a line filter to add — otherwise `query`
      // (already env-adjusted by the retry) is exactly what we'd produce.
      const reportedQuery = line_filter
        ? buildLogsQuery({ client, component, lineFilter: line_filter, namespaces: pinned, caseSensitive: case_sensitive })
        : query;

      const result = {
        query: reportedQuery,
        link_style,
        scope_applied: reportedQuery,
        scope_note: scopeNote(reportedQuery),
        resolved_namespaces: namespaces,
        ...resolutionReport(resolution),
        range: { from, to },
        matched_count: streams.length,
        matched_streams: streams,
      };

      if (link_style === "explore") {
        // Single raw Explore (LogQL) deep link.
        result.links = [{ url: buildExploreUrl({ datasourceUid: LOGS_DATASOURCE_UID, query: reportedQuery, from, to }) }];
      } else {
        // Logs Drilldown navigates per-namespace. Group the matched streams by
        // namespace (a multitenant customer can span several, e.g. two data plane
        // gateways) and emit one link each, scoped to the EXACT service_name
        // values seen in that namespace — the app treats a raw regex value as a
        // literal, so we can't reuse the LogQL selector here.
        const byNamespace = new Map();
        for (const s of streams) {
          if (!s.namespace) continue;
          if (!byNamespace.has(s.namespace)) byNamespace.set(s.namespace, new Set());
          if (s.service_name) byNamespace.get(s.namespace).add(s.service_name);
        }
        result.links = [...byNamespace.entries()].map(([namespace, names]) => {
          const serviceNames = [...names];
          const link = {
            namespace,
            service_names: serviceNames,
            // The Drilldown app cannot honour a multi-service filter (it
            // regex-escapes a `=~` alternation, and truncates its own
            // multi-value operator past two values), so such links are scoped to
            // the namespace. Say so, rather than let the caller assume the link
            // is narrowed to service_names.
            ...(serviceNames.length > 1
              ? {
                  scope: "namespace",
                  scope_note:
                    `Link is scoped to namespace "${namespace}" only — the Logs Drilldown app cannot ` +
                    `filter on ${serviceNames.length} service_name values. Use explore_url, or the ` +
                    "app's own filter UI, to narrow to specific services.",
                }
              : { scope: "service_name" }),
            url: buildDrilldownUrl({
              namespace,
              serviceNames,
              datasourceUid: LOGS_DATASOURCE_UID,
              from,
              to,
              lineFilter: line_filter,
              caseSensitive: case_sensitive,
            }),
          };
          // The Logs Drilldown app pre-fills the line filter in its box but does
          // not apply it on load (it renders empty until the user re-types it).
          // When a line_filter is set, attach a raw Explore (LogQL) link scoped to
          // this namespace's exact service_names — Explore honours the filter
          // immediately, so it's the reliable evidence link.
          if (line_filter) {
            link.explore_url = buildExploreUrl({
              datasourceUid: LOGS_DATASOURCE_UID,
              query: buildExactLogsQuery({ namespace, serviceNames, lineFilter: line_filter, caseSensitive: case_sensitive }),
              from,
              to,
            });
          }
          return link;
        });
      }

      // No streams: if we resolved the customer's namespace(s) but nothing
      // matched, the customer is right — it's just a quiet range (or the
      // component/env narrowed too far). Otherwise the `client` text likely
      // didn't match any service_name; offer close matches to correct it.
      if (streams.length === 0) {
        const absent = resolution.mapped_namespaces_absent_in_range || [];
        if (absent.length) {
          result.note =
            `No log streams matched, and ${absent.length} of the mapped namespace(s) (${absent.join(", ")}) do not ` +
            "appear in Loki for this range at all. That usually means the customer map is stale — the deployment was " +
            "recreated under a new id — rather than that the customer has no logs. Check grafana_find_customer, or " +
            "widen from/to in case the deployment is simply dormant.";
        } else if (namespaces.length) {
          result.note = `No log streams in this range for namespace(s) ${namespaces.join(", ")}. Try widening from/to or relaxing component/env.`;
        } else {
          const suggestions = await suggestClients(client, { from });
          if (suggestions.length) {
            result.note = `No log streams matched in this range. Did you mean one of these service_name values? Re-run with a closer 'client'.`;
            result.suggestions = suggestions;
          } else {
            result.note = `No log streams matched in this range. Try widening from/to or adjusting client/component.`;
          }
        }
      }
      return textResult(result);
    }),
);

registerTool(
  "grafana_logs_trend",
  "Read-only: how a customer's matching log volume changes over time — the 'when did " +
    "this start?' tool. Counts matching lines into fixed time buckets and reports the " +
    "total, the first bucket with any matches (onset), the last, and the peak. Scopes " +
    "the customer exactly like grafana_logs_link (client='april', component='gateway'). " +
    "Use line_filter to trend one error rather than all traffic. The bucket size is " +
    "chosen from the range; override with interval (30s/5m/1h/1d). Default range is the " +
    "last 24h, because incidents are usually reported well after they start. Returns " +
    "counts only — no log lines. " +
    "NOT COVERED by `client`: HTTP access logs — status codes, request durations, upstream response " +
    "times — come from the shared ingress controller at {cluster=\"<cluster>\", job=~\"flow/ingress-nginx-ingress-nginx|flow/app-routing-system-\"}, " +
    "NOT the customer's namespaces. Application logs are in the customer namespace; request logs are " +
    "not. Use grafana_http_requests for those. compare_offset (1d, 7d) adds the same window that much earlier: a baseline count per bucket and a similar/higher/lower/new label on the total. Bucket times are interval STARTS, so onset is the start of the first non-empty interval; for the exact first line use grafana_first_occurrence.",
  {
    client: z.string().describe("Customer name fragment, e.g. 'april', 'demo qa'."),
    component: z.string().optional().describe("Component fragment, e.g. 'gateway', 'api'."),
    line_filter: z.string().optional().describe("Only count lines containing this substring."),
    case_sensitive: z
      .boolean()
      .default(false)
      .optional()
      .describe("Match line_filter case-sensitively. Default false, so a wrong-case filter does not read as zero."),
    from: z.string().default("now-24h").describe("Range start, e.g. 'now-24h', 'now-7d', or epoch ms."),
    to: z.string().default("now").describe("Range end."),
    interval: z.string().optional().describe("Bucket size (30s, 5m, 1h, 1d). Defaults to a size giving a readable number of buckets."),
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization (see grafana_find_customer)."),
    compare_offset: z
      .string()
      .optional()
      .describe(
        "Also run the identical query over the same-length window this long EARLIER (1d, 7d, 1w) and report both " +
          "with a ratio and a change label. Do this before reading any level as incident impact: an earlier hour " +
          "the same day is a different traffic regime, and a chronic pattern compared against it reads as new.",
      ),
  },
  async ({ client, component, line_filter, from = "now-24h", to = "now", interval, control_plane_id, case_sensitive = false, compare_offset }) =>
    withToolLogging("grafana_logs_trend", { client, component, from, to }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);
      const { namespaces, selector, resolution } = await resolveCustomerSelector({ client, component, lineFilter: line_filter, from, controlPlaneId: control_plane_id, caseSensitive: case_sensitive });
      const { start, end } = rangeSeconds(from, to);
      const step = interval || chooseInterval(Math.max(end - start, 1));
      const stepSeconds = durationSeconds(step);
      const offsetSeconds = compare_offset ? parseCompareOffset(compare_offset, { windowSeconds: end - start }) : null;

      // count_over_time's range vector matches the step, so buckets tile the
      // window exactly: no overlap (which double-counts) and no gaps.
      // Grouped by the sampling label so a sampled stream is visible in the same
      // read at no extra cost; the groups are summed back into one trend.
      const query = `sum by (${ADAPTIVE_LOGS_LABEL}) (count_over_time(${selector} [${step}]))`;
      const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query_range", {
        query,
        start: `${start * 1e9}`,
        // One step past the end: the point covering the final interval is stamped
        // after it, and would otherwise never be returned.
        end: `${(end + stepSeconds) * 1e9}`,
        step,
      });

      const { points, sampling: trendSampling } = collapseSampledMatrix(data?.data?.result || []);
      let buckets = await exactEdgeCounts(uid, selector, buildTrendBuckets(points, { startSeconds: start, endSeconds: end, stepSeconds }));
      const summary = summarizeTrend(buckets);

      // The same query, step and window length, compare_offset earlier. Each
      // bucket carries its baseline count, so "was this already happening at
      // this time yesterday?" is answered in the same read.
      let comparison = null;
      if (offsetSeconds) {
        const bStart = start - offsetSeconds;
        const bEnd = end - offsetSeconds;
        const bData = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query_range", {
          query,
          start: `${bStart}000000000`,
          end: `${bEnd + stepSeconds}000000000`,
          step,
        });
        const { points: bPoints } = collapseSampledMatrix(bData?.data?.result || []);
        const bBuckets = await exactEdgeCounts(uid, selector, buildTrendBuckets(bPoints, { startSeconds: bStart, endSeconds: bEnd, stepSeconds }));
        const bSummary = summarizeTrend(bBuckets);
        const baselineAvailable = bSummary.total > 0 || (await streamsExist(uid, selector, bStart, bEnd));
        const total = compareValues(summary.total, bSummary.total, { baselineAvailable });
        buckets = attachBaselineBuckets(buckets, bBuckets);
        comparison = {
          offset: compare_offset,
          baseline_window_utc: `${new Date(bStart * 1000).toISOString()} .. ${new Date(bEnd * 1000).toISOString()}`,
          total,
          baseline_peak: bSummary.peak,
          baseline_onset: bSummary.onset,
          note: describeChange(total, compare_offset, "matching line volume"),
          change_labels: CHANGE_LABELS_NOTE,
        };
      }

      const result = {
        query,
        scope_applied: selector,
        scope_note: scopeNote(selector),
        resolved_namespaces: namespaces,
        ...resolutionReport(resolution),
        range: { from, to },
        resolved_window_utc: `${new Date(start * 1000).toISOString()} .. ${new Date(end * 1000).toISOString()}`,
        interval: step,
        ...summary,
        ...(comparison ? { comparison } : {}),
        bucket_covers: BUCKET_COVERS_NOTE,
        buckets,
      };
      if (trendSampling) result.adaptive_logs_sampling = trendSampling;
      // An all-zero series and a broken query look identical in the numbers, so
      // say which one this is.
      if (summary.total === 0) {
        result.note =
          "No matching lines in this range — the query ran and returned zero, which is not the " +
          "same as an error. Widen from/to, relax component/line_filter, or check the client name " +
          "with grafana_logs_link.";
      }
      return textResult(result);
    }),
);

registerTool(
  "grafana_logs_patterns",
  "Read-only: the distinct SHAPES of a customer's log lines, ranked by volume, using " +
    "Loki's own pattern detection. Answers 'what is dominating this log volume?' without " +
    "reading thousands of near-identical lines — variable parts appear as <_>. Good for " +
    "characterising noise, seeing what a service normally emits, and spotting a NEW " +
    "high-volume error. " +
    "IMPORTANT — it will NOT surface rare lines. Loki only reports patterns above a " +
    "volume floor, so infrequent errors are absent entirely, not merely ranked last " +
    "(measured on this instance: the smallest reported pattern was 34 lines while a " +
    "10-line exception in the same window did not appear at all). The response reports " +
    "smallest_pattern_count so you can see that floor. To find or count a specific or " +
    "rare error, use grafana_logs_trend or grafana_query instead. " +
    "Scopes the customer exactly like grafana_logs_link. lines_in_patterns counts only " +
    "lines Loki assigned to a pattern, so it is NOT a total line count. Loki's pattern " +
    "endpoint does not support line filters. " +
    "NOT COVERED by `client`: HTTP access logs — status codes, request durations, upstream response " +
    "times — come from the shared ingress controller at {cluster=\"<cluster>\", job=~\"flow/ingress-nginx-ingress-nginx|flow/app-routing-system-\"}, " +
    "NOT the customer's namespaces. Application logs are in the customer namespace; request logs are " +
    "not. Use grafana_http_requests for those.",
  {
    client: z.string().describe("Customer name fragment, e.g. 'april', 'demo qa'."),
    component: z.string().optional().describe("Component fragment, e.g. 'gateway', 'api'."),
    from: z.string().default("now-24h").describe("Range start, e.g. 'now-24h'."),
    to: z.string().default("now").describe("Range end."),
    max_patterns: z.number().int().min(1).max(100).default(20).optional(),
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization (see grafana_find_customer)."),
  },
  async ({ client, component, from = "now-24h", to = "now", max_patterns = 20, control_plane_id }) =>
    withToolLogging("grafana_logs_patterns", { client, component, from, to }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);
      // No line filter: Loki's /patterns rejects a selector carrying one, so it
      // is not offered as a parameter rather than failing at request time.
      const { namespaces, selector, resolution } = await resolveCustomerSelector({ client, component, from, controlPlaneId: control_plane_id });
      const { start, end } = rangeSeconds(from, to);
      const step = chooseInterval(Math.max(end - start, 1));

      const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/patterns", {
        query: selector,
        start: `${start * 1e9}`,
        end: `${end * 1e9}`,
        step,
      });

      const summary = summarizePatterns(data?.data || [], { maxPatterns: max_patterns });
      const result = {
        query: selector,
        scope_applied: selector,
        scope_note: scopeNote(selector),
        resolved_namespaces: namespaces,
        ...resolutionReport(resolution),
        range: { from, to },
        resolved_window_utc: `${new Date(start * 1000).toISOString()} .. ${new Date(end * 1000).toISOString()}`,
        ...summary,
        // Travels with the data, not just in the docs: a caller reading this
        // result must not conclude "no errors" from the absence of an error
        // pattern.
        coverage_note:
          "Loki reports only patterns above a volume floor" +
          (summary.smallest_pattern_count ? ` (smallest here: ${summary.smallest_pattern_count} lines)` : "") +
          ". Rare lines are absent entirely, so this is not evidence that an infrequent error " +
          "did not occur — use grafana_logs_trend or grafana_query to check a specific string.",
      };
      if (summary.pattern_count === 0) {
        result.note =
          "Loki detected no patterns in this range. That can mean no logs matched, or that " +
          "pattern detection has nothing to group. Check volume with grafana_logs_trend.";
      }
      return textResult(result);
    }),
);

// An id rather than a name: `apim-dp-cp1111-dp0001` or `cp1111-dp0001`. Requires
// the apim- prefix or two hyphen-separated segments, so a plain customer name
// like "orbit" is never mistaken for an id. A bare control plane id ("cp1111")
// needs no test here — lookupById resolves it outright.
const ID_SHAPED = /^(apim-(dp|cp)-[0-9a-z-]+|[0-9a-z]+(-[0-9a-z]+)+)$/i;

registerTool(
  "grafana_find_customer",
  "Read-only: find which customers and deployments match a name, WITHOUT querying any " +
    "logs. Use this when a name is ambiguous, when a log tool reports ambiguous_customer, " +
    "or simply to see what a customer has. Searches both populations: Gravitee Cloud " +
    "(Cockpit) customers via the deployment map, and hosted customers via Loki's namespace " +
    "label. Returns per customer: deployment count, Cockpit organizations (control plane " +
    "ids), environments, regions and the exact namespaces — so the caller can pass a " +
    "precise client (or control_plane_id) to grafana_logs_link / _trend / _patterns. " +
    "ALSO returns the CLUSTER each customer is on. That matters because the namespaces are only half " +
    "of where their logs live: HTTP access logs — status codes, request durations, upstream response " +
    "times — are emitted by the shared ingress controller at {cluster=\"<cluster>\", " +
    "job=~\"flow/ingress-nginx-ingress-nginx|flow/app-routing-system-\"} and are unreachable from any namespace-scoped query. " +
    "Application logs are in the customer namespace; request logs are not. Pass the customer to " +
    "grafana_http_requests to read them.",
  {
    query: z
      .string()
      .describe(
        "Customer name or fragment ('money', 'orbit'), OR an id/namespace seen in an alert, pod or " +
          "dashboard ('apim-dp-cp1111-dp0001', 'cp1111-dp0001', 'cp1111') to look up who owns it.",
      ),
    max_results: z.number().int().min(1).max(50).default(20).optional(),
  },
  async ({ query, max_results = 20 }) =>
    withToolLogging("grafana_find_customer", { query }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);
      const needle = String(query || "").trim();

      const map = await loadCustomerMap();
      // Ids are the only handle a Cockpit tenant has in an alert or a pod name, so
      // the reverse lookup is always attempted - no guessing whether the query
      // "looks like" an id.
      const byId = lookupById(map.rows, query);
      // Ask the map where the name ends, so "acme recette" finds acme.
      const { core: mapName } = splitNameAndTail(map.rows, needle);
      const groups = groupByCustomer(matchCustomers(map.rows, mapName));
      const cockpit = [...groups.entries()]
        .map(([customer, rows]) => ({
          customer,
          kind: "gravitee_cloud",
          deployments: rows.length,
          organizations: [...new Set(rows.map((r) => r.control_plane_id).filter(Boolean))],
          envs: [...new Set(rows.map((r) => r.env).filter(Boolean))].sort(),
          regions: [...new Set(rows.map((r) => r.region).filter(Boolean))].sort(),
          namespaces: [...new Set(rows.map((r) => dataPlaneNamespace(r.data_plane_id)))],
          shared_control_plane_namespaces: [
            ...new Set(rows.map((r) => r.control_plane_id).filter(Boolean).map(controlPlaneNamespace)),
          ],
        }))
        .sort((a, b) => a.customer.localeCompare(b.customer));

      // Hosted customers have no map entry; their namespace carries the name.
      let hostedNamespaces = [];
      let allNamespaces = [];
      try {
        const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/label/namespace/values", {
          // 30 days: a deployment absent over that window is gone, not merely quiet.
          start: toLokiNs("now-30d", 30 * 24 * 3600),
        });
        allNamespaces = data?.data || [];
        hostedNamespaces = matchNamespaces(allNamespaces, needle);
      } catch {
        hostedNamespaces = [];
      }

      // Data planes that are live on this customer's control planes but which the
      // map does not attribute to anyone. They may belong to another customer on
      // the same (shared) control plane, so they are reported as unattributed and
      // never folded into the customer's namespaces.
      const mappedNs = new Set(map.rows.map((r) => dataPlaneNamespace(r.data_plane_id)));
      const cpOf = (n) => n.replace("apim-dp-", "").split("-").slice(0, -1).join("-");
      for (const entry of cockpit) {
        const unattributed = allNamespaces.filter(
          (n) => n.startsWith("apim-dp-") && entry.organizations.includes(cpOf(n)) && !mappedNs.has(n),
        );
        if (unattributed.length) {
          entry.unattributed_namespaces_on_same_control_plane = unattributed;
          entry.unattributed_note =
            "Live data planes on this customer's control plane that the map does not attribute to any customer. " +
            "A control plane is shared, so these may belong to someone else — they are NOT searched as this customer.";
        }
      }

      // The cluster label, for BOTH populations. Without it the caller has the
      // customer's application logs and no route at all to their HTTP request
      // logs, which live on the cluster's shared ingress and are the first thing
      // asked for when a hosted control plane is reported slow.
      const interesting = [...new Set([...cockpit.flatMap((c) => c.namespaces), ...hostedNamespaces])];
      const clusterInfo = await resolveClusters(interesting, { from: "now-30d" });
      for (const entry of cockpit) {
        const cs = [...new Set(entry.namespaces.flatMap((n) => clusterInfo.by_namespace[n] || []))].sort();
        if (cs.length) entry.clusters = cs;
      }

      const result = {
        query,
        ...(byId && byId.kind !== "unknown" ? { matched_by_id: byId } : {}),
        map_source: map.source,
        ...(map.generated_at ? { map_generated_at: map.generated_at } : {}),
        ...(map.generated_days_ago !== undefined ? { map_generated_days_ago: map.generated_days_ago } : {}),
        ...(map.warning ? { map_warning: map.warning } : {}),
        gravitee_cloud_customers: cockpit.slice(0, max_results),
        gravitee_cloud_truncated: cockpit.length > max_results ? cockpit.length - max_results : 0,
        hosted_namespaces: hostedNamespaces,
        ...(hostedNamespaces.length
          ? {
              hosted_clusters: [
                ...new Set(hostedNamespaces.flatMap((n) => clusterInfo.by_namespace[n] || [])),
              ].sort(),
            }
          : {}),
        ...(clusterInfo.clusters.length ? { clusters: clusterInfo.clusters } : {}),
        ...(clusterInfo.clusters.length
          ? {
              namespace_clusters: clusterInfo.by_namespace,
              http_request_logs_note:
                "The namespaces above hold APPLICATION logs. HTTP access logs — status codes, request " +
                "durations, upstream response times — are NOT in them: they are emitted by the shared " +
                "ingress controllers and identified by the cluster label, at " +
                `{cluster="${clusterInfo.clusters[0]}", job=~"${Object.values(INGRESS_JOBS).join("|")}"}` +
                " — ingress-nginx for gateway and management traffic, app-routing for bridge traffic. " +
                "The `client` parameter on the other log tools does not cover those. Use " +
                "grafana_http_requests, which resolves the cluster and scopes it to this customer.",
            }
          : {}),
      };

      if (cockpit.length > 1) {
        result.note =
          `"${query}" matches ${cockpit.length} different Gravitee Cloud customers. The log tools will not ` +
          "search them together — pass one exact customer name.";
      } else if (cockpit.length === 1 && cockpit[0].organizations.length > 1) {
        result.note =
          `"${cockpit[0].customer}" spans ${cockpit[0].organizations.length} separate Cockpit organizations ` +
          `(${cockpit[0].organizations.join(", ")}). Pass control_plane_id to narrow to one.`;
      } else if (byId && byId.kind === "unknown" && !cockpit.length && ID_SHAPED.test(query.trim())) {
        // A live namespace the map cannot attribute — 116 of these exist, 67 on
        // control planes the CSV has never heard of. Saying nothing here would
        // leave the caller thinking the lookup simply failed, when the real
        // answer is "this exists and nobody knows whose it is".
        const live = hostedNamespaces.length > 0;
        result.note =
          `${byId.note}${live ? " The namespace does exist in Loki, so this is a real deployment the map does not " +
          "cover — you can still query it directly by namespace, but its owner cannot be determined from the map." : ""}`;
      } else if (byId && byId.kind !== "unknown" && byId.note) {
        result.note = byId.note;
      } else if (!cockpit.length && !hostedNamespaces.length) {
        result.note =
          byId && byId.kind === "unknown"
            ? `No Gravitee Cloud customer, hosted namespace, or known id matched "${query}".`
            : `No Gravitee Cloud customer or hosted namespace matched "${query}".`;
      }
      return textResult(result);
    }),
);

registerTool(
  "grafana_logs_context",
  "Read-only: every log line around a moment in time, UNFILTERED — the 'what else was " +
    "happening right then' tool. Give it a timestamp (from a grafana_query sample, or an " +
    "ISO 8601 instant with an explicit offset) and it returns all lines in a tight window " +
    "on either side, in time order, merged across services. " +
    "Why unfiltered matters: a logger formatting with a newline emits SEPARATE Loki " +
    "entries. The first carries the text you searched for, the second carries the actual " +
    "reason and contains none of your keywords — the same for stack traces and 'Caused " +
    "by:' chains. A filtered query finds the header and hides the answer, one line away at " +
    "the same millisecond. This tool therefore REFUSES a line filter rather than warning " +
    "about one. " +
    "Scope it by client (resolved exactly like grafana_logs_link) or by exact namespace/" +
    "service_name from a previous result. Typical use: grafana_logs_trend to find when, " +
    "grafana_query to find the line and its timestamp, then this to read what surrounded it. " +
    "A gap here may not be a gap in the logs: Grafana Adaptive Logs drops lines before they reach " +
    "Loki, and multi-line content is hit hardest — an exception header can survive while its stack " +
    "frames are discarded, which reads as a truncated log rather than a sampling rule. When any " +
    "matched stream is being sampled this tool says so, with the sampling label's value; a per-cluster/" +
    "job exemption can be requested from the Platform team.",
  {
    at: z
      .string()
      .describe(
        "The instant to read around: an ISO 8601 timestamp WITH an explicit offset " +
          "(2026-08-20T15:00:00Z), epoch milliseconds, or the nanosecond value from a prior result.",
      ),
    client: z.string().optional().describe("Customer name fragment. Omit if giving an exact namespace."),
    component: z.string().optional().describe("Component fragment, e.g. 'gateway'."),
    namespace: z.string().optional().describe("Exact namespace, e.g. from a previous result's streams."),
    service_name: z.string().optional().describe("Exact service_name, to read one service rather than the whole namespace."),
    window_seconds: z
      .number().int().min(1).max(300).default(2).optional()
      .describe("Seconds either side of `at`. Default 2 — wide enough for a multi-line entry, narrow enough to read."),
    max_lines: z.number().int().min(1).max(1000).default(200).optional(),
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization (see grafana_find_customer)."),
    line_filter: z
      .string()
      .optional()
      .describe("NOT SUPPORTED — this tool refuses a line filter. Filtering is what hides the answer it exists to find."),
  },
  async ({ at, client, component, namespace, service_name, window_seconds = 2, max_lines = 200, control_plane_id, line_filter }) =>
    withToolLogging("grafana_logs_context", { client, namespace, at, window_seconds }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);

      // Refused, not warned about: a filter here re-creates the exact failure
      // this tool exists to solve, and a warning is easy to read past.
      if (line_filter) {
        throw new Error(
          "grafana_logs_context does not accept a line filter. Its purpose is to show the lines a filter " +
            "would hide — a continuation line carries the reason but none of the filter's keywords. " +
            "Use grafana_query to find the moment, then read around it here unfiltered.",
        );
      }
      if (!client && !namespace) throw new Error("either client or namespace is required");

      // Resolve the instant first: a bad timestamp must fail loudly here rather
      // than silently reading a different moment.
      const atNs = BigInt(toLokiNs(at, 0));
      const halfWindowNs = BigInt(Math.round(window_seconds * 1e9));
      const startNs = atNs - halfWindowNs;
      const endNs = atNs + halfWindowNs;

      let selector;
      let resolution = null;
      if (namespace) {
        const matchers = [`namespace="${namespace}"`];
        if (service_name) matchers.push(`service_name="${service_name}"`);
        selector = `{${matchers.join(", ")}}`;
      } else {
        const resolved = await resolveCustomerSelector({ client, component, from: at, controlPlaneId: control_plane_id });
        selector = resolved.selector;
        resolution = resolved.resolution;
      }

      const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query_range", {
        query: selector,
        start: startNs.toString(),
        end: endNs.toString(),
        // Forward: oldest first, so a continuation line follows the line it
        // continues. Backward would present the reason before the message.
        direction: "forward",
        limit: String(max_lines),
      });

      const merged = mergeContextStreams(data?.data?.result || [], { maxLines: max_lines });
      // Sampling is the difference between "nothing else was happening" and
      // "the rest was discarded before it reached Loki" — which is exactly the
      // question this tool exists to answer.
      const contextSampling = detectSampling(
        (data?.data?.result || []).map((r) => ({ labels: r.stream || {} })),
      );
      const result = {
        query: selector,
        scope_applied: selector,
        scope_note: scopeNote(selector),
        ...(contextSampling ? { adaptive_logs_sampling: contextSampling } : {}),
        ...(resolution ? resolutionReport(resolution) : {}),
        at: new Date(Number(atNs / 1000000n)).toISOString(),
        window: {
          from_utc: new Date(Number(startNs / 1000000n)).toISOString(),
          to_utc: new Date(Number(endNs / 1000000n)).toISOString(),
          seconds_either_side: window_seconds,
        },
        line_count: merged.total,
        lines: merged.lines,
        filtered: false,
      };
      if (merged.truncated) {
        result.truncated = merged.truncated;
        result.note =
          `${merged.total} lines fell in this window and ${merged.truncated} were dropped at max_lines. ` +
          "Narrow window_seconds or pin service_name to see the sequence around the moment itself.";
      }
      if (merged.total === 0) {
        result.note =
          "No lines in this window. Check the instant is right (it is echoed above in UTC) and that the " +
          "selector matches — grafana_logs_trend will show whether this stream has any data nearby.";
      }
      return textResult(result);
    }),
);

registerTool(
  "grafana_logs_noise",
  "Read-only: what is actually filling this log stream. Samples recent lines, reduces each " +
    "to its SHAPE by replacing the variable parts (timestamps, uuids, ips, numbers, stack " +
    "frames) with placeholders, and ranks the shapes by how much of the sample they account " +
    "for — with a ready-to-paste LogQL exclusion for each. One repeating message is routinely " +
    "most of a stream's volume, and it crowds out whatever you were looking for. " +
    "Unlike grafana_logs_patterns, which uses Loki's own detection and therefore cannot see " +
    "below a volume floor, this profiles the lines it actually fetched, so a shape occurring " +
    "twice in the sample still appears. " +
    "Percentages describe THE SAMPLE, not the time range: Loki fills a limit backwards from " +
    "the end of the window, so the sample is both capped and biased towards the most recent " +
    "moment. The window the sample actually covered is reported — read the percentages " +
    "against that, not against from/to.",
  {
    client: z.string().optional().describe("Customer name fragment. Omit if giving an exact namespace."),
    component: z.string().optional().describe("Component fragment, e.g. 'gateway'."),
    namespace: z.string().optional().describe("Exact namespace, if you already know it."),
    from: z.string().default("now-1h").describe("Range start, e.g. 'now-1h'."),
    to: z.string().default("now").describe("Range end."),
    sample_size: z.number().int().min(50).max(5000).default(500).optional().describe("Lines to sample. Larger is more representative and slower."),
    max_shapes: z.number().int().min(1).max(50).default(10).optional(),
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization (see grafana_find_customer)."),
  },
  async ({ client, component, namespace, from = "now-1h", to = "now", sample_size = 500, max_shapes = 10, control_plane_id }) =>
    withToolLogging("grafana_logs_noise", { client, namespace, from, to, sample_size }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);
      if (!client && !namespace) throw new Error("either client or namespace is required");

      let selector;
      let resolution = null;
      if (namespace) {
        selector = `{namespace="${namespace}"}`;
      } else {
        const resolved = await resolveCustomerSelector({ client, component, from, controlPlaneId: control_plane_id });
        selector = resolved.selector;
        resolution = resolved.resolution;
      }

      const { start, end } = rangeSeconds(from, to);
      const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query_range", {
        query: selector,
        start: `${start * 1e9}`,
        end: `${end * 1e9}`,
        direction: "backward",
        limit: String(sample_size),
      });

      const streams = data?.data?.result || [];
      const rows = streams.flatMap((st) => (st.values || []).map((v) => [Number(v[0]), v[1]]));
      const profile = profileNoise(rows.map((r) => r[1]), { maxShapes: max_shapes });

      const noiseSampling = detectSampling(streams.map((st) => ({ labels: st.stream || {} })));
      const result = {
        query: selector,
        scope_applied: selector,
        scope_note: scopeNote(selector),
        ...(noiseSampling ? { adaptive_logs_sampling: noiseSampling } : {}),
        ...(resolution ? resolutionReport(resolution) : {}),
        range: { from, to },
        ...profile,
      };

      // A sample that hit its cap describes a slice, not the range. Say which
      // slice, or the percentages get read as a property of from/to.
      if (rows.length) {
        const times = rows.map((r) => r[0]).filter(Number.isFinite);
        const earliest = Math.min(...times) / 1e6;
        const latest = Math.max(...times) / 1e6;
        result.sample_window = {
          from_utc: new Date(earliest).toISOString(),
          to_utc: new Date(latest).toISOString(),
          covered_seconds: Math.max(0, Math.round((latest - earliest) / 1000)),
          requested_seconds: Math.max(0, end - start),
        };
        if (rows.length >= sample_size) {
          result.sample_window.warning =
            `The sample hit its ${sample_size}-line cap and covers ` +
            `${result.sample_window.covered_seconds}s of the ${result.sample_window.requested_seconds}s requested. ` +
            "Loki fills the cap backwards from the end of the window, so these proportions describe the most " +
            "recent slice only — a shape that stopped earlier in the range will not appear at all.";
        }
      } else {
        result.note = "No lines sampled. Check the selector and range — grafana_logs_trend shows whether this stream has data.";
      }
      return textResult(result);
    }),
);

registerTool(
  "grafana_http_requests",
  "Read-only: HTTP request logs for a customer — status codes, durations, upstream response times and " +
    "retries — from BOTH ingress controllers: ingress-nginx (gateways, management API) and the AKS " +
    "app-routing ingress (bridge traffic, /_bridge/...). Searching one controller for traffic that went " +
    "through the other returns a clean, scanned, empty — and wrong — result, so both are searched by " +
    "default. This data is NOT reachable through the other log tools: they scope `client` to the " +
    "customer's own namespaces, which hold application logs only. " +
    "Default mode is aggregate, per ingress: status distribution, p50/p95/max request time, upstream p95, " +
    "retried requests, and by_upstream — attempts and failures per upstream pod IP, resolved to pod and " +
    "node when a metrics datasource is configured, with a by_node rollup. That table is what exposes one " +
    "bad node: failures concentrated on pods sharing a node while their siblings elsewhere are healthy. " +
    "mode='sample' returns parsed requests with every retry attempt kept. " +
    "Bridge calls terminate on the CONTROL plane, which usually runs on a different cluster from its data " +
    "planes: pass control_plane_id to include it (it is shared by every customer in that organization, so " +
    "it is never included implicitly) and cluster to pick which side. " +
    "On a multi-tenant cluster results are narrowed to this customer's upstreams, so they cannot include " +
    "another tenant's traffic. Adaptive Logs sampling is reported when present; counts are then lower " +
    "bounds. Prefer this over grepping the raw stream: `|= \" 499 \"` also matches request sizes of 499 " +
    "bytes, while status_filter matches the parsed field only. compare_offset (1d, 7d) adds per-status baseline counts, ratios and p95 from the same window that much earlier — so a chronic 499 pattern reads as already_present, not as incident impact.",
  {
    client: z
      .string()
      .optional()
      .describe("Customer name fragment, e.g. 'acme'. Resolved to their cluster."),
    cluster: z
      .string()
      .optional()
      .describe(
        "Cluster label (from grafana_find_customer). Required when the customer spans clusters — typically " +
          "control plane and data planes. Refused if none of the customer's namespaces run on it.",
      ),
    ingress: z
      .enum(["all", "nginx", "app-routing"])
      .default("all")
      .optional()
      .describe("nginx = gateways and management API; app-routing = bridge; all (default) = both, reported separately."),
    mode: z
      .enum(["aggregate", "sample"])
      .default("aggregate")
      .optional()
      .describe("aggregate = distributions, latency, retries, failures per upstream. sample = parsed individual requests."),
    path_filter: z.string().optional().describe("Substring of the request path, e.g. '_bridge' or '_import/crd'. Case-insensitive."),
    status_filter: z.string().optional().describe("Status code, class, or list: '499', '5xx', '499, 5xx'."),
    method: z.string().optional().describe("HTTP method, e.g. 'POST'."),
    min_duration_seconds: z
      .number()
      .optional()
      .describe("Only requests at least this slow, by request_time. Use to surface the slow tail."),
    from: z.string().default("now-1h").describe("Range start, e.g. 'now-6h', or epoch ms."),
    to: z.string().default("now").describe("Range end."),
    interval: z.string().optional().describe("Bucket size for the aggregate trend (5m, 15m, 1h)."),
    max_lines: z.number().int().min(1).max(500).default(50).optional().describe("Cap for mode='sample'."),
    control_plane_id: z
      .string()
      .optional()
      .describe(
        "Cockpit organization (control plane) id. Includes its control-plane namespace, where bridge traffic " +
          "lands. Shared by every customer in the organization.",
      ),
    compare_offset: z
      .string()
      .optional()
      .describe(
        "Also run the identical query over the same-length window this long EARLIER (1d, 7d, 1w) and report both " +
          "with a ratio and a change label. Do this before reading any level as incident impact: an earlier hour " +
          "the same day is a different traffic regime, and a chronic pattern compared against it reads as new.",
      ),
  },
  async ({
    client,
    cluster,
    ingress = "all",
    mode = "aggregate",
    path_filter,
    status_filter,
    method,
    min_duration_seconds,
    from = "now-1h",
    to = "now",
    interval,
    max_lines = 50,
    control_plane_id,
    compare_offset,
  }) =>
    withToolLogging("grafana_http_requests", { client, cluster, ingress, mode, from, to }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);
      if (!client && !cluster) {
        throw new Error("Pass client (resolved to a cluster) or cluster.");
      }

      // Resolve the customer to namespaces first, even when a cluster was given:
      // the namespaces are what scopes a shared cluster to this customer.
      let resolution = null;
      let namespaces = [];
      if (client) {
        resolution = await resolveNamespaces(client, { from, control_plane_id });
        if (resolution.ambiguous_customer) {
          return textResult({
            client,
            ambiguous_customer: true,
            candidates: resolution.candidates,
            note: resolution.note,
          });
        }
        namespaces = [...resolution.namespaces];
      }
      // Bridge traffic terminates on the control plane. Its namespace is shared by
      // every customer in the organization, so it is included only when asked for.
      const controlPlaneNs = control_plane_id ? controlPlaneNamespace(control_plane_id) : null;
      if (controlPlaneNs && !namespaces.includes(controlPlaneNs)) namespaces.push(controlPlaneNs);

      const clusterInfo = namespaces.length
        ? await resolveClusters(namespaces, { from })
        : { clusters: [], by_namespace: {} };
      const clusters = cluster ? [cluster] : clusterInfo.clusters;
      if (!clusters.length) {
        return textResult({
          client,
          resolved_namespaces: namespaces,
          ...(resolution ? resolutionReport(resolution) : {}),
          note:
            "Could not resolve a cluster for this customer, so their ingress logs cannot be located. " +
            "Check the name with grafana_find_customer — its `clusters` field is the input this tool needs.",
        });
      }
      // One cluster per call: results from two clusters would be summed into a
      // single latency distribution that describes neither.
      if (clusters.length > 1) {
        return textResult({
          client,
          clusters,
          namespace_clusters: clusterInfo.by_namespace,
          note:
            `This customer spans ${clusters.length} clusters. Aggregating them would produce a status ` +
            "distribution and latency percentiles that describe neither. Re-run with cluster set to one of " +
            "the above" +
            (controlPlaneNs
              ? " — the control plane (bridge traffic) and the data planes (gateway traffic) are usually on different ones."
              : "."),
        });
      }

      const target = clusters[0];
      const scope = await resolveIngressScope(target, namespaces, { from });
      if (namespaces.length && Array.isArray(scope.own_on_cluster) && !scope.own_on_cluster.length) {
        return textResult({
          cluster: target,
          customer_namespaces: namespaces,
          customer_clusters: clusterInfo.clusters,
          namespace_clusters: clusterInfo.by_namespace,
          note:
            `None of this customer's namespaces run on ${target}, so nothing on its ingress can be attributed ` +
            "to them — a query here would return a clean zero that means nothing. " +
            (clusterInfo.clusters.length ? `They run on: ${clusterInfo.clusters.join(", ")}. ` : "") +
            (controlPlaneNs
              ? ""
              : "For bridge traffic pass control_plane_id: bridge calls land on the control plane's cluster, not the data planes'."),
        });
      }

      const streamQuery = buildIngressQuery({
        cluster: target,
        ingress,
        upstreamNamespaces: scope.upstream_namespaces,
        pathFilter: path_filter,
        statusFilter: status_filter,
        method,
        minDurationSeconds: min_duration_seconds,
      });
      const { start, end } = rangeSeconds(from, to);
      const rangeLabel = `${Math.max(end - start, 1)}s`;

      const shared = {
        cluster: target,
        ingress,
        ingress_jobs: ingressJobs(ingress),
        scope: {
          tenancy: scope.tenancy,
          single_tenant_cluster: scope.single_tenant,
          customer_namespaces: namespaces,
          ...(scope.other_tenant_count ? { other_tenants_on_cluster: scope.other_tenant_count } : {}),
          ...(controlPlaneNs
            ? {
                control_plane_namespace: controlPlaneNs,
                control_plane_note:
                  "Included because control_plane_id was passed. A control plane is shared by every customer in " +
                  "its Cockpit organization, so its bridge traffic is theirs collectively, not this customer's alone.",
              }
            : {}),
          note: scope.note,
        },
        ...(resolution ? resolutionReport(resolution) : {}),
        range: { from, to },
        resolved_window_utc: `${new Date(start * 1000).toISOString()} .. ${new Date(end * 1000).toISOString()}`,
        filters: {
          ...(path_filter ? { path_filter } : {}),
          ...(status_filter ? { status_filter } : {}),
          ...(method ? { method } : {}),
          ...(min_duration_seconds ? { min_duration_seconds } : {}),
        },
      };

      // Every Loki call names its query when it fails. A bare "HTTP 400" sent an
      // incident to hand-written LogQL; the reason and the query fix that in one read.
      const lokiGet = async (part, path, params) => {
        try {
          return await grafanaDatasourceProxyGet(uid, path, params);
        } catch (err) {
          log("error", "Loki query failed", { tool: "grafana_http_requests", part, query: params.query, error: err.message });
          const wrapped = new Error(`${part} query failed: ${err.message} | LogQL: ${params.query}`);
          wrapped.part = part;
          wrapped.query = params.query;
          wrapped.reason = err.reason || err.message;
          throw wrapped;
        }
      };

      if (compare_offset && mode === "sample") {
        throw new Error("compare_offset applies to mode='aggregate': individual requests from two windows do not compare.");
      }
      const offsetSeconds = compare_offset ? parseCompareOffset(compare_offset, { windowSeconds: end - start }) : null;

      if (mode === "sample") {
        const data = await lokiGet("sample", "loki/api/v1/query_range", {
          query: streamQuery,
          start: `${start}000000000`,
          end: `${end}000000000`,
          limit: String(max_lines),
          direction: "backward",
        });
        const streams = data?.data?.result || [];
        const requests = [];
        let unparsed = 0;
        for (const st of streams) {
          for (const [ns, line] of st.values || []) {
            const parsed = parseAccessLogLine(line);
            if (!parsed) {
              unparsed++;
              continue;
            }
            const last = parsed.attempts[parsed.attempts.length - 1] || {};
            requests.push({
              time: new Date(Number(ns) / 1e6).toISOString(),
              ingress: ingressName(st.stream?.job),
              method: parsed.method,
              path: parsed.path,
              status: parsed.status,
              request_time: parsed.request_time,
              // The final attempt, for a one-glance read; `-` means that upstream
              // never answered — the signature of a timeout, not a slow response.
              upstream_status: last.status ?? null,
              upstream_response_time: last.response_time ?? null,
              upstream_addr: last.addr ?? null,
              retried: parsed.retried,
              ...(parsed.retried ? { attempts: parsed.attempts } : {}),
              user_agent: parsed.user_agent,
              upstream: parsed.upstream,
            });
          }
        }
        requests.sort((a, b) => (a.time < b.time ? 1 : -1));
        const sampling = detectSampling(streams.map((st) => ({ labels: st.stream || {} })));
        const returned = requests.length + unparsed;
        return textResult({
          query: streamQuery,
          ...shared,
          request_count: requests.length,
          ...(unparsed ? { unparsed_lines: unparsed } : {}),
          requests,
          ...(sampling ? { adaptive_logs_sampling: sampling } : {}),
          ...(returned >= max_lines
            ? {
                limit_reached: true,
                note:
                  `Returned ${returned} lines, the cap. Loki fills the cap from the END of the window backwards, ` +
                  "so the earlier part of the range was not returned — use mode='aggregate' for totals.",
              }
            : {}),
        });
      }

      // Aggregate. Every unwrap is guarded: a retried request's upstream_time is a
      // list, and one unparseable sample fails the whole query rather than being
      // skipped. Everything is grouped by job so the two ingress controllers —
      // different traffic, different latency — are never averaged together.
      const G = "job, status";
      const queries = {
        counts: `sum by (job, status, ${ADAPTIVE_LOGS_LABEL}) (count_over_time(${streamQuery} [${rangeLabel}]))`,
        latency_p50: `quantile_over_time(0.5, ${streamQuery}${unwrapNumeric("request_time")} [${rangeLabel}]) by (${G})`,
        latency_p95: `quantile_over_time(0.95, ${streamQuery}${unwrapNumeric("request_time")} [${rangeLabel}]) by (${G})`,
        latency_max: `max_over_time(${streamQuery}${unwrapNumeric("request_time")} [${rangeLabel}]) by (${G})`,
        // Single-attempt requests only — the guard excludes lists rather than
        // failing on them — and retries are counted separately so the exclusion
        // is visible rather than silent.
        upstream_latency_p95: `quantile_over_time(0.95, ${streamQuery}${unwrapNumeric("upstream_time")} [${rangeLabel}]) by (${G})`,
        retried: `sum by (job) (count_over_time(${streamQuery}${RETRIED_MATCHER} [${rangeLabel}]))`,
        by_upstream: `sum by (job, upstream_addr, upstream_status) (count_over_time(${streamQuery} [${rangeLabel}]))`,
      };
      const instant = (part) => lokiGet(part, "loki/api/v1/query", { query: queries[part], time: `${end}000000000` });

      // The counts are the answer; everything else refines it. Only the counts may
      // fail the call — a refinement Loki rejects (a series limit on a busy
      // cluster, say) is reported alongside the answer, not allowed to replace it.
      const counts = await instant("counts");
      const secondary = ["latency_p50", "latency_p95", "latency_max", "upstream_latency_p95", "retried", "by_upstream"];
      const settled = await Promise.allSettled(secondary.map((part) => instant(part)));
      const got = {};
      const partialFailures = [];
      secondary.forEach((part, idx) => {
        const r = settled[idx];
        if (r.status === "fulfilled") got[part] = r.value?.data?.result || [];
        else partialFailures.push({ part, error: r.reason?.reason || r.reason?.message, query: queries[part] });
      });

      const countRows = counts?.data?.result || [];
      const sampling = samplingFromGroupedCounts(countRows);
      const key = (m) => `${m?.job || ""}\u0000${m?.status || ""}`;
      const countMap = new Map();
      for (const r of countRows) {
        const v = Number(r?.value?.[1]);
        if (!Number.isFinite(v) || !r?.metric?.status) continue;
        const k = key(r.metric);
        countMap.set(k, (countMap.get(k) || 0) + v);
      }
      const numberMap = (rows = []) => {
        const m = new Map();
        for (const r of rows) {
          const v = Number(r?.value?.[1]);
          if (Number.isFinite(v)) m.set(key(r.metric), v);
        }
        return m;
      };
      const p50 = numberMap(got.latency_p50);
      const p95 = numberMap(got.latency_p95);
      const worst = numberMap(got.latency_max);
      const upP95 = numberMap(got.upstream_latency_p95);
      const retriedByJob = new Map((got.retried || []).map((r) => [r?.metric?.job || "", Number(r?.value?.[1])]));
      const r3 = (v) => Math.round(v * 1000) / 1000;
      const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

      const byIngress = new Map();
      const statusTotals = new Map();
      for (const [k, count] of countMap) {
        const [job, status] = k.split("\u0000");
        const e = byIngress.get(job) || { ingress: ingressName(job), job, total_requests: 0, by_status: [] };
        e.total_requests += count;
        e.by_status.push({
          status,
          count,
          ...(p50.has(k) ? { p50_seconds: r3(p50.get(k)) } : {}),
          ...(p95.has(k) ? { p95_seconds: r3(p95.get(k)) } : {}),
          ...(worst.has(k) ? { max_seconds: r3(worst.get(k)) } : {}),
          ...(upP95.has(k) ? { upstream_p95_seconds: r3(upP95.get(k)) } : {}),
        });
        byIngress.set(job, e);
        statusTotals.set(status, (statusTotals.get(status) || 0) + count);
      }
      const total = [...statusTotals.values()].reduce((a, b) => a + b, 0);
      for (const e of byIngress.values()) {
        e.by_status.sort((a, b) => b.count - a.count);
        for (const row of e.by_status) row.share_pct = pct(row.count, e.total_requests);
        if (retriedByJob.has(e.job)) e.retried_requests = retriedByJob.get(e.job);
      }
      const byStatus = [...statusTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([status, count]) => ({ status, count, share_pct: pct(count, total) }));

      // The same counts and p95, the same window length, compare_offset earlier —
      // per ingress and status, because a chronic 499 pattern next to a new 502
      // spike is exactly what a single total would blur.
      let httpComparison = null;
      if (offsetSeconds) {
        const bStart = start - offsetSeconds;
        const bEnd = end - offsetSeconds;
        const [bCounts, bP95] = await Promise.allSettled([
          lokiGet("baseline_counts", "loki/api/v1/query", { query: queries.counts, time: `${bEnd}000000000` }),
          lokiGet("baseline_latency_p95", "loki/api/v1/query", { query: queries.latency_p95, time: `${bEnd}000000000` }),
        ]);
        if (bCounts.status === "rejected") {
          partialFailures.push({ part: "baseline_counts", error: bCounts.reason?.reason || bCounts.reason?.message, query: queries.counts });
        } else {
          if (bP95.status === "rejected") {
            partialFailures.push({ part: "baseline_latency_p95", error: bP95.reason?.reason || bP95.reason?.message, query: queries.latency_p95 });
          }
          const bCountMap = new Map();
          for (const r of bCounts.value?.data?.result || []) {
            const v = Number(r?.value?.[1]);
            if (!Number.isFinite(v) || !r?.metric?.status) continue;
            const k = key(r.metric);
            bCountMap.set(k, (bCountMap.get(k) || 0) + v);
          }
          const bP95Map = numberMap(bP95.status === "fulfilled" ? bP95.value?.data?.result || [] : []);
          const baselineTotal = [...bCountMap.values()].reduce((a, b) => a + b, 0);
          const baselineAvailable = baselineTotal > 0 || (await streamsExist(uid, streamQuery, bStart, bEnd));
          for (const e of byIngress.values()) {
            for (const row of e.by_status) {
              const k = `${e.job}\u0000${row.status}`;
              const cmp = compareValues(row.count, bCountMap.get(k) || 0, { baselineAvailable });
              row.baseline_count = cmp.baseline;
              row.ratio = cmp.ratio;
              row.change = cmp.change;
              row.already_present = cmp.already_present;
              if (bP95Map.has(k)) row.baseline_p95_seconds = r3(bP95Map.get(k));
            }
          }
          const onlyInBaseline = [...bCountMap.entries()]
            .filter(([k]) => !countMap.has(k))
            .map(([k, v]) => {
              const [job, status] = k.split("\u0000");
              return { ingress: ingressName(job), status, baseline_count: v, change: "gone" };
            });
          const totalCmp = compareValues(total, baselineTotal, { baselineAvailable });
          httpComparison = {
            offset: compare_offset,
            baseline_window_utc: `${new Date(bStart * 1000).toISOString()} .. ${new Date(bEnd * 1000).toISOString()}`,
            total: totalCmp,
            note: describeChange(totalCmp, compare_offset, "request volume"),
            ...(onlyInBaseline.length ? { only_in_baseline: onlyInBaseline } : {}),
            per_status:
              "Each by_ingress status row carries baseline_count, ratio, change, already_present and baseline_p95_seconds.",
            change_labels: CHANGE_LABELS_NOTE,
          };
        }
      }

      // Failures per upstream pod, and the node each pod ran on.
      let upstreamSection = {};
      if (got.by_upstream) {
        const agg = aggregateUpstreamAttempts(got.by_upstream, { limit: 100 });
        const resolved = await podsByIp(target, agg.rows.map((r) => r.ip), { start, end });
        if (resolved.pods) {
          for (const row of agg.rows) {
            const pods = resolved.pods.get(row.ip);
            if (pods) row.pods = pods;
          }
        }
        const byNode = resolved.pods ? rollupByNode(agg.rows) : [];
        upstreamSection = {
          by_upstream: agg.rows.slice(0, 20),
          upstreams_total: agg.total_upstreams,
          ...(agg.total_upstreams > 20 ? { by_upstream_truncated: agg.total_upstreams - 20 } : {}),
          ...(byNode.length ? { by_node: byNode } : {}),
          ...(resolved.pods
            ? {
                pod_resolution:
                  "Upstream IPs resolved to pods via kube_pod_ips over the query window. An IP can be reused after " +
                  "a pod is replaced, so one may list more than one pod.",
              }
            : {}),
          ...(resolved.note ? { pod_resolution_note: resolved.note } : {}),
        };
      }

      // A trend alongside the totals: a distribution says what happened, not when.
      const step = interval || chooseInterval(Math.max(end - start, 1));
      let trend = {};
      try {
        const trendQuery = `sum(count_over_time(${streamQuery} [${step}]))`;
        const trendData = await lokiGet("trend", "loki/api/v1/query_range", {
          query: trendQuery,
          start: `${start}000000000`,
          end: `${end + durationSeconds(step)}000000000`,
          step,
        });
        const buckets = await exactEdgeCounts(
          uid,
          streamQuery,
          buildTrendBuckets(trendData?.data?.result?.[0]?.values || [], {
            startSeconds: start,
            endSeconds: end,
            stepSeconds: durationSeconds(step),
          }),
        );
        trend = { interval: step, ...summarizeTrend(buckets), bucket_covers: BUCKET_COVERS_NOTE, buckets };
      } catch (err) {
        partialFailures.push({ part: "trend", error: err.reason || err.message, query: err.query });
      }

      const result = {
        queries,
        ...shared,
        total_requests: total,
        by_status: byStatus,
        by_ingress: [...byIngress.values()],
        ...(httpComparison ? { comparison: httpComparison } : {}),
        ...(sampling ? { adaptive_logs_sampling: sampling } : {}),
        ...upstreamSection,
        ...trend,
        ...(partialFailures.length ? { partial_failures: partialFailures } : {}),
      };
      if (!total) {
        result.note =
          "No requests matched. The query ran; this is not an error. Check the filters, widen the range, or drop " +
          "status_filter/path_filter. Bridge traffic goes through the app-routing ingress on the CONTROL plane's " +
          "cluster — pass control_plane_id for it.";
      }
      return textResult(result);
    }),
);

registerTool(
  "grafana_first_occurrence",
  "Read-only: WHEN did this start — the earliest matching log line in a window, to the nanosecond, plus a " +
    "per-minute ramp around it. Reading onset off trend buckets is imprecise by construction: a bucket can only " +
    "say 'somewhere in this interval', and an onset read from 5-minute buckets was 5 minutes late in a real " +
    "incident. This finds the onset bucket, then the exact first line inside it. " +
    "It also counts the minutes BEFORE `from`: if the pattern was already occurring then, the first line in the " +
    "window is only where the window starts, and the result says so instead of presenting the edge as an onset. " +
    "Adaptive Logs sampling is reported: on a sampled stream this is the earliest line that REACHED Loki, and the " +
    "true first occurrence can be earlier. " +
    "Pass first_occurrence.ns as `at` to grafana_logs_context to read the lines around it, unfiltered. " +
    "Scope by client (resolved like the other log tools) or by exact namespace/service_name. HTTP request logs " +
    "are not in customer namespaces; use grafana_http_requests for those.",
  {
    line_filter: z.string().describe("What to find the first occurrence of: a substring of the log line. Required."),
    case_sensitive: z
      .boolean()
      .default(false)
      .optional()
      .describe("Match line_filter case-sensitively. Default false, so a wrong-case filter does not read as absent."),
    client: z.string().optional().describe("Customer name fragment. Omit if giving an exact namespace."),
    component: z.string().optional().describe("Component fragment, e.g. 'gateway'."),
    namespace: z.string().optional().describe("Exact namespace, e.g. from a previous result's streams."),
    service_name: z.string().optional().describe("Exact service_name, to search one service rather than the namespace."),
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization (see grafana_find_customer)."),
    from: z.string().default("now-24h").describe("Window start. Widen it if the result says the pattern predates it."),
    to: z.string().default("now").describe("Window end."),
    ramp_minutes_before: z
      .number().int().min(0).max(60).default(10).optional()
      .describe("Minutes of per-minute counts before the first line."),
    ramp_minutes_after: z
      .number().int().min(1).max(120).default(20).optional()
      .describe("Minutes of per-minute counts after the first line."),
  },
  async ({
    line_filter,
    case_sensitive = false,
    client,
    component,
    namespace,
    service_name,
    control_plane_id,
    from = "now-24h",
    to = "now",
    ramp_minutes_before = 10,
    ramp_minutes_after = 20,
  }) =>
    withToolLogging("grafana_first_occurrence", { client, namespace, from, to }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);
      if (!line_filter || !String(line_filter).trim()) {
        throw new Error("line_filter is required: the first occurrence of what? Without one, the answer is the window start.");
      }
      if (!client && !namespace) throw new Error("either client or namespace is required");

      let logQuery;
      let resolution = null;
      if (namespace) {
        const matchers = [`namespace="${namespace}"`];
        if (service_name) matchers.push(`service_name="${service_name}"`);
        logQuery = `{${matchers.join(", ")}}${lineFilterExpr(line_filter, { caseSensitive: case_sensitive })}`;
      } else {
        const resolved = await resolveCustomerSelector({
          client,
          component,
          lineFilter: line_filter,
          from,
          controlPlaneId: control_plane_id,
          caseSensitive: case_sensitive,
        });
        logQuery = resolved.selector;
        resolution = resolved.resolution;
      }
      const selector = extractStreamSelector(logQuery);
      const { start, end } = rangeSeconds(from, to);
      if (end <= start) throw new Error("to must be after from.");
      const isoS = (sec) => new Date(sec * 1000).toISOString();

      const base = {
        query: logQuery,
        scope_applied: selector,
        scope_note: scopeNote(selector),
        ...(resolution ? resolutionReport(resolution) : {}),
        range: { from, to },
        resolved_window_utc: `${isoS(start)} .. ${isoS(end)}`,
      };

      // 1. Which interval did it start in? Coarse counts, grouped by the sampling
      //    label so sampling is seen in the same read.
      const step = chooseInterval(Math.max(end - start, 1));
      const stepSeconds = durationSeconds(step);
      const coarse = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query_range", {
        query: `sum by (${ADAPTIVE_LOGS_LABEL}) (count_over_time(${logQuery} [${step}]))`,
        start: `${start}000000000`,
        end: `${end + stepSeconds}000000000`,
        step,
      });
      const { points, sampling: coarseSampling } = collapseSampledMatrix(coarse?.data?.result || []);
      // Exact edge counts: otherwise lines before `from` inflate lines_in_window and
      // can make the first, partial bucket the onset.
      const buckets = await exactEdgeCounts(uid, logQuery, buildTrendBuckets(points, { startSeconds: start, endSeconds: end, stepSeconds }));
      const trend = summarizeTrend(buckets);

      // 2. Was it already happening before the window?
      const beforeMinutes = Math.max(ramp_minutes_before, 10);
      let preWindowLines = null;
      try {
        const pre = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query", {
          query: `sum(count_over_time(${logQuery} [${beforeMinutes * 60}s]))`,
          time: `${start}000000000`,
        });
        preWindowLines = Number(pre?.data?.result?.[0]?.value?.[1] ?? 0);
      } catch {
        preWindowLines = null;
      }
      const beforeWindow = {
        minutes: beforeMinutes,
        lines: preWindowLines,
        already_present: Number(preWindowLines) > 0,
      };

      if (!trend.total) {
        const spot = coarseSampling || (await samplingSpotCheck(uid, logQuery, { start_ms: start * 1000, end_ms: end * 1000 }));
        return textResult({
          ...base,
          first_occurrence: null,
          lines_in_window: 0,
          before_window: beforeWindow,
          ...(spot ? { adaptive_logs_sampling: spot } : {}),
          note:
            "No matching lines in this window." +
            (Number(preWindowLines) > 0
              ? ` But ${preWindowLines} matched in the ${beforeMinutes} minutes before it: widen from.`
              : "") +
            (spot ? " These streams are sampled, so absence here is not proof it never happened." : ""),
        });
      }

      // 3. The exact first line inside the onset interval.
      const findFirst = async (s, e) => {
        const d = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query_range", {
          query: logQuery,
          start: `${s}000000000`,
          end: `${e}000000000`,
          direction: "forward",
          limit: "1",
        });
        return earliestLine(d?.data?.result || []);
      };
      const onsetSlot = Math.floor(Date.parse(trend.onset) / 1000);
      const narrowStart = Math.max(start, onsetSlot - 1);
      let narrowEnd = Math.min(end, onsetSlot + stepSeconds + 1);
      let first = await findFirst(narrowStart, narrowEnd);
      if (!first && narrowEnd < end) {
        narrowEnd = end;
        first = await findFirst(narrowStart, narrowEnd);
      }
      const search = {
        coarse_interval: step,
        onset_bucket: trend.onset,
        bucket_covers: BUCKET_COVERS_NOTE,
        narrowed_to_utc: `${isoS(narrowStart)} .. ${isoS(narrowEnd)}`,
      };
      if (!first) {
        return textResult({
          ...base,
          first_occurrence: null,
          search,
          lines_in_window: trend.total,
          before_window: beforeWindow,
          note: "Lines were counted in the window but none could be retrieved around the onset interval. Re-run with a narrower from/to.",
        });
      }

      // 4. Per-minute ramp around it: how fast did it rise?
      const firstSec = Math.floor(Number(BigInt(first.ns) / 1000000000n));
      const firstMinute = Math.floor(firstSec / 60) * 60;
      const rampStart = firstMinute - ramp_minutes_before * 60;
      const rampEnd = firstMinute + ramp_minutes_after * 60;
      let ramp;
      try {
        const r = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query_range", {
          query: `sum by (${ADAPTIVE_LOGS_LABEL}) (count_over_time(${logQuery} [1m]))`,
          start: `${rampStart}000000000`,
          end: `${rampEnd + 60}000000000`,
          step: "60",
        });
        const { points: rampPoints } = collapseSampledMatrix(r?.data?.result || []);
        ramp = {
          interval: "1m",
          bucket_covers: BUCKET_COVERS_NOTE,
          buckets: buildTrendBuckets(rampPoints, { startSeconds: rampStart, endSeconds: rampEnd, stepSeconds: 60 }).map((b) =>
            Date.parse(b.time) / 1000 < start ? { ...b, before_window: true } : b,
          ),
        };
      } catch (err) {
        ramp = { error: err.reason || err.message };
      }

      const sampling = coarseSampling || detectSampling([{ labels: first.labels || {} }]);
      const verdict = describeOnset({
        firstTimeIso: first.time,
        windowStartIso: isoS(start),
        preWindowMinutes: beforeMinutes,
        preWindowLines,
        sampling,
      });
      return textResult({
        ...base,
        first_occurrence: {
          ...first,
          next_step: "Pass ns as `at` to grafana_logs_context to read the lines around it, unfiltered.",
        },
        already_present_before_window: verdict.already_present_before_window,
        note: verdict.note,
        search,
        lines_in_window: trend.total,
        last_seen_bucket: trend.last_seen,
        peak: trend.peak,
        before_window: beforeWindow,
        ramp,
        ...(sampling ? { adaptive_logs_sampling: sampling } : {}),
      });
    }),
);

registerTool(
  "grafana_failure_topology",
  "Read-only: WHERE are the failures — matching log lines per pod, joined to the node each pod runs on, with the " +
    "healthy sibling pods of the same service for contrast. It answers 'is this the application, or the node?'. In " +
    "a real incident the cause only became clear after grouping errors by pod and joining pods to nodes: every " +
    "failing pod sat on one node while siblings elsewhere were healthy — three manual queries across Loki and " +
    "Prometheus. " +
    "Siblings are the pods whose streams match the same selector in the window (Loki's index, no log bodies), so " +
    "'healthy' means logging, but without matching lines. Each node reports its share of matching lines next to " +
    "its share of pods, and the verdict — node_concentrated, nodes_concentrated (a few nodes), spread, uneven, " +
    "single_node or no_errors — comes from " +
    "comparing the two, with the thresholds in the result: a node that runs most of the pods is expected to carry " +
    "most of the errors. " +
    "Adaptive Logs sampling is reported per pod: a pod whose lines are not sampled can look worse than a sampled " +
    "sibling. Node placement needs GRAFANA_METRICS_DATASOURCE_UID (Prometheus with kube-state-metrics). For HTTP " +
    "failures per upstream pod and node, use grafana_http_requests.",
  {
    line_filter: z.string().describe("The failures to locate: a substring of the log line, e.g. 'MongoTimeoutException'. Required."),
    case_sensitive: z
      .boolean()
      .default(false)
      .optional()
      .describe("Match line_filter case-sensitively. Default false, so a wrong-case filter does not read as healthy."),
    client: z.string().optional().describe("Customer name fragment. Pass exactly one of client, namespace or namespace_pattern."),
    component: z.string().optional().describe("With client: component fragment, e.g. 'gateway'."),
    namespace: z.string().optional().describe("Exact namespace."),
    namespace_pattern: z
      .string()
      .optional()
      .describe("Namespace regex for a wider scope, e.g. 'apim-cp-.*'. A pattern matching every namespace is refused."),
    service_name: z.string().optional().describe("With namespace or namespace_pattern: exact service_name."),
    cluster: z.string().optional().describe("Restrict to one cluster."),
    control_plane_id: z.string().optional().describe("With client: narrow to one Cockpit organization."),
    from: z.string().default("now-1h").describe("Window start."),
    to: z.string().default("now").describe("Window end."),
    max_nodes: z.number().int().min(1).max(100).default(25).optional().describe("Nodes to list, most matching lines first."),
  },
  async ({
    line_filter,
    case_sensitive = false,
    client,
    component,
    namespace,
    namespace_pattern,
    service_name,
    cluster,
    control_plane_id,
    from = "now-1h",
    to = "now",
    max_nodes = 25,
  }) =>
    withToolLogging("grafana_failure_topology", { client, namespace, namespace_pattern, cluster, from, to }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);
      if (!line_filter || !String(line_filter).trim()) {
        throw new Error("line_filter is required: the failures to locate, e.g. 'MongoTimeoutException' or 'connection refused'.");
      }
      if ([client, namespace, namespace_pattern].filter(Boolean).length !== 1) {
        throw new Error("Pass exactly one of client, namespace or namespace_pattern.");
      }
      if (namespace_pattern && /^\^?\.[*+]\$?$/.test(String(namespace_pattern).trim())) {
        throw new Error("namespace_pattern matches every namespace; narrow it, e.g. 'apim-cp-.*'.");
      }

      // Values inside a double-quoted LogQL string: escape, do not strip — a
      // namespace regex needs its backslashes.
      const lq = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      let selector;
      let resolution = null;
      if (client) {
        const resolved = await resolveCustomerSelector({ client, component, from, controlPlaneId: control_plane_id });
        selector = resolved.selector;
        resolution = resolved.resolution;
        if (cluster) selector = selector.replace(/^\{/, `{cluster="${lq(cluster)}", `);
      } else {
        const matchers = [namespace ? `namespace="${lq(namespace)}"` : `namespace=~"${lq(namespace_pattern)}"`];
        if (service_name) matchers.push(`service_name="${lq(service_name)}"`);
        if (cluster) matchers.push(`cluster="${lq(cluster)}"`);
        selector = `{${matchers.join(", ")}}`;
      }

      const errorQuery = `${selector}${lineFilterExpr(line_filter, { caseSensitive: case_sensitive })}`;
      const { start, end } = rangeSeconds(from, to);
      if (end <= start) throw new Error("to must be after from.");
      const rangeS = Math.max(end - start, 60);
      const countQuery = `sum by (cluster, namespace, pod, ${ADAPTIVE_LOGS_LABEL}) (count_over_time(${errorQuery} [${rangeS}s]))`;

      const [errorsRes, seriesRes] = await Promise.all([
        grafanaDatasourceProxyGet(uid, "loki/api/v1/query", { query: countQuery, time: `${end}000000000` }).catch((err) => {
          throw new Error(`count query failed: ${err.message} | LogQL: ${countQuery}`);
        }),
        grafanaDatasourceProxyGet(uid, "loki/api/v1/series", {
          "match[]": selector,
          start: `${start}000000000`,
          end: `${end}000000000`,
        }).catch(() => null),
      ]);
      const errorRows = errorsRes?.data?.result || [];
      const siblingPods = seriesRes
        ? (seriesRes.data || []).filter((st) => st?.pod).map((st) => ({ cluster: st.cluster, namespace: st.namespace, pod: st.pod }))
        : [];

      const placement = await kubePodInfo([...siblingPods, ...errorRows.map((r) => r?.metric || {})], { start, end });
      const topology = buildFailureTopology({ errorRows, siblingPods, podInfo: placement.pods || [], maxNodes: max_nodes });
      const sampling = samplingFromGroupedCounts(errorRows);

      return textResult({
        query: countQuery,
        scope_applied: selector,
        scope_note: scopeNote(selector),
        ...(resolution ? resolutionReport(resolution) : {}),
        range: { from, to },
        resolved_window_utc: `${new Date(start * 1000).toISOString()} .. ${new Date(end * 1000).toISOString()}`,
        ...topology,
        ...(seriesRes
          ? {}
          : { siblings_note: "Sibling pods could not be listed, so pods without matching lines are missing from the comparison." }),
        ...(placement.note ? { node_placement_note: placement.note } : {}),
        ...(sampling ? { adaptive_logs_sampling: sampling } : {}),
      });
    }),
);

registerTool(
  "grafana_explore_link",
  "Read-only: build a Grafana Explore link for any set of queries — several queries in one pane, two panes " +
    "side by side (split), or queries for different datasources together — without URL-encoding by hand. The " +
    "format was verified on this instance by opening each shape in Grafana. Nothing runs when the link is built; " +
    "the queries run when someone opens it. " +
    "Pass `queries` with `split` (true: one pane per query, at most two; false: all in one pane), or `panes` " +
    "directly. A pane with queries for more than one datasource uses Grafana's Mixed datasource. Every datasource " +
    "is checked against the read-only allowlist. Loki and Prometheus take `expr`; other types take their native " +
    "`query` object. " +
    "The range is ABSOLUTE by default (epoch milliseconds): a relative range like now-1h shows a different window " +
    "every time the link is opened, which is wrong for a link pasted into a ticket. Explore displays times in the " +
    "viewer's own time zone and ignores a timezone parameter in the URL; an absolute range is the same instant for " +
    "every viewer. For a single customer's logs in the Logs Drilldown app, use grafana_logs_link.",
  {
    queries: z
      .array(
        z.object({
          datasource_uid: z.string().describe("Datasource uid (grafana_list_datasources)."),
          expr: z.string().optional().describe("LogQL or PromQL."),
          query: z.record(z.any()).optional().describe("Native query fields for other datasource types."),
          instant: z.boolean().optional().describe("Instant rather than range query (Loki, Prometheus)."),
        }),
      )
      .min(1)
      .max(10)
      .optional()
      .describe("Queries to show. Use with split."),
    split: z
      .boolean()
      .default(false)
      .optional()
      .describe("With queries: true puts each query in its own pane (at most two); false puts them all in one pane."),
    panes: z
      .array(
        z.object({
          queries: z
            .array(
              z.object({
                datasource_uid: z.string(),
                expr: z.string().optional(),
                query: z.record(z.any()).optional(),
                instant: z.boolean().optional(),
              }),
            )
            .min(1)
            .max(10),
        }),
      )
      .min(1)
      .max(2)
      .optional()
      .describe("Explicit panes, instead of queries + split."),
    from: z.string().default("now-1h").describe("Range start: now-6h, epoch ms, or ISO 8601 with an explicit offset."),
    to: z.string().default("now").describe("Range end."),
    absolute: z
      .boolean()
      .default(true)
      .optional()
      .describe("Resolve the range to absolute instants now (default). false keeps it relative, re-evaluated on open."),
  },
  async ({ queries, split = false, panes, from = "now-1h", to = "now", absolute = true }) =>
    withToolLogging("grafana_explore_link", { panes: panes?.length, queries: queries?.length, split, from, to }, async () => {
      if (Boolean(queries) === Boolean(panes)) throw new Error("Pass either queries (with split) or panes, not both.");
      let layout;
      if (panes) layout = panes;
      else if (split) {
        if (queries.length > 2) {
          throw new Error(`split puts each query in its own pane and Explore shows two; got ${queries.length} queries. Use panes to group them.`);
        }
        layout = queries.map((q) => ({ queries: [q] }));
      } else layout = [{ queries }];

      // Every datasource checked once: a typo fails here, not silently in the
      // viewer's browser, and nothing outside the read-only allowlist is linked.
      const uids = [...new Set(layout.flatMap((pane) => pane.queries.map((q) => q.datasource_uid)))];
      const types = {};
      const names = {};
      for (const uid of uids) {
        const ds = await assertReadOnly(uid);
        types[uid] = ds.type;
        names[uid] = ds.name;
      }
      for (const q of layout.flatMap((pane) => pane.queries)) {
        if (types[q.datasource_uid] === "cloudwatch") assertCloudwatchNotBillableLogs(q.query || {});
      }

      const link = buildExploreLink({
        panes: layout.map((pane) => ({
          queries: pane.queries.map((q) => ({
            datasource: { uid: q.datasource_uid, type: types[q.datasource_uid] },
            expr: q.expr,
            query: q.query,
            instant: q.instant,
          })),
        })),
        from,
        to,
        absolute,
      });

      const result = {
        url: link.url,
        url_length: link.url.length,
        panes: Object.entries(link.panes).map(([id, pane]) => ({
          id,
          datasource: pane.datasource,
          queries: pane.queries.map((q) => ({
            refId: q.refId,
            datasource: names[q.datasource.uid] || q.datasource.uid,
            type: q.datasource.type,
            ...(q.expr ? { expr: q.expr } : {}),
          })),
        })),
        range: link.range,
        range_utc: link.range_utc,
        absolute: link.absolute,
        timezone_note:
          "Explore shows times in the viewer's own time-zone preference and ignores a timezone parameter in the URL. " +
          (link.absolute
            ? "This range is absolute (epoch milliseconds), so every viewer sees the same instants, each displayed in their own zone."
            : "This range is RELATIVE: it is re-evaluated when the link is opened, so it will show a different window later."),
        ...(link.url.length > 8000
          ? { length_note: "This link is over 8,000 characters; some chat tools and ticket systems truncate URLs that long." }
          : {}),
      };
      const billable = uids.some((uid) => types[uid] === "cloudwatch");
      return textResult(billable ? withBillingNotice(result, "cloudwatch") : result);
    }),
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  log("info", "Starting MCP adapter", { enabled: ENABLED, base_url: BASE_URL || null });
  // Warm the customer map now, so the GitHub round trip overlaps the MCP
  // handshake instead of being paid by whoever runs the first query.
  warmCustomerMap();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "MCP adapter connected", { transport: "stdio" });
}

// Only start the stdio transport when run as the entrypoint (`node server.js`).
// Tests import this module to exercise the tool handlers directly, and must not
// spin up a transport.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log("error", "MCP adapter failed to start", { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

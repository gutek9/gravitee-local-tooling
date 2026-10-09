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
  buildLogsQuery,
  buildExploreUrl,
  buildDrilldownUrl,
  buildExactLogsQuery,
  toLokiNs,
  rankClientSuggestions,
  matchNamespaces,
  matchNamespacesPhrase,
  requireDatasourceUid,
} from "./helpers.js";
import {
  loadCustomerMap,
  warmCustomerMap,
  resolveCustomerNamespaces,
  splitNameAndTail,
  matchCustomers,
  groupByCustomer,
  lookupById,
  dataPlaneNamespace,
  controlPlaneNamespace,
} from "./customerMap.js";

// Loki datasource uid for the logs tools. Required — deliberately NOT defaulted:
// a uid that is correct for one Grafana org is a silent, plausible failure in
// every other one. requireDatasourceUid() turns "unset" into a clear error at
// the point of use instead.
const LOGS_DATASOURCE_UID = (process.env.GRAFANA_LOGS_DATASOURCE_UID || "").trim();

// Allow list of read-only datasource types. 
// PromQL/LogQL have no write statements.
const READONLY_QUERY_TYPES = new Set(["prometheus", "loki"]);


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

// Given a datasource uid, verify it is read-only against the allowlist defined by READONLY_QUERY_TYPES. 
// Throws if not allowed or not found. Returns the datasource's uid, name and type.
async function assertReadOnly(uid) {
  if (typeof uid !== "string" || uid.trim() === "") {
    throw new Error("datasource_uid is required");
  }

  let ds;
  try {
    ds = await grafanaGet(`/datasources/uid/${encodeURIComponent(uid)}`);
  } catch (err) {
    throw new Error(`datasource "${uid}" could not be verified read-only: ${err.message}`);
  }

  const type = ds?.type ?? null;
  if (!type || !READONLY_QUERY_TYPES.has(type)) {
    throw new Error(
      `datasource "${uid}" (type "${type ?? "unknown"}") is not in the read-only allowlist ${JSON.stringify([...READONLY_QUERY_TYPES])}`
    )
  }

  return { uid: ds.uid ?? uid, name: ds.name ?? null, type };
}


async function listDatasources() {
  const items = await grafanaGet("/datasources");
  const list = Array.isArray(items) ? items : [];
  return {
    count: list.length,
    datasources: list.map((ds) => ({
      uid: ds.uid ?? null,
      name: ds.name || null,
      type: ds.type || null,
      is_default: ds.isDefault ?? false,
    })),
  };
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
// caller can tell a live mapping from a fallback one. An empty `namespaces`
// tells the caller to fall back to a plain `service_name` match.
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

  // control_plane_id only ever narrows. If it selected nothing from the map —
  // an id that is not this customer's, a customer the map does not have, or a
  // name too ambiguous to pick one customer — refuse instead of searching
  // without it: the label route, or the caller's service_name fallback, would
  // return logs the id was meant to exclude.
  if (control_plane_id && !resolved.namespaces.length) {
    const note =
      resolved.reason && resolved.unknown_control_plane
        ? resolved.reason
        : resolved.ambiguous
          ? `${resolved.reason} control_plane_id "${control_plane_id}" was not applied to any of them: pass the exact customer name.`
          : `control_plane_id "${control_plane_id}" only narrows a Gravitee Cloud customer, and "${phrase}" is not one ` +
            "in the customer map. Nothing was searched. Drop control_plane_id, or check the name.";
    return {
      namespaces: [],
      via: "none",
      unknown_control_plane: true,
      requested_control_plane_id: control_plane_id,
      control_plane_ids: resolved.control_plane_ids || [],
      ...(resolved.ambiguous ? { ambiguous_customer: true, candidates: resolved.candidates } : {}),
      note,
      map_source: map.source,
      map_warning: map.warning,
    };
  }

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
    // A tail that describes none of the customer's deployments widens to all of
    // them. Say so, with what they do have, rather than let the wider answer pass
    // for the one asked for.
    ...(resolved.unknown_qualifiers
      ? {
          unknown_qualifiers: resolved.unknown_qualifiers,
          known_environments: resolved.known_environments,
          known_regions: resolved.known_regions,
          qualifier_note: resolved.qualifier_note,
        }
      : {}),
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
    "unknown_control_plane",
    "requested_control_plane_id",
  ]) {
    if (resolution[key] !== undefined && resolution[key] !== null) out[key] = resolution[key];
  }
  if (resolution.map_warning) out.map_warning = resolution.map_warning;
  if (resolution.note) out.customer_note = resolution.note;
  return out;
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

registerTool("grafana_health", "Read-only Grafana health/config check.", {}, async () =>
  withToolLogging("grafana_health", {}, async () => {
    requireConfig();
    // A cheap authenticated call confirms the token works.
    const probe = await listDatasources();
    return textResult({
      status: "ok",
      enabled: ENABLED,
      base_url: BASE_URL,
      reachable: true,
      datasource_count: probe.count,
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
    "uid (from grafana_list_datasources), a raw expression (PromQL for Prometheus, " +
    "LogQL for Loki, etc.), and an optional time range. By default returns a compact " +
    "per-series digest (labels + count/first/last/min/max/avg); pass raw=true for the " +
    "full (potentially very large) frames. Only datasources whose query language is " +
    `read-only are allowed (types: ${[...READONLY_QUERY_TYPES].join(", ")}); a uid of ` +
    "any other type is rejected.",
  {
    datasource_uid: z.string().describe("Datasource uid from grafana_list_datasources."),
    expr: z.string().describe("Query expression (PromQL/LogQL/etc.)."),
    from: z.string().default("now-1h").describe("Range start, e.g. 'now-1h' or epoch ms."),
    to: z.string().default("now").describe("Range end, e.g. 'now' or epoch ms."),
    max_data_points: z.number().int().min(1).max(5000).default(1000).optional(),
    raw: z.boolean().default(false).optional().describe("Return the full raw frames instead of the per-series digest. Can be very large."),
  },
  async ({ datasource_uid, expr, from = "now-1h", to = "now", max_data_points = 1000, raw = false }) =>
    withToolLogging("grafana_query", { datasource_uid }, async () => {
      await assertReadOnly(datasource_uid);
      const payload = await grafanaPost("/ds/query", {
        from,
        to,
        queries: [
          {
            refId: "A",
            datasource: { uid: datasource_uid },
            expr,
            maxDataPoints: max_data_points,
          },
        ],
      });
      return textResult(raw ? payload : summarizeQueryResult(payload));
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
    "widening the range since logs are large.",
  {
    client: z.string().describe("Customer name fragment, e.g. 'april', 'alliander', 'apim-cloudgate'."),
    component: z.string().optional().describe("Component fragment, e.g. 'gateway', 'engine', 'ui'."),
    line_filter: z.string().optional().describe("Pre-fill the link's line filter with this substring (lines containing it)."),
    link_style: z
      .enum(["drilldown", "explore"])
      .default("drilldown")
      .describe("Link format: 'drilldown' (Logs Drilldown app, per-namespace; default) or 'explore' (raw LogQL Explore)."),
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization when a customer name spans several (see grafana_find_customer)."),
    from: z.string().default("now-1h").describe("Range start, e.g. 'now-1h', 'now-6h', or epoch ms."),
    to: z.string().default("now").describe("Range end, e.g. 'now' or epoch ms."),
  },
  async ({ client, component, line_filter, link_style = "drilldown", control_plane_id, from = "now-1h", to = "now" }) =>
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
      // Refused before any stream discovery: with no namespaces the selector
      // below would fall back to a service_name match across all of Loki.
      if (resolution.unknown_control_plane) {
        return textResult({
          refused: true,
          link_style,
          resolved_namespaces: [],
          ...resolutionReport(resolution),
          range: { from, to },
          links: [],
          note: resolution.note,
        });
      }
      const namespaces = resolution.namespaces;
      const pinned = namespaces.length ? namespaces : undefined;
      // The selector we discover streams with carries no line filter — /series
      // matches on the stream selector only, and the line_filter is applied in
      // the generated link itself, not here.
      const query = buildLogsQuery({ client, component, namespaces: pinned });
      const streams = await fetchMatchingStreams({ query, from, to });

      // Re-attach the line filter to the reported query so the caller sees the
      // full LogQL (the discovery query above intentionally omitted it). Only
      // rebuild when there's actually a line filter to add.
      const reportedQuery = line_filter
        ? buildLogsQuery({ client, component, lineFilter: line_filter, namespaces: pinned })
        : query;

      const result = {
        query: reportedQuery,
        link_style,
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
            url: buildDrilldownUrl({
              namespace,
              serviceNames,
              datasourceUid: LOGS_DATASOURCE_UID,
              from,
              to,
              lineFilter: line_filter,
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
              query: buildExactLogsQuery({ namespace, serviceNames, lineFilter: line_filter }),
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

// An id or namespace as it appears in an alert, a pod name or a dashboard
// (`apim-dp-cp1111-dp0001`, `cp1111-dp0001`), as opposed to a customer name.
const ID_SHAPED = /^(apim-(dp|cp)-[0-9a-z-]+|[0-9a-z]+(-[0-9a-z]+)+)$/i;

registerTool(
  "grafana_find_customer",
  "Read-only: find which customers and deployments match a name, WITHOUT querying any " +
    "logs. Use this when a name is ambiguous, when grafana_logs_link reports " +
    "ambiguous_customer, or simply to see what a customer has. Searches both populations: " +
    "Gravitee Cloud (Cockpit) customers via the deployment map, and hosted customers via " +
    "Loki's namespace label. Returns per customer: deployment count, Cockpit organizations " +
    "(control plane ids), environments, regions and the exact namespaces — so the caller can " +
    "pass a precise client (or control_plane_id) to grafana_logs_link.",
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

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
  splitClientEnv,
  matchNamespaces,
} from "./helpers.js";

// Loki datasource uid for the logs tools. Override per-instance via env.
const LOGS_DATASOURCE_UID = process.env.GRAFANA_LOGS_DATASOURCE_UID || "grafanacloud-logs";

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

// Resolve a free-text `client` to the customer's own namespace(s). Many
// customers have a dedicated namespace that names them (`april-prod`,
// `blueyonder-plt-live`) — that namespace is the most reliable customer
// identifier, more so than `service_name` (which for some tenants carries an
// opaque id, not the name). We fetch the `namespace` label values and keep the
// ones whose name contains the customer "core" (env tokens excluded — they
// aren't reliably in the namespace). Returns [] for customers that only live in
// a shared namespace (e.g. `prod`), which tells the caller to fall back to a
// plain `service_name` match.
async function resolveNamespaces(client, { from } = {}) {
  const { core } = splitClientEnv(client);
  if (!core) return [];
  let values = [];
  try {
    const data = await grafanaDatasourceProxyGet(LOGS_DATASOURCE_UID, "loki/api/v1/label/namespace/values", {
      start: toLokiNs(from, 60 * 60),
    });
    values = data?.data || [];
  } catch {
    return [];
  }
  return matchNamespaces(values, core);
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
    from: z.string().default("now-1h").describe("Range start, e.g. 'now-1h', 'now-6h', or epoch ms."),
    to: z.string().default("now").describe("Range end, e.g. 'now' or epoch ms."),
  },
  async ({ client, component, line_filter, link_style = "drilldown", from = "now-1h", to = "now" }) =>
    withToolLogging("grafana_logs_link", { client, component, link_style, from, to }, async () => {
      // Prefer the customer's own namespace when it has one (`april-prod`,
      // `blueyonder-plt-live`): the namespace names the customer reliably,
      // whereas `service_name` doesn't for every tenant. Customers that only
      // live in a shared namespace (`prod`) resolve to [] and fall back to the
      // plain service_name match.
      const namespaces = await resolveNamespaces(client, { from });
      const pinned = namespaces.length ? namespaces : undefined;
      // The selector we discover streams with carries no line filter — /series
      // matches on the stream selector only, and the line_filter is applied in
      // the generated link itself, not here.
      let query = buildLogsQuery({ client, component, namespaces: pinned });
      let streams = await fetchMatchingStreams({ query, from, to });

      // Env tokens (prod, stage, …) aren't reliably in the service_name either —
      // some customers name their prod `plt-live`/`multitenant`. So if we pinned
      // the customer's namespace, asked for an env, and got nothing, drop the env
      // filter and retry once: the namespace pin still scopes us to the customer,
      // which beats a misleading empty result. (We can't be perfect against
      // legacy/inconsistent labels; this just maximizes useful hits.)
      let env_filter_dropped = false;
      if (streams.length === 0 && pinned && splitClientEnv(client).envs.length) {
        const retryQuery = buildLogsQuery({ client: splitClientEnv(client).core, component, namespaces: pinned });
        const retryStreams = await fetchMatchingStreams({ query: retryQuery, from, to });
        if (retryStreams.length) {
          query = retryQuery;
          streams = retryStreams;
          env_filter_dropped = true;
        }
      }

      // Re-attach the line filter to the reported query so the caller sees the
      // full LogQL (the discovery query above intentionally omitted it). Only
      // rebuild when there's actually a line filter to add — otherwise `query`
      // (already env-adjusted by the retry) is exactly what we'd produce.
      const reportedQuery = line_filter
        ? buildLogsQuery({ client: env_filter_dropped ? splitClientEnv(client).core : client, component, lineFilter: line_filter, namespaces: pinned })
        : query;

      const result = {
        query: reportedQuery,
        link_style,
        resolved_namespaces: namespaces,
        ...(env_filter_dropped ? { env_filter_dropped: true } : {}),
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
        if (namespaces.length) {
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

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  log("info", "Starting MCP adapter", { enabled: ENABLED, base_url: BASE_URL || null });
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

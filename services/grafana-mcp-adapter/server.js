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
} from "./grafanaClient.js";
import {
  summarizeQueryResult,
  buildLogsQuery,
  requireDatasourceUid,
} from "./helpers.js";
import { fetchMatchingStreams } from "./lokiDiscovery.js";
import { linksForStreams, explainNoStreams } from "./logsLinks.js";
import { warmCustomerMap } from "./customerMapLoader.js";
import { resolveNamespaces, resolutionReport } from "./customerResolver.js";

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
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization when a customer name spans several."),
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
      const resolution = await resolveNamespaces(client, {
        datasourceUid: LOGS_DATASOURCE_UID,
        from,
        controlPlaneId: control_plane_id,
      });
      const namespaces = resolution.namespaces;
      const pinned = namespaces.length ? namespaces : undefined;
      // The selector we discover streams with carries no line filter — /series
      // matches on the stream selector only, and the line_filter is applied in
      // the generated link itself, not here.
      const query = buildLogsQuery({ client, component, namespaces: pinned });
      const streams = await fetchMatchingStreams(LOGS_DATASOURCE_UID, { query, from, to });

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
        links: linksForStreams({
          streams,
          linkStyle: link_style,
          query: reportedQuery,
          lineFilter: line_filter,
          datasourceUid: LOGS_DATASOURCE_UID,
          from,
          to,
        }),
      };
      if (streams.length === 0) {
        Object.assign(
          result,
          await explainNoStreams({
            namespaces,
            absentNamespaces: resolution.mapped_namespaces_absent_in_range,
            client,
            datasourceUid: LOGS_DATASOURCE_UID,
            from,
          }),
        );
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

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ENABLED,
  BASE_URL,
  log,
  requireConfig,
  requireDatasourceUid,
  grafanaGet,
  grafanaPost,
} from "./grafanaClient.js";
import {
  summarizeQueryResult,
  buildLogsQuery,
} from "./helpers.js";
import { fetchMatchingStreams } from "./lokiDiscovery.js";
import { linksForStreams, explainNoStreams } from "./logsLinks.js";
import { warmCustomerMap } from "./customerMapLoader.js";
import { resolveNamespaces, resolutionReport, findCustomer } from "./customerResolver.js";

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
// The schema each tool's input is validated against before its handler runs.
// Calling a handler directly skips that validation, so tests check what the
// schema refuses here.
export const toolInputSchemas = {};
function registerTool(name, ...rest) {
  const registered = server.tool(name, ...rest);
  tools[name] = registered.handler;
  toolInputSchemas[name] = registered.inputSchema;
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
  "Read-only: build a shareable Grafana logs link for one customer's logs. Name the customer " +
    "in client (e.g. client='kestrel', or 'kestrel prod' for one deployment) and the component " +
    "in component (e.g. 'gateway'). client is first resolved to the customer's own namespaces: " +
    "a Gravitee Cloud customer through the customer map, a hosted customer through Loki's " +
    "namespace label, or a data plane's full id or namespace from an alert. component then " +
    "narrows by service_name inside them. A customer with no namespace of its own (one that " +
    "lives in a shared namespace such as `prod`) is matched against service_name instead, " +
    "outside Gravitee Cloud namespaces. Streams are found with Loki's /series (label sets " +
    "only, no log lines), so each link is scoped to the exact service_name values that exist. " +
    "When the answer would not be what was asked for, the call is refused and nothing is " +
    "queried: for example a name that matches several customers, a word that describes none of " +
    "its deployments, a control_plane_id that is not one of its organizations, a control plane " +
    "id typed as client other than a trial's (every customer on it shares its namespace), or a " +
    "failed lookup that leaves the name unresolved. A refusal returns " +
    "refused: true, empty links and resolved_namespaces, the reason in `note` and the valid " +
    "choices (candidates, known_environments, control_plane_ids...); grafana_find_customer " +
    "lists them too. Otherwise it returns { query, resolved_namespaces, resolved_via, links, " +
    "range, matched_count, matched_streams } and where the customer map came from (map_source, " +
    "map_warning); when nothing matched, `note` says why. link_style 'drilldown' (default) " +
    "builds one Logs Drilldown link per namespace; 'explore' builds one raw Explore (LogQL) " +
    "link. line_filter pre-fills the links' line filter; each drilldown link then also carries " +
    "an `explore_url`, because the Drilldown app shows the filter but does not apply it on " +
    "load. Default range is the last hour; ask the user before widening it with from/to " +
    "(e.g. from='now-6h'), since logs are large.",
  {
    client: z
      .string()
      .trim()
      .min(1, "client must name a customer or an id: a blank one would match every stream in Loki")
      .describe(
        "Customer name fragment, e.g. 'kestrel', 'maple', 'apim-cloudgate', optionally followed by an " +
          "environment or region ('kestrel prod'). Put the component in `component`, not here: a word that " +
          "describes none of the customer's deployments is refused.",
      ),
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
      // Disabled or unconfigured: say so before the customer map is read from
      // GitHub with the user's token.
      requireConfig();
      // Fail loudly and once, rather than querying a nonexistent datasource and
      // reporting "no log streams matched" for what is really a config error.
      requireDatasourceUid(LOGS_DATASOURCE_UID);
      // Prefer the customer's own namespace when it has one (`april-prod`,
      // `blueyonder-plt-live`): the namespace names the customer reliably,
      // whereas `service_name` doesn't for every tenant. Customers that only
      // live in a shared namespace (`prod`) resolve to [] and fall back to the
      // plain service_name match, once the map and Loki's namespace list have
      // both answered; otherwise the resolution is refused.
      const resolution = await resolveNamespaces(client, {
        datasourceUid: LOGS_DATASOURCE_UID,
        from,
        controlPlaneId: control_plane_id,
      });
      // Refused before any stream discovery: with no namespaces the selector
      // below would fall back to a service_name match across every namespace
      // outside Gravitee Cloud.
      if (resolution.refused) {
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

registerTool(
  "grafana_find_customer",
  "Read-only: find which customers and deployments match a name, WITHOUT querying any " +
    "logs. Use this when a name is ambiguous, when grafana_logs_link reports " +
    "ambiguous_customer, or simply to see what a customer has. Searches both populations: " +
    "Gravitee Cloud (Cockpit) customers via the deployment map, and hosted customers via " +
    "Loki's namespace label. Returns per customer: deployment count, Cockpit organizations " +
    "(control_plane_ids), environments, regions and the exact namespaces — so the caller can " +
    "pass a precise client (or control_plane_id) to grafana_logs_link. Namespaces that match by " +
    "name are listed as hosted_namespaces, and Gravitee Cloud ones (apim-dp-*, apim-cp-*) apart as " +
    "cloud_namespaces: their name carries ids, not their owner, so look one up by its full id.",
  {
    query: z
      .string()
      .trim()
      .min(1, "query must be a customer name or an id")
      .describe(
        "Customer name or fragment ('money', 'orbit'), OR an id/namespace seen in an alert, pod or " +
          "dashboard ('apim-dp-cp1111-dp0001', 'cp1111-dp0001', 'cp1111') to look up who owns it.",
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .optional()
      .describe(
        "Caps every list in the answer: customers, hosted and Cloud namespaces, and each customer's " +
          "unattributed data planes. A *_truncated count says how many were left out.",
      ),
  },
  async ({ query, max_results = 20 }) =>
    withToolLogging("grafana_find_customer", { query }, async () => {
      // Disabled or unconfigured: say so before the customer map is read from
      // GitHub with the user's token.
      requireConfig();
      const datasourceUid = requireDatasourceUid(LOGS_DATASOURCE_UID);
      return textResult(await findCustomer(query, { datasourceUid, maxResults: max_results }));
    }),
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Work started before the transport connects. A disabled adapter starts none:
// Compose runs it whatever GRAFANA_ENABLED says, and it must not read the
// private customer map with the user's GitHub token for a service nobody
// turned on. Exported so tests can run it without a transport.
export function startupWarmUp() {
  if (!ENABLED) return;
  // Warm the customer map now, so the GitHub round trip overlaps the MCP
  // handshake instead of being paid by whoever runs the first query.
  warmCustomerMap();
}

async function main() {
  log("info", "Starting MCP adapter", { enabled: ENABLED, base_url: BASE_URL || null });
  startupWarmUp();
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

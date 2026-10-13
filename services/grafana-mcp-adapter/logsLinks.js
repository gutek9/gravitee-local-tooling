// What grafana_logs_link returns besides its query: the links built from the
// streams it discovered, and why an empty result is empty. Building the links is
// pure; only the service_name suggestions for an empty result ask Loki.
import { buildExploreUrl, buildDrilldownUrl, buildExactLogsQuery } from "./helpers.js";
import { suggestClients } from "./lokiDiscovery.js";

// The links for the streams /series matched.
//
// 'explore' is a single raw Explore (LogQL) deep link. 'drilldown' navigates
// per-namespace: the matched streams are grouped by namespace (a multitenant
// customer can span several, e.g. two data plane gateways) and get one link
// each, scoped to the EXACT service_name values seen in that namespace — the app
// treats a raw regex value as a literal, so we can't reuse the LogQL selector.
export function linksForStreams({ streams = [], linkStyle, query, lineFilter, datasourceUid, from, to }) {
  if (linkStyle === "explore") {
    return [{ url: buildExploreUrl({ datasourceUid, query, from, to }) }];
  }

  const byNamespace = new Map();
  for (const s of streams) {
    if (!s.namespace) continue;
    if (!byNamespace.has(s.namespace)) byNamespace.set(s.namespace, new Set());
    if (s.service_name) byNamespace.get(s.namespace).add(s.service_name);
  }
  return [...byNamespace.entries()].map(([namespace, names]) => {
    const serviceNames = [...names];
    const link = {
      namespace,
      service_names: serviceNames,
      url: buildDrilldownUrl({ namespace, serviceNames, datasourceUid, from, to, lineFilter }),
    };
    // The Logs Drilldown app pre-fills the line filter in its box but does
    // not apply it on load (it renders empty until the user re-types it).
    // When a line filter is set, attach a raw Explore (LogQL) link scoped to
    // this namespace's exact service_names — Explore honours the filter
    // immediately, so it's the reliable evidence link.
    if (lineFilter) {
      link.explore_url = buildExploreUrl({
        datasourceUid,
        query: buildExactLogsQuery({ namespace, serviceNames, lineFilter }),
        from,
        to,
      });
    }
    return link;
  });
}

// No streams: if we resolved the customer's namespace(s) but nothing matched,
// the customer is right — it's just a quiet range (or the component/env
// narrowed too far). Otherwise the `client` text likely didn't match any
// service_name; offer close matches to correct it. Mapped namespaces that Loki
// has not seen in the range at all point at a stale customer map instead.
export async function explainNoStreams({ namespaces = [], absentNamespaces = [], client, datasourceUid, from }) {
  if (absentNamespaces.length) {
    return {
      note:
        `No log streams matched, and ${absentNamespaces.length} of the mapped namespace(s) (${absentNamespaces.join(", ")}) do not ` +
        "appear in Loki for this range at all. That usually means the customer map is stale — the deployment was " +
        "recreated under a new id — rather than that the customer has no logs. Widen from/to in case the " +
        "deployment is simply dormant.",
    };
  }
  if (namespaces.length) {
    return {
      note: `No log streams in this range for namespace(s) ${namespaces.join(", ")}. Try widening from/to or relaxing component/env.`,
    };
  }
  const suggestions = await suggestClients(datasourceUid, client, { from });
  if (suggestions.length) {
    return {
      note: `No log streams matched in this range. Did you mean one of these service_name values? Re-run with a closer 'client'.`,
      suggestions,
    };
  }
  return { note: `No log streams matched in this range. Try widening from/to or adjusting client/component.` };
}

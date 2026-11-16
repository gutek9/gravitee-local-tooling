// What Loki has, read without pulling any log lines: the values a label takes,
// and the label sets of the streams a selector matches. Every call goes through
// grafanaDatasourceProxyGet, so the read-only check in grafanaClient.js covers it.
import { grafanaDatasourceProxyGet, log } from "./grafanaClient.js";
import { toLokiNs, rankClientSuggestions, SERVICE_NAME_SEARCH_SCOPE } from "./helpers.js";

// Discover which log streams match a selector WITHOUT pulling any log lines.
// Loki's /series returns just the label sets of the matching streams (one object
// per stream, e.g. {namespace, service_name, pod, ...}); we only need namespace
// and service_name to build the link, so this is far cheaper than query_range
// (no log bodies, no timestamps). The `|= "..."` line filter is dropped from the
// selector here — /series matches on the stream selector only, and the
// service_name we need for the link doesn't depend on the line filter anyway.
export async function fetchMatchingStreams(uid, { query, from, to }) {
  const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/series", {
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

// The values a label takes from `from` on (e.g. every `namespace`), in the
// streams `query` selects when given. Throws when the call fails: what a
// failure means for the answer is the caller's decision.
export async function fetchLabelValues(uid, label, { from, query } = {}) {
  const data = await grafanaDatasourceProxyGet(uid, `loki/api/v1/label/${encodeURIComponent(label)}/values`, {
    start: toLokiNs(from, 60 * 60),
    query,
  });
  return data?.data || [];
}

// When a logs query returns nothing, the `client` text often just doesn't match
// any `service_name`. Fetch the values the same search could have matched and
// suggest the closest ones so the caller can correct the spelling. Returns a
// small, de-duplicated list.
export async function suggestClients(uid, client, { from } = {}) {
  let values = [];
  try {
    values = await fetchLabelValues(uid, "service_name", { from, query: SERVICE_NAME_SEARCH_SCOPE });
  } catch {
    return [];
  }
  return rankClientSuggestions(values, client);
}

// Why Loki's namespace list could not be read, and whether trying again can
// help: a timeout or a dropped connection (fetch's own error, no status), 408,
// 429 or a 5xx may pass; any other HTTP status (a wrong datasource uid, a token
// without access) will not. The reason is the error's message: the HTTP
// client's gives method, path and status, never the token or the response body.
export function describeLookupFailure(err) {
  const status = err?.status;
  return {
    reason: err instanceof Error ? err.message : String(err),
    retryable: status === undefined || status === 408 || status === 429 || status >= 500,
  };
}

// Loki's namespace list, or null and why it could not be read. The failure is
// logged too: it changes every answer until it is fixed.
export async function namespaceList(datasourceUid, from) {
  try {
    return { namespaceValues: await fetchLabelValues(datasourceUid, "namespace", { from }), failure: null };
  } catch (err) {
    const failure = describeLookupFailure(err);
    log("warn", "Loki namespace lookup failed", { error: failure.reason, retryable: failure.retryable });
    return { namespaceValues: null, failure };
  }
}

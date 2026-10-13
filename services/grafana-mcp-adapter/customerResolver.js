// Resolving a free-text client to the namespaces holding its logs, the parts of
// that resolution worth returning to the caller, and finding which customers a
// name or an id matches. resolveClient() and findCustomerMatches() decide from
// data they are given, so they can be unit-tested directly; resolveNamespaces()
// and findCustomer() only fetch that data (Loki's namespace values and the
// customer map) first.
import { matchNamespaces, matchNamespacesPhrase } from "./helpers.js";
import { fetchLabelValues } from "./lokiDiscovery.js";
import { loadCustomerMap } from "./customerMapLoader.js";
import {
  splitNameAndTail,
  resolveCustomerNamespaces,
  matchCustomers,
  groupByCustomer,
  lookupById,
  dataPlaneNamespace,
  controlPlaneNamespace,
} from "./customerMatch.js";

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
export async function resolveNamespaces(client, { datasourceUid, from, controlPlaneId } = {}) {
  const phrase = String(client || "").trim();
  if (!phrase) return { namespaces: [], via: "none" };

  let namespaceValues = null;
  try {
    namespaceValues = await fetchLabelValues(datasourceUid, "namespace", { from });
  } catch {
    namespaceValues = null;
  }
  const map = await loadCustomerMap();
  return resolveClient({ phrase, controlPlaneId, namespaceValues, map });
}

// `namespaceValues: null` means Loki did not return its namespace list. That is
// not "no namespaces": hosted customers cannot be matched by namespace, and
// mapped namespaces cannot be checked against Loki, so calling them all absent
// would blame a stale map for a failed lookup. The result says so instead.
export function resolveClient({ namespaceValues = [], ...rest }) {
  if (namespaceValues !== null) return resolveFromRoutes({ ...rest, namespaceValues, liveNamespacesKnown: true });
  return {
    ...resolveFromRoutes({ ...rest, namespaceValues: [], liveNamespacesKnown: false }),
    namespace_lookup_failed: true,
    namespace_lookup_note:
      "Loki did not return its namespace list, so hosted customers could not be matched by namespace " +
      "and mapped namespaces were not checked against Loki.",
  };
}

function resolveFromRoutes({ phrase, controlPlaneId, namespaceValues, liveNamespacesKnown, map }) {
  // BOTH routes, always — never stop at the first hit. A customer can exist in
  // both populations at once: acme has a hosted `acme-prod` namespace
  // AND Cockpit data planes under `apim-dp-cp1111-*`. Returning early on the
  // label match searched half its logs and reported that as the whole story.
  // Neither route classifies words. The namespace route matches the phrase as
  // typed and gives ground one trailing word at a time; the map route asks the
  // map where the customer name ends. What the caller meant by the last word is
  // decided by what exists, not by a list of known environment names.
  const label = matchNamespacesPhrase(namespaceValues, phrase);
  // The label route only counts when it matched every word typed. Namespaces it
  // found by dropping trailing words ignore those words: "acme dev" has no
  // `acme-dev`, so it drops "dev" and finds `acme-prod`, and dev would also
  // search prod. Such namespaces are reported as skipped, never searched.
  const byLabel = label.tail.length ? [] : label.namespaces;
  const skipped = label.tail.length ? label.namespaces : [];
  const { core, tail } = splitNameAndTail(map.rows, phrase);
  const resolved = resolveCustomerNamespaces(map.rows, { core, qualifiers: tail, controlPlaneId });
  const namespaces = [...new Set([...byLabel, ...resolved.namespaces])];

  // Words that narrow neither route are refused, not dropped: both routes found
  // the customer only by ignoring them, so searching either would return more
  // than was asked for. What exists is listed so the caller can retry.
  const refuseUnknownWords = () => {
    const labelPart = skipped.length
      ? `"${label.tail.join(" ")}" is in none of the namespaces found for "${label.name}" (${skipped.join(", ")}).`
      : "";
    return {
      namespaces: [],
      via: "none",
      refused: true,
      unknown_qualifiers: resolved.unknown_qualifiers || label.tail,
      ...(resolved.unknown_qualifiers
        ? { known_environments: resolved.known_environments, known_regions: resolved.known_regions }
        : {}),
      ...(skipped.length ? { skipped_namespaces: skipped } : {}),
      note: resolved.unknown_qualifiers
        ? [labelPart, resolved.reason].filter(Boolean).join(" ")
        : `${labelPart} Nothing was searched. Retry without it, or with one of those namespaces.`,
      map_source: map.source,
      map_warning: map.warning,
    };
  };

  // control_plane_id only ever narrows. If it selected nothing from the map —
  // an id that is not this customer's, a customer the map does not have, or a
  // name too ambiguous to pick one customer — refuse instead of searching
  // without it: the label route, or the caller's service_name fallback, would
  // return logs the id was meant to exclude.
  if (controlPlaneId && !resolved.namespaces.length) {
    if (resolved.unknown_qualifiers) return refuseUnknownWords();
    const note =
      resolved.reason && resolved.unknown_control_plane
        ? resolved.reason
        : resolved.ambiguous
          ? `${resolved.reason} control_plane_id "${controlPlaneId}" was not applied to any of them: pass the exact customer name.`
          : `control_plane_id "${controlPlaneId}" only narrows a Gravitee Cloud customer, and "${phrase}" is not one ` +
            "in the customer map. Nothing was searched. Drop control_plane_id, or check the name.";
    return {
      namespaces: [],
      via: "none",
      refused: true,
      unknown_control_plane: true,
      requested_control_plane_id: controlPlaneId,
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
      ...(skipped.length ? { skipped_namespaces: skipped } : {}),
      note: resolved.reason,
      map_source: map.source,
      map_warning: map.warning,
    };
  }

  if (!namespaces.length && (resolved.unknown_qualifiers || skipped.length)) return refuseUnknownWords();

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
  const liveNamespaces = new Set(namespaceValues);
  const absent = liveNamespacesKnown ? resolved.namespaces.filter((n) => !liveNamespaces.has(n)) : [];

  return {
    namespaces,
    via,
    ...(skipped.length
      ? {
          skipped_namespaces: skipped,
          skipped_namespaces_note:
            `Found for "${label.name}" but not for "${label.tail.join(" ")}", so not searched. ` +
            "Name one of them to search it.",
        }
      : {}),
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

// The parts of a resolution worth returning to the caller: how the customer was
// found, and whether the mapping behind it was live or a fallback.
export function resolutionReport(resolution = {}) {
  const out = { resolved_via: resolution.via };
  for (const key of [
    "refused",
    "map_source",
    "map_generated_at",
    "map_generated_days_ago",
    "label_namespaces",
    "matched_deployments",
    "env_filter_applied",
    "skipped_namespaces",
    "skipped_namespaces_note",
    "unknown_qualifiers",
    "known_environments",
    "known_regions",
    "shared_control_plane_namespaces",
    "ambiguous_customer",
    "candidates",
    "spans_multiple_organizations",
    "organizations_note",
    "control_plane_ids",
    "mapped_namespaces_absent_in_range",
    "namespace_lookup_failed",
    "namespace_lookup_note",
    "unknown_control_plane",
    "requested_control_plane_id",
  ]) {
    if (resolution[key] !== undefined && resolution[key] !== null) out[key] = resolution[key];
  }
  if (resolution.map_warning) out.map_warning = resolution.map_warning;
  if (resolution.note) out.customer_note = resolution.note;
  return out;
}

// An id or namespace as it appears in an alert, a pod name or a dashboard
// (`apim-dp-cp1111-dp0001`, `cp1111-dp0001`), as opposed to a customer name.
const ID_SHAPED = /^(apim-(dp|cp)-[0-9a-z-]+|[0-9a-z]+(-[0-9a-z]+)+)$/i;

// Which customers and deployments a name, or an id seen in an alert, matches,
// without querying any logs.
export async function findCustomer(query, { datasourceUid, maxResults = 20 } = {}) {
  const map = await loadCustomerMap();
  let namespaceValues = null;
  try {
    // 30 days: a deployment absent over that window is gone, not merely quiet.
    namespaceValues = await fetchLabelValues(datasourceUid, "namespace", { from: "now-30d" });
  } catch {
    namespaceValues = null;
  }
  return findCustomerMatches({ query, map, namespaceValues, maxResults });
}

// `namespaceValues: null` means Loki did not return its namespace list: hosted
// namespaces and unattributed data planes could not be checked, which is not the
// same answer as "none matched".
export function findCustomerMatches({ query, map, namespaceValues: givenValues = [], maxResults = 20 }) {
  const lookupFailed = givenValues === null;
  const namespaceValues = givenValues || [];
  const needle = String(query || "").trim();

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
  const hostedNamespaces = matchNamespaces(namespaceValues, needle);

  // Data planes that are live on this customer's control planes but which the
  // map does not attribute to anyone. They may belong to another customer on
  // the same (shared) control plane, so they are reported as unattributed and
  // never folded into the customer's namespaces.
  const mappedNs = new Set(map.rows.map((r) => dataPlaneNamespace(r.data_plane_id)));
  const cpOf = (n) => n.replace("apim-dp-", "").split("-").slice(0, -1).join("-");
  for (const entry of cockpit) {
    const unattributed = namespaceValues.filter(
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
    gravitee_cloud_customers: cockpit.slice(0, maxResults),
    gravitee_cloud_truncated: cockpit.length > maxResults ? cockpit.length - maxResults : 0,
    hosted_namespaces: hostedNamespaces,
    ...(lookupFailed
      ? {
          namespace_lookup_failed: true,
          namespace_lookup_note:
            "Loki did not return its namespace list, so hosted namespaces and unattributed data planes " +
            "could not be checked.",
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
  } else if (!cockpit.length && lookupFailed) {
    result.note =
      `No Gravitee Cloud customer matched "${query}", and hosted namespaces could not be checked: ` +
      "Loki did not return its namespace list.";
  } else if (!cockpit.length && !hostedNamespaces.length) {
    result.note =
      byId && byId.kind === "unknown"
        ? `No Gravitee Cloud customer, hosted namespace, or known id matched "${query}".`
        : `No Gravitee Cloud customer or hosted namespace matched "${query}".`;
  }
  return result;
}

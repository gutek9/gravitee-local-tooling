// Resolving a free-text client to the namespaces holding its logs, and the parts
// of that resolution worth returning to the caller. resolveClient() decides from
// data it is given, so it can be unit-tested directly; resolveNamespaces() only
// fetches that data (Loki's namespace values and the customer map) first.
import { matchNamespacesPhrase } from "./helpers.js";
import { fetchLabelValues } from "./lokiDiscovery.js";
import { loadCustomerMap } from "./customerMapLoader.js";
import { splitNameAndTail, resolveCustomerNamespaces } from "./customerMatch.js";

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

  let namespaceValues = [];
  try {
    namespaceValues = await fetchLabelValues(datasourceUid, "namespace", { from });
  } catch {
    namespaceValues = [];
  }
  const map = await loadCustomerMap();
  return resolveClient({ phrase, controlPlaneId, namespaceValues, map });
}

export function resolveClient({ phrase, controlPlaneId, namespaceValues = [], map }) {
  // BOTH routes, always — never stop at the first hit. A customer can exist in
  // both populations at once: acme has a hosted `acme-prod` namespace
  // AND Cockpit data planes under `apim-dp-cp1111-*`. Returning early on the
  // label match searched half its logs and reported that as the whole story.
  // Neither route classifies words. The namespace route matches the phrase as
  // typed and gives ground one trailing word at a time; the map route asks the
  // map where the customer name ends. What the caller meant by the last word is
  // decided by what exists, not by a list of known environment names.
  const label = matchNamespacesPhrase(namespaceValues, phrase);
  const byLabel = label.namespaces;
  const { core, tail } = splitNameAndTail(map.rows, phrase);
  const resolved = resolveCustomerNamespaces(map.rows, { core, qualifiers: tail, controlPlaneId });
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
  const liveNamespaces = new Set(namespaceValues);
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

// The parts of a resolution worth returning to the caller: how the customer was
// found, and whether the mapping behind it was live or a fallback.
export function resolutionReport(resolution = {}) {
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

// What the customer tools' answers are built from: the map's source, age and
// warning; lists capped with how many were left out; a deployment as reported;
// the note for a name that reads two ways; and what of a resolution reaches
// grafana_logs_link's caller.
import { matchCustomers, describeCustomer, listNames, MAX_NAMES } from "./customerMatch.js";

// One deployment as reported to the caller.
export const deploymentOf = (r) => ({
  customer: r.customer,
  data_plane_id: r.data_plane_id,
  region: r.region,
  provider: r.provider,
  env: r.env,
});

// At most `max` items under `key`, and how many were left out under
// `truncatedKey` (0 when none were), so a short list is never read as complete.
export function cappedList(list, max, key, truncatedKey) {
  return { [key]: list.slice(0, max), [truncatedKey]: Math.max(0, list.length - max) };
}

// `entry` with each of its `keys` that holds a list capped the same way, the
// count under `<key>_truncated`.
export function cappedLists(entry, max, keys) {
  const capped = { ...entry };
  for (const key of keys) {
    if (Array.isArray(entry[key])) Object.assign(capped, cappedList(entry[key], max, key, `${key}_truncated`));
  }
  return capped;
}

// What every answer says about the map behind it: which source answered, how
// old the map is, and its warning. Built here once, because copying the fields
// into each answer by hand is how every refusal came to drop the age. Unknown
// values are left out (an unreadable map has no age), never sent as null.
export function mapFields(map) {
  const fields = {
    map_source: map.source,
    map_generated_at: map.generated_at,
    map_generated_days_ago: map.generated_days_ago,
    map_warning: map.warning,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
}

// At most MAX_NAMES candidates, and how many were left out.
export function cappedCandidates(candidates = []) {
  return {
    candidates: candidates.slice(0, MAX_NAMES),
    ...(candidates.length > MAX_NAMES ? { candidates_truncated: candidates.length - MAX_NAMES } : {}),
  };
}

// A phrase that is one customer's whole name and another's name followed by
// words describing its deployments ("acme dev": the customer acme dev, or
// acme's dev), and how to pick one: control_plane_id when the two are on
// different organizations, else a data plane's full id. The same text for
// grafana_logs_link's refusal and grafana_find_customer's note. A customer can
// be on many organizations, so at most ten of each customer's ids are named.
export function twoReadings(rows, phrase, split) {
  const [whole, other] = [split.core, split.also.core].map((core) => describeCustomer(matchCustomers(rows, core)));
  const sharedOrg = whole.control_plane_ids.some((id) => other.control_plane_ids.includes(id));
  return {
    whole,
    other,
    reads:
      `"${phrase}" reads two ways: the customer ${whole.customer}, or ${other.customer}'s ` +
      `deployments described by "${split.also.tail.join(" ")}".`,
    choice: sharedOrg
      ? "Pass the full id of the data plane you mean."
      : `Pass control_plane_id to choose (${whole.customer}: ${listNames(whole.control_plane_ids)}; ` +
        `${other.customer}: ${listNames(other.control_plane_ids)}), or the full id of a data plane.`,
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
    "control_plane_is_single_tenant",
    "shared_data_planes",
    "shared_data_planes_truncated",
    "ambiguous_customer",
    "candidates",
    "candidates_truncated",
    "similar_names_not_searched",
    "partial_match_unchecked",
    "partial_name_match",
    "matched_by_id",
    "owner_unknown",
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

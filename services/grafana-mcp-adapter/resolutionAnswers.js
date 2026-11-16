// The answers resolveFromRoutes (customerResolver.js) gives a name, once it
// has decided which applies: each refusal, "nothing found", and the
// namespaces to search. An id typed as client is answered in idResolution.js.
import { RESTART_HINT } from "./grafanaClient.js";
import { listNames, MAX_NAMES } from "./customerMatch.js";
import { deploymentOf, cappedList, mapFields, cappedCandidates, twoReadings } from "./customerResponses.js";

// Refused: the phrase reads as two customers and control_plane_id does not
// pick one. Both readings are listed as candidates; nothing is searched.
export function twoReadingsRefusal({ phrase, split, controlPlaneId, onId, map }) {
  const { whole, other, reads, choice } = twoReadings(map.rows, phrase, split);
  return {
    namespaces: [],
    via: "none",
    refused: true,
    ambiguous_customer: true,
    ...cappedCandidates([whole, other]),
    note:
      `${reads} Either could return the other's logs, so nothing was searched. ` +
      (controlPlaneId ? `control_plane_id "${controlPlaneId}" is on ${onId.length ? "both" : "neither"} of them. ` : "") +
      choice,
    ...mapFields(map),
  };
}

// Refused by scopeToOneCustomer (customerScope.js), whose refusal says why.
// Nothing is searched.
export function scopeRefusal({ scope, map }) {
  return {
    namespaces: [],
    via: "none",
    refused: true,
    ...scope.refusal,
    ...mapFields(map),
  };
}

// Refused: data planes the map lists under more than one customer
// (shared_data_planes). Nothing is searched.
export function sharedDataPlaneRefusal({ resolved, map }) {
  return {
    namespaces: [],
    via: "none",
    refused: true,
    ...cappedList(resolved.shared_data_planes, MAX_NAMES, "shared_data_planes", "shared_data_planes_truncated"),
    note: resolved.reason,
    ...mapFields(map),
  };
}

// Words that narrow neither route are refused, not dropped: both routes found
// the customer only by ignoring them, so searching either would return more
// than was asked for. What exists is listed so the caller can retry. The
// likeliest such word is a component typed into the client ("lumen prod
// gateway"), so the note says where it belongs.
const componentHint = "If it names a component (gateway, api, ui...), pass it as component instead.";
export function unknownWordsRefusal({ label, skipped, resolved, map }) {
  const labelPart = label.tail.length && skipped.length
    ? `"${label.tail.join(" ")}" is in none of the namespaces found for "${label.name}" (${listNames(skipped)}).`
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
      ? [labelPart, resolved.reason, componentHint].filter(Boolean).join(" ")
      : `${labelPart} Nothing was searched. Retry without it, or with one of those namespaces. ${componentHint}`,
    ...mapFields(map),
  };
}

// Refused: control_plane_id selected nothing from the map, or there was no
// map to select from; the note says which. Nothing is searched.
export function controlPlaneRefusal({ phrase, controlPlaneId, resolved, map }) {
  const note =
    map.source === "unavailable"
      ? `control_plane_id "${controlPlaneId}" could not be applied: the customer map could not be read (map_warning says why), ` +
        `so "${phrase}" could not be looked up in it. Nothing was searched. Retry once the map can be read.`
      : resolved.reason && resolved.unknown_control_plane
        ? resolved.reason
        : resolved.ambiguous
          ? resolved.same_name
            ? resolved.reason
            : `${resolved.reason} control_plane_id "${controlPlaneId}" was not applied to any of them: pass the exact customer name.`
          : `control_plane_id "${controlPlaneId}" only narrows a Gravitee Cloud customer, and "${phrase}" is not one ` +
            "in the customer map. Nothing was searched. Drop control_plane_id, or check the name.";
  return {
    namespaces: [],
    via: "none",
    refused: true,
    unknown_control_plane: true,
    requested_control_plane_id: controlPlaneId,
    control_plane_ids: resolved.control_plane_ids || [],
    ...(resolved.ambiguous ? { ambiguous_customer: true, ...cappedCandidates(resolved.candidates) } : {}),
    note,
    ...mapFields(map),
  };
}

// A name the map cannot narrow to one customer: its candidates are listed
// and none is searched. The hosted namespaces in byLabel still are; with
// none, the answer is refused.
export function ambiguousAnswer({ byLabel, label, skipped, resolved, map }) {
  return {
    namespaces: byLabel,
    via: byLabel.length ? "namespace_label" : "none",
    ...(byLabel.length ? {} : { refused: true }),
    ambiguous_customer: true,
    ...cappedCandidates(resolved.candidates),
    ...(skipped.length ? { skipped_namespaces: skipped } : {}),
    note: byLabel.length
      ? `${resolved.reason} Only the namespaces named after "${label.name}" (${listNames(byLabel)}) were searched.`
      : resolved.reason,
    ...mapFields(map),
  };
}

// Refused: nothing was found, but Loki's namespace list or the map (or both)
// could not be read, so that is not "no such customer". The note says what
// to retry or check.
export function sourcesDownRefusal({ phrase, liveNamespacesKnown, mapUnavailable, failure, map }) {
  const lokiReason = failure ? ` (${failure.reason})` : "";
  const failed =
    !liveNamespacesKnown && mapUnavailable
      ? `Neither Loki's namespace list${lokiReason} nor the customer map could be read, so "${phrase}" could ` +
        "not be matched to any customer"
      : !liveNamespacesKnown
        ? `Loki did not return its namespace list${lokiReason}, so "${phrase}" could not be matched to a ` +
          "customer's namespaces"
        : `The customer map could not be read and no hosted namespace is called "${phrase}", so whether it is a ` +
          "Gravitee Cloud customer cannot be checked";
  // A Loki failure a retry will not fix says what to check instead. When
  // the map is down too, its own reason is in map_warning.
  const lokiWillNotPass = !liveNamespacesKnown && failure && !failure.retryable;
  const checkLoki =
    "check GRAFANA_LOGS_DATASOURCE_UID (the datasource's uid, not its display name) and GRAFANA_TOKEN in .env";
  return {
    namespaces: [],
    via: "none",
    refused: true,
    note:
      `${failed}. Nothing was searched: a service_name search alone could return another customer's logs. ` +
      (lokiWillNotPass
        ? (mapUnavailable
            ? `A retry will not fix Loki's part: ${checkLoki}; map_warning says why the map could not be read. `
            : `A retry will not fix this: ${checkLoki}. `) + RESTART_HINT
        : !mapUnavailable
          ? "Retry in a moment."
          : liveNamespacesKnown
            ? "Retry once the map can be read (map_warning says why), or pass a data plane's full namespace " +
              "(apim-dp-...), which is searched without the map."
            : "Retry once both can be read (map_warning says why the map could not)."),
    ...mapFields(map),
  };
}

// Both sources answered and neither found the client. Not refused: the
// caller may then search service_name, outside Cloud namespaces.
export function nothingFound({ map }) {
  return {
    namespaces: [],
    via: "none",
    ...mapFields(map),
  };
}

// The answer with namespaces to search: which route found them, and what the
// caller should know about them and about what was left out.
export function resolvedAnswer({
  namespaces,
  byLabel,
  skipped,
  label,
  resolved,
  scope,
  controlPlaneId,
  namespaceValues,
  liveNamespacesKnown,
  map,
}) {
  const via =
    byLabel.length && resolved.namespaces.length
      ? "namespace_label+customer_map"
      : byLabel.length
        ? "namespace_label"
        : "customer_map";

  // The map is not complete or eternally fresh: some live data planes are absent
  // from it, and some customers' mapped ids no longer exist because their
  // deployment was recreated. A mapped namespace that Loki has never heard of in
  // this range would otherwise produce a confident "no logs for this customer" —
  // a false negative dressed as an answer. Flag it instead.
  const liveNamespaces = new Set(namespaceValues);
  const absent = liveNamespacesKnown ? resolved.namespaces.filter((n) => !liveNamespaces.has(n)) : [];

  return {
    namespaces,
    via,
    ...(skipped.length
      ? {
          skipped_namespaces: skipped,
          skipped_namespaces_note: label.tail.length
            ? `Found for "${label.name}" but not for "${label.tail.join(" ")}", so not searched. ` +
              "Name one of them to search it."
            : `Found for "${label.name}", but a hosted namespace is on no Cockpit organization, so ` +
              `control_plane_id "${controlPlaneId}" leaves it out. Drop control_plane_id to search it.`,
        }
      : {}),
    ...(absent.length ? { mapped_namespaces_absent_in_range: absent } : {}),
    // Names that only contain the one asked for, set aside because another
    // customer has it as a whole name. Said, so a caller who meant one of them
    // knows to name it.
    ...(scope.setAside.length
      ? {
          similar_names_not_searched: scope.setAside.slice(0, MAX_NAMES),
          note:
            `${listNames(scope.setAside.map((c) => c.customer))} only partly ` +
            `${scope.setAside.length > 1 ? "match" : "matches"} "${scope.exactName}", ` +
            `which is another customer's whole name, so ${scope.setAside.length > 1 ? "they were" : "it was"} ` +
            "not searched. Use the full name to search one.",
        }
      : {}),
    ...(scope.partialName
      ? {
          partial_name_match: true,
          note:
            `"${scope.asked}" is not a whole customer name: it matches only part of ` +
            `${scope.partialName}'s ${scope.partialOf}, so it was searched as ${scope.partialName}. ` +
            "Use the full name if another customer was meant.",
        }
      : {}),
    // Reported even when only the namespace label answered: a customer can be
    // hosted and on Cloud at once, so with an unavailable or stale map this
    // result may be missing its Cloud deployments, and the caller must know.
    ...mapFields(map),
    label_namespaces: byLabel,
    matched_deployments: resolved.matched.map(deploymentOf),
    env_filter_applied: resolved.env_filter_applied,
    control_plane_ids: resolved.control_plane_ids,
    ...(resolved.spans_multiple_organizations
      ? { spans_multiple_organizations: true, organizations_note: resolved.organizations_note }
      : {}),
    // Control-plane namespaces are SHARED by every customer on that control
    // plane, so they are never searched implicitly under one customer's name.
    // Reported so the caller knows they exist and can ask for them explicitly.
    // A trial's own control plane is not among them: it is searched, and the
    // flag says why a control-plane namespace is in the answer.
    shared_control_plane_namespaces: resolved.control_plane_namespaces,
    ...(resolved.control_plane_is_single_tenant ? { control_plane_is_single_tenant: true } : {}),
  };
}

// Resolving a free-text client to the namespaces holding its logs, for
// grafana_logs_link, by combining two routes: the namespace label and the
// customer map. An id typed as client (idResolution.js), which route's matches
// count (customerScope.js) and the parts its answers are built from
// (customerResponses.js) each have their own module. resolveClient() decides
// from data it is given, so it can be unit-tested directly; resolveNamespaces()
// checks the client and the range, then fetches that data (Loki's namespace
// values and the customer map) and logs why Loki's list could not be read.
import { matchNamespacesPhrase } from "./namespaceMatch.js";
import { namespaceList } from "./lokiDiscovery.js";
import { loadCustomerMap } from "./customerMapLoader.js";
import { RESTART_HINT } from "./grafanaClient.js";
import { fromProblem } from "./helpers.js";
import {
  splitNameAndTail,
  resolveCustomerNamespaces,
  matchCustomers,
  groupByCustomer,
  listNames,
  MAX_NAMES,
  isCloudNamespace,
  dataPlanesWithId,
} from "./customerMatch.js";
import { deploymentOf, cappedList, mapFields, cappedCandidates, twoReadings } from "./customerResponses.js";
import { resolveById } from "./idResolution.js";
import { scopeToOneCustomer } from "./customerScope.js";

// What a map answer set aside contributes.
const NOTHING = { matched: [], namespaces: [], control_plane_namespaces: [] };

// Resolve a free-text client to the namespaces holding its logs, by two routes:
//
//  1. The namespace label itself. Hosted/standalone customers get a namespace
//     named after them (`kestrel-prod`, `demo-qa`), so matching label values works.
//
//  2. The Gravitee Cloud customer map. Cockpit tenants live in
//     `apim-dp-<controlPlaneId>-<dataPlaneId>` and carry their name NOWHERE in
//     their labels, so route 1 returns nothing for them however the name is
//     spelled.
//
// Returns which route answered, and any warning about the map's freshness, so a
// caller can tell a live mapping from a fallback one. An empty `namespaces` that
// is not `refused` means both sources answered and neither found the client: the
// caller may then search `service_name`, outside Cloud namespaces.
export async function resolveNamespaces(client, { datasourceUid, from, controlPlaneId } = {}) {
  const phrase = String(client || "").trim();
  // Nothing to resolve is not "both sources found nothing" (the tool schema
  // already refuses a blank client).
  if (!phrase) throw new Error("client is required");
  // A range Loki refuses gets the HTTP 400 a malformed datasource uid also
  // gets, and the advice for that 400 can only point at the uid and the token.
  const rangeProblem = fromProblem(from);
  if (rangeProblem) throw new Error(rangeProblem);

  const { namespaceValues, failure } = await namespaceList(datasourceUid, from);
  const map = await loadCustomerMap();
  return resolveClient({ phrase, controlPlaneId, namespaceValues, map, lookupFailure: failure });
}

// `namespaceValues: null` means Loki did not return its namespace list. That is
// not "no namespaces": hosted customers cannot be matched by namespace, and
// mapped namespaces cannot be checked against Loki, so calling them all absent
// would blame a stale map for a failed lookup. The result says so instead, with
// `lookupFailure` (from describeLookupFailure) giving why and whether a retry
// can help, when the caller knows.
export function resolveClient({ namespaceValues = [], lookupFailure: failure = null, controlPlaneId, ...given }) {
  // Every id in the customer map is lower case with no spaces around it (the
  // loader checks each row), so control_plane_id is compared the same way. A
  // blank one names no organization: it is not given.
  const rest = { ...given, controlPlaneId: String(controlPlaneId ?? "").trim().toLowerCase() || undefined };
  if (namespaceValues !== null) return resolveFromRoutes({ ...rest, namespaceValues, liveNamespacesKnown: true });
  return {
    ...resolveFromRoutes({ ...rest, namespaceValues: [], liveNamespacesKnown: false, lookupFailure: failure }),
    namespace_lookup_failed: true,
    namespace_lookup_note:
      `Loki did not return its namespace list${failure ? ` (${failure.reason})` : ""}, so hosted customers ` +
      "could not be matched by namespace and mapped namespaces were not checked against Loki.",
  };
}

function resolveFromRoutes({ phrase, controlPlaneId, namespaceValues, liveNamespacesKnown, map, lookupFailure: failure = null }) {
  const byId = resolveById({ phrase, controlPlaneId, namespaceValues, liveNamespacesKnown, map });
  if (byId) return byId;

  // BOTH routes, always — never stop at the first hit. A customer can exist in
  // both populations at once: acme has a hosted `acme-prod` namespace
  // AND Cockpit data planes under `apim-dp-cp1111-*`. Returning early on the
  // label match would search half its logs and report that as the whole story.
  // Neither route classifies words. The namespace route matches the phrase as
  // typed and gives ground one trailing word at a time; the map route asks the
  // map where the customer name ends. What the caller meant by the last word is
  // decided by what exists, not by a list of known environment names.
  // Cloud namespaces carry ids, not names: only the map and resolveById reach them.
  const found = matchNamespacesPhrase(namespaceValues.filter((n) => !isCloudNamespace(n)), phrase);
  let split = splitNameAndTail(map.rows, phrase);
  // Two customers in one phrase: "acme dev" is the customer "acme dev", and
  // acme's dev. A control_plane_id only one of them is on picks it; otherwise
  // neither is searched, since either could be the other's logs. When the
  // whole name is itself two customers' (names that differ only in
  // separators), a control_plane_id still picks the other reading; otherwise
  // resolveCustomerNamespaces refuses the name below, with the way out.
  if (split.also) {
    const readings = [split, { ...split.also, partial: false }];
    const rowsOf = (reading) => matchCustomers(map.rows, reading.core);
    const onId = controlPlaneId
      ? readings.filter((reading) => rowsOf(reading).some((r) => r.control_plane_id === controlPlaneId))
      : [];
    if (onId.length === 1) {
      split = onId[0];
    } else if (groupByCustomer(rowsOf(split)).size === 1) {
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
  }
  const scope = scopeToOneCustomer({
    phrase,
    found,
    split,
    mapMatched: matchCustomers(map.rows, split.core),
    controlPlaneId,
    labelSearched: !found.tail.length && !controlPlaneId,
    bothAnswered: liveNamespacesKnown && map.source !== "unavailable",
  });
  if (scope.refusal) {
    return {
      namespaces: [],
      via: "none",
      refused: true,
      ...scope.refusal,
      ...mapFields(map),
    };
  }
  const label = scope.useLabel ? found : { ...found, namespaces: [] };
  // The label route only counts when it matched every word typed. Namespaces it
  // found by dropping trailing words ignore those words: "acme dev" has no
  // `acme-dev`, so it drops "dev" and finds `acme-prod`, and dev would also
  // search prod. Such namespaces are reported as skipped, never searched.
  // A control_plane_id names one Cockpit organization and a hosted namespace is
  // on none, so with an id the label route's namespaces are skipped as well:
  // searching them would widen past the organization asked for.
  const byLabel = label.tail.length || controlPlaneId ? [] : label.namespaces;
  const skipped = byLabel.length ? [] : label.namespaces;
  const answer = resolveCustomerNamespaces(map.rows, { core: split.core, qualifiers: split.tail, controlPlaneId });
  // A map answer set aside contributes nothing. An ambiguous one already
  // contributes nothing, and is kept so its candidates are reported.
  const resolved = scope.useMap || answer.ambiguous ? answer : NOTHING;
  const namespaces = [...new Set([...byLabel, ...resolved.namespaces])];

  // A data plane the map gives two owners is refused here, before the two
  // routes' answers are combined: hosted namespaces included, since the map is
  // wrong about this customer, and a control_plane_id cannot make it right.
  if (resolved.shared_data_planes) {
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
  const refuseUnknownWords = () => {
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
  };

  // control_plane_id only ever narrows. If it selected nothing from the map —
  // an id that is not this customer's, a customer the map does not have, or a
  // name too ambiguous to pick one customer — refuse instead of searching
  // without it: the label route, or the caller's service_name fallback, would
  // return logs the id was meant to exclude.
  if (controlPlaneId && !resolved.namespaces.length) {
    if (resolved.unknown_qualifiers) return refuseUnknownWords();
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

  // An ambiguous fragment contributes NOTHING from the map rather than merging
  // several customers together. The label route is unaffected — a hosted
  // customer that matched by name is still searched — but the caller is told
  // which Cockpit customers were withheld and why.
  // A customer that does not resolve may simply be missing from a stale map, and
  // that is a different answer from "no such customer".
  // With no hosted namespace either, the resolution is refused: falling back to
  // a service_name match across all of Loki would search the very fragment the
  // caller was just told was too ambiguous to search.
  if (resolved.ambiguous) {
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

  if (!namespaces.length && (resolved.unknown_qualifiers || skipped.length)) return refuseUnknownWords();

  if (!namespaces.length) {
    // A data plane's own id (`dp0001`) names no customer and no namespace, but
    // Cloud service names carry it, so the service_name search would reach that
    // data plane (or several sharing the id) without saying whose. Checked only
    // now, so a customer actually called like that is still found by name.
    const dataPlanes = dataPlanesWithId(map.rows, namespaceValues, phrase);
    if (dataPlanes.length) {
      // One the map lists under several customers is never searched, so it is
      // named as such rather than offered as a full namespace to pass.
      const named = dataPlanes.map((d) =>
        d.customer
          ? `${d.namespace} (${d.customer})`
          : d.customers
            ? `${d.namespace} (listed for ${listNames(d.customers)}, so never searched)`
            : d.namespace,
      );
      const searchable = dataPlanes.filter((d) => !d.customers).length;
      return {
        namespaces: [],
        via: "none",
        refused: true,
        matched_by_id: {
          kind: "data_plane_id_only",
          id: phrase.toLowerCase(),
          data_planes: dataPlanes.slice(0, MAX_NAMES),
          ...(dataPlanes.length > MAX_NAMES ? { data_planes_truncated: dataPlanes.length - MAX_NAMES } : {}),
        },
        note:
          (dataPlanes.length === 1
            ? `"${phrase}" is the id of data plane ${named[0]}. `
            : `"${phrase}" is the id of ${dataPlanes.length} data planes: ${listNames(named)}. `) +
          "Nothing was searched" +
          (!searchable
            ? "."
            : dataPlanes.length === 1
              ? ": pass the full namespace to search that data plane."
              : ": pass the full namespace of the one you mean."),
        ...mapFields(map),
      };
    }
    // The service_name search is the last resort for a customer with no
    // namespace of its own (one living in a shared `prod`), and only once both
    // sources answered: with Loki's namespace list or the map missing, finding
    // nothing is not "no such customer", and service_name alone could return
    // another customer's logs. A stale snapshot did answer, and says how old.
    const mapUnavailable = map.source === "unavailable";
    if (!liveNamespacesKnown || mapUnavailable) {
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
    return {
      namespaces: [],
      via: "none",
      ...mapFields(map),
    };
  }

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

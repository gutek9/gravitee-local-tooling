// Resolving a free-text client to the namespaces holding its logs, the parts of
// that resolution worth returning to the caller, and finding which customers a
// name or an id matches. resolveClient() and findCustomerMatches() decide from
// data they are given, so they can be unit-tested directly; resolveNamespaces()
// and findCustomer() only fetch that data (Loki's namespace values and the
// customer map) first.
import { matchNamespaces, matchNamespacesAnySegment, matchNamespacesPhrase } from "./namespaceMatch.js";
import { fetchLabelValues } from "./lokiDiscovery.js";
import { loadCustomerMap } from "./customerMapLoader.js";
import {
  splitNameAndTail,
  resolveCustomerNamespaces,
  matchCustomers,
  groupByCustomer,
  describeCustomer,
  sameName,
  listNames,
  MAX_NAMES,
  lookupById,
  dataPlaneNamespace,
  controlPlaneNamespace,
  controlPlaneOf,
  namespacesOf,
  isCloudNamespace,
  dataPlanesWithId,
  dataPlaneOwners,
} from "./customerMatch.js";

// A hosted customer's namespaces are named after it by their first segment
// (`acmecorp-prod`, `acmecorp-dev` -> acmecorp); checked against the live
// namespace list, this holds for every hosted customer. Infrastructure named
// per tenant (`logstash-<tenant>`) is the exception, see the README.
const hostedName = (namespace) => String(namespace).toLowerCase().split("-")[0];

// What a map answer set aside contributes.
const NOTHING = { matched: [], namespaces: [], control_plane_namespaces: [] };

// One deployment as reported to the caller.
const deploymentOf = (r) => ({
  customer: r.customer,
  data_plane_id: r.data_plane_id,
  region: r.region,
  provider: r.provider,
  env: r.env,
});

// At most `max` items under `key`, and how many were left out under
// `truncatedKey` (0 when none were), so a short list is never read as complete.
function cappedList(list, max, key, truncatedKey) {
  return { [key]: list.slice(0, max), [truncatedKey]: Math.max(0, list.length - max) };
}

// What every answer says about the map behind it: which source answered, how
// old the map is, and its warning. Built here once, because copying the fields
// into each answer by hand is how every refusal came to drop the age. Unknown
// values are left out (an unreadable map has no age), never sent as null.
function mapFields(map) {
  const fields = {
    map_source: map.source,
    map_generated_at: map.generated_at,
    map_generated_days_ago: map.generated_days_ago,
    map_warning: map.warning,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
}

// At most MAX_NAMES candidates, and how many were left out.
function cappedCandidates(candidates = []) {
  return {
    candidates: candidates.slice(0, MAX_NAMES),
    ...(candidates.length > MAX_NAMES ? { candidates_truncated: candidates.length - MAX_NAMES } : {}),
  };
}

// One customer per answer. Decides, before anything is searched, which route's
// matches count:
//
//  - Part of a name is trusted only when both sources answered. Without the map
//    or Loki's namespace list, nobody can check that the phrase is not another
//    customer's whole name.
//  - A whole name on one route outranks part of a name on the other: "acme" is
//    a Cloud customer's whole name, so the hosted `acmecorp-*`, which only
//    contains it, is set aside and named, not searched. A word found only after
//    a hosted namespace's first segment (`au` in `blue-x-au-1`) is part of
//    that namespace's name too, never its owner's. Not a hosted whole name
//    with a control_plane_id, though: the id asks for a Cloud organization, a
//    hosted namespace is on none, and the id itself confirms the customer.
//  - What is searched belongs to one customer. Hosted namespaces of two
//    customers ("beac" -> beacon and beaconlabs, "plt live" -> two customers'
//    `plt-live`), or a hosted customer plus a different Cloud one, are refused
//    with the candidates, as the map already does with its own matches.
//
// `labelSearched` is false when the label route's namespaces will not be
// searched anyway: a trailing word they lack, or a control_plane_id.
function scopeToOneCustomer({ phrase, found, split, mapMatched, controlPlaneId, labelSearched, bothAnswered }) {
  const labelNames = [...new Set(found.namespaces.map(hostedName))];
  const mapNames = [...new Set(mapMatched.map((r) => r.customer))];
  const hasLabel = labelNames.length > 0;
  const hasMap = mapNames.length > 0;

  const partialMap = hasMap && split.partial;
  if (!bothAnswered && ((labelSearched && hasLabel && found.partial) || partialMap)) {
    // Whichever route answered, the other one is the source that failed.
    const [name, whose, unchecked] = partialMap
      ? [split.core, `Gravitee Cloud customer ${listNames(mapNames)}`, "Loki did not return its namespace list, so it cannot be checked that no hosted customer"]
      : [found.name, `hosted ${listNames(labelNames)}`, "the customer map could not be read, so it cannot be checked that no Gravitee Cloud customer"];
    return {
      refusal: {
        partial_match_unchecked: true,
        note: `"${name}" is only part of the name of ${whose}, and ${unchecked} is called "${name}" exactly. Nothing was searched. Use the full name.`,
      },
    };
  }

  let useLabel = hasLabel;
  let useMap = hasMap;
  let setAside = [];
  if (hasLabel && hasMap && found.partial !== split.partial) {
    if (found.partial) {
      useLabel = false;
      setAside = labelNames.map((customer) => ({ customer, kind: "hosted" }));
    } else if (!controlPlaneId) {
      useMap = false;
      setAside = mapNames.map((customer) => ({ customer, kind: "gravitee_cloud" }));
    }
  }

  if (useLabel && labelSearched) {
    const names = [...labelNames];
    if (useMap) for (const m of mapNames) if (!names.some((n) => sameName(n, m))) names.push(m);
    if (names.length > 1) {
      const hosted = labelNames.map((customer) => ({
        customer,
        kind: "hosted",
        namespace_count: found.namespaces.filter((n) => hostedName(n) === customer).length,
      }));
      const cloud = useMap ? [...groupByCustomer(mapMatched).values()].map(describeCustomer) : [];
      const candidates = [...hosted, ...cloud].sort(
        (a, b) => a.customer.localeCompare(b.customer) || a.kind.localeCompare(b.kind),
      );
      return {
        refusal: {
          ambiguous_customer: true,
          ...cappedCandidates(candidates),
          note:
            `"${phrase}" matches ${names.length} different customers (${listNames(names.sort())}). ` +
            "Searching them together would return one customer's logs under another's name, so none of them was searched. " +
            "Use the exact customer name.",
        },
      };
    }
  }

  // Part of a name that names one customer is searched, as that customer.
  const partialFromLabel = useLabel && labelSearched && found.partial;
  const partialName = partialFromLabel
    ? labelNames[0]
    : useMap && split.partial && mapNames.length === 1
      ? mapNames[0]
      : null;
  return {
    useLabel,
    useMap,
    setAside,
    exactName: found.partial ? split.core : found.name,
    partialName,
    partialOf: partialFromLabel ? "namespace names" : "name",
    asked: found.partial ? found.name : split.core,
  };
}

// Resolve a free-text client to the namespaces holding its logs, by two routes:
//
//  1. The namespace label itself. Hosted/standalone customers get a namespace
//     named after them (`kestrel-prod`, `demo-qa`), so matching label values works.
//
//  2. The Gravitee Cloud customer map. Cockpit tenants live in
//     `apim-dp-<controlPlaneId>-<dataPlaneId>` and carry their name NOWHERE in
//     their labels, so route 1 returns nothing for them however the name is
//     spelled — the customers this tooling is most useful for were exactly the
//     ones it could not find.
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

// An id typed into client, as support sees it in an alert or a pod name
// (`apim-dp-cp1111-dp0001`, `cp1111-dp0001`, `cp1111`). Cloud namespaces are
// reached this way and through the map, never by the namespace label: `cp1111`
// is a segment of the shared `apim-cp-cp1111` and of every data plane on it, so
// matching it as a name searched several customers at once.
//
// A data plane is one deployment of one customer, so it is searched alone, and
// said whose it is when the map knows; one the map lists under several
// customers is refused, naming them. A control plane is shared by every
// customer on it and is refused. A name the map has whole comes first: a trial
// is named by its control plane id (`trial-tt0001`), and that is one customer.
// Returns null when the phrase is not an id.
function resolveById({ phrase, controlPlaneId, namespaceValues, liveNamespacesKnown, map }) {
  if (/\s/.test(phrase) || map.rows.some((r) => sameName(r.customer, phrase))) return null;
  const lookup = lookupById(map.rows, phrase);
  if (!lookup) return null;
  const live = new Set(namespaceValues);
  // An unreadable map looked nothing up: never say an id is not in it.
  const mapUnreadable = map.source === "unavailable";
  const refuse = (matchedById, note, extra = {}) => ({
    namespaces: [],
    via: "none",
    refused: true,
    matched_by_id: matchedById,
    ...extra,
    note,
    ...mapFields(map),
  });

  if (lookup.kind === "data_plane" && lookup.customers) {
    return refuse(
      { kind: "data_plane", id: lookup.id, customers: lookup.customers.slice(0, MAX_NAMES) },
      `${lookup.note} Nothing was searched.`,
    );
  }

  if (lookup.kind === "data_plane") {
    const rows = lookup.deployments;
    const controlPlanes = [...new Set(rows.map((r) => r.control_plane_id).filter(Boolean))];
    const matchedById = { kind: "data_plane", id: lookup.id, customer: lookup.customer };
    if (controlPlaneId && !controlPlanes.includes(controlPlaneId)) {
      return refuse(
        matchedById,
        `${lookup.id} is ${lookup.customer}'s data plane on ${controlPlanes.join(", ")}, not on "${controlPlaneId}". ` +
          "Nothing was searched.",
        { unknown_control_plane: true, requested_control_plane_id: controlPlaneId, control_plane_ids: controlPlanes },
      );
    }
    const namespaces = [...new Set(rows.map((r) => dataPlaneNamespace(r.data_plane_id)))];
    const absent = liveNamespacesKnown ? namespaces.filter((n) => !live.has(n)) : [];
    return {
      namespaces,
      via: "customer_map",
      matched_by_id: matchedById,
      note: `${lookup.id} is ${lookup.customer}'s data plane, so only it was searched.`,
      ...(absent.length ? { mapped_namespaces_absent_in_range: absent } : {}),
      ...mapFields(map),
      label_namespaces: [],
      matched_deployments: rows.map(deploymentOf),
      env_filter_applied: false,
      control_plane_ids: controlPlanes,
      // Only the data plane asked for is searched, even a trial's; its control
      // plane is reported as shared unless it is the trial's own.
      shared_control_plane_namespaces: namespacesOf(rows).shared_control_plane_namespaces,
    };
  }

  if (lookup.kind === "control_plane") {
    const customers = lookup.customers.slice(0, MAX_NAMES);
    return refuse(
      { kind: "control_plane", id: lookup.id, customers },
      `${lookup.id} is a Cockpit control plane (customers on it: ${listNames(lookup.customers)}). Its namespace is ` +
        "shared by every customer on that organization, so it is never searched under one customer's name. " +
        `Nothing was searched. Pass the customer's name, with control_plane_id "${lookup.id}" to keep to this organization.`,
    );
  }

  // Not in the map. A data plane Loki has is still one deployment: searched
  // alone, without guessing whose it is.
  const matchedById = {
    kind: lookup.kind,
    id: lookup.id,
    ...(lookup.candidate_customers ? { candidate_customers: lookup.candidate_customers.slice(0, MAX_NAMES) } : {}),
  };
  const dataPlane = dataPlaneNamespace(lookup.id);
  if (live.has(dataPlane)) {
    if (controlPlaneId) {
      return refuse(
        matchedById,
        (mapUnreadable
          ? `The customer map could not be read (map_warning says why), so the organization of ${lookup.id} cannot be checked against `
          : `${lookup.id} is not in the customer map, so its organization cannot be checked against `) +
          `control_plane_id "${controlPlaneId}". Nothing was searched. Pass the id alone.`,
        { unknown_control_plane: true, requested_control_plane_id: controlPlaneId },
      );
    }
    return {
      namespaces: [dataPlane],
      via: "namespace_label",
      owner_unknown: true,
      matched_by_id: matchedById,
      note:
        (mapUnreadable
          ? `${dataPlane} is in Loki, but the customer map could not be read (map_warning says why), so whose it is cannot be said; only it was searched.`
          : `${dataPlane} is in Loki but not in the customer map, so whose it is cannot be said; only it was searched.`) +
        (lookup.kind === "unlisted_data_plane" ? ` ${lookup.note}` : ""),
      ...mapFields(map),
      label_namespaces: [dataPlane],
    };
  }
  if (live.has(controlPlaneNamespace(lookup.id))) {
    return refuse(
      matchedById,
      `${controlPlaneNamespace(lookup.id)} is a control plane namespace, shared by every customer on that organization, and ` +
        (mapUnreadable
          ? "the customer map could not be read (map_warning says why), so whose it is cannot be said. Nothing was " +
            "searched. Retry once the map can be read."
          : "the customer map does not say whose. Nothing was searched. Pass the customer's name."),
    );
  }
  // An id the map half knows, but no such namespace: refused rather than left to
  // a service_name search across all of Loki. Anything else was never an id.
  if (lookup.kind === "unlisted_data_plane") {
    return refuse(
      matchedById,
      liveNamespacesKnown
        ? `${dataPlane} is in neither the customer map nor Loki in this range. Nothing was searched.`
        : `${lookup.id} is not in the customer map, and Loki did not return its namespace list. Nothing was searched.`,
    );
  }
  return null;
}

function resolveFromRoutes({ phrase, controlPlaneId, namespaceValues, liveNamespacesKnown, map }) {
  const byId = resolveById({ phrase, controlPlaneId, namespaceValues, liveNamespacesKnown, map });
  if (byId) return byId;

  // BOTH routes, always — never stop at the first hit. A customer can exist in
  // both populations at once: acme has a hosted `acme-prod` namespace
  // AND Cockpit data planes under `apim-dp-cp1111-*`. Returning early on the
  // label match searched half its logs and reported that as the whole story.
  // Neither route classifies words. The namespace route matches the phrase as
  // typed and gives ground one trailing word at a time; the map route asks the
  // map where the customer name ends. What the caller meant by the last word is
  // decided by what exists, not by a list of known environment names.
  // Cloud namespaces carry ids, not names: only the map and resolveById reach them.
  const found = matchNamespacesPhrase(namespaceValues.filter((n) => !isCloudNamespace(n)), phrase);
  let split = splitNameAndTail(map.rows, phrase);
  // Two customers in one phrase: "acme dev" is the customer "acme dev", and
  // acme's dev. A control_plane_id only one of them is on picks it; otherwise
  // neither is searched, since either could be the other's logs.
  if (split.also) {
    const readings = [split, { ...split.also, partial: false }];
    const rowsOf = (reading) => matchCustomers(map.rows, reading.core);
    const onId = controlPlaneId
      ? readings.filter((reading) => rowsOf(reading).some((r) => r.control_plane_id === controlPlaneId))
      : [];
    if (onId.length === 1) {
      split = onId[0];
    } else {
      const [whole, other] = readings.map((reading) => describeCustomer(rowsOf(reading)));
      const sharedOrg = whole.control_plane_ids.some((id) => other.control_plane_ids.includes(id));
      return {
        namespaces: [],
        via: "none",
        refused: true,
        ambiguous_customer: true,
        ...cappedCandidates([whole, other]),
        note:
          `"${phrase}" reads two ways: the customer ${whole.customer}, or ${other.customer}'s ` +
          `deployments described by "${readings[1].tail.join(" ")}". Either could return the other's logs, ` +
          "so nothing was searched. " +
          (controlPlaneId ? `control_plane_id "${controlPlaneId}" is on ${onId.length ? "both" : "neither"} of them. ` : "") +
          (sharedOrg
            ? "Pass the full id of the data plane you mean."
            : `Pass control_plane_id to choose (${whole.customer}: ${whole.control_plane_ids.join(", ")}; ` +
              `${other.customer}: ${other.control_plane_ids.join(", ")}), or the full id of a data plane.`),
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
        ? `${resolved.reason} Only the namespaces named after "${label.name}" (${byLabel.join(", ")}) were searched.`
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
            ? `${d.namespace} (listed for ${d.customers.join(", ")}, so never searched)`
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
      const failed =
        !liveNamespacesKnown && mapUnavailable
          ? `Neither Loki's namespace list nor the customer map could be read, so "${phrase}" could not be matched to any customer`
          : !liveNamespacesKnown
            ? `Loki did not return its namespace list, so "${phrase}" could not be matched to a customer's namespaces`
            : `The customer map could not be read and no hosted namespace is called "${phrase}", so whether it is a ` +
              "Gravitee Cloud customer cannot be checked";
      return {
        namespaces: [],
        via: "none",
        refused: true,
        note:
          `${failed}. Nothing was searched: a service_name search alone could return another customer's logs. ` +
          (!mapUnavailable
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
  // Ask the map where the name ends, so "acme recette" finds acme. A phrase
  // that reads as two customers ("acme dev") lists both.
  const split = splitNameAndTail(map.rows, needle);
  const groups = groupByCustomer([
    ...matchCustomers(map.rows, split.core),
    ...(split.also ? matchCustomers(map.rows, split.also.core) : []),
  ]);
  const owners = dataPlaneOwners(map.rows);
  const cockpit = [...groups.values()]
    // The same namespaces grafana_logs_link searches for this customer, except
    // a data plane the map lists under another customer too: flagged here, and
    // grafana_logs_link refuses it.
    .map((rows) => {
      const shared = [...new Set(rows.map((r) => r.data_plane_id))]
        .map((id) => ({ data_plane_id: id, customers: owners.get(id.toLowerCase()) }))
        .filter((d) => d.customers.length > 1);
      return {
        ...describeCustomer(rows),
        ...namespacesOf(rows),
        ...(shared.length ? cappedList(shared, maxResults, "shared_data_planes", "shared_data_planes_truncated") : {}),
      };
    })
    .sort((a, b) => a.customer.localeCompare(b.customer));

  // Hosted customers have no map entry; their namespace carries the name. Cloud
  // namespaces carry ids, so a name match says nothing about whose they are:
  // they are matched and listed apart, and owners come from the map or an id.
  // Matched apart too, so an exact Cloud match ("dp" is a segment of every
  // data plane) does not hide a hosted namespace the name matches partly. A
  // Cloud namespace has no owner segment, so any whole segment counts there.
  const hostedNamespaces = matchNamespaces(namespaceValues.filter((n) => !isCloudNamespace(n)), needle);
  const cloudNamespaces = matchNamespacesAnySegment(namespaceValues.filter(isCloudNamespace), needle);

  // Data planes that are live on this customer's control planes but which the
  // map does not attribute to anyone. They may belong to another customer on
  // the same (shared) control plane, so they are reported as unattributed and
  // never folded into the customer's namespaces.
  const mappedNs = new Set(map.rows.map((r) => dataPlaneNamespace(r.data_plane_id)));
  for (const entry of cockpit) {
    const unattributed = namespaceValues.filter(
      (n) =>
        n.startsWith("apim-dp-") &&
        entry.control_plane_ids.includes(controlPlaneOf(n.slice("apim-dp-".length))) &&
        !mappedNs.has(n),
    );
    if (unattributed.length) {
      Object.assign(
        entry,
        cappedList(unattributed, maxResults, "unattributed_namespaces_on_same_control_plane", "unattributed_truncated"),
      );
      entry.unattributed_note =
        "Live data planes on this customer's control plane that the map does not attribute to any customer. " +
        "A control plane is shared, so these may belong to someone else — they are NOT searched as this customer.";
    }
  }

  const result = {
    query,
    ...(byId && byId.kind !== "unknown" ? { matched_by_id: byId } : {}),
    ...mapFields(map),
    // max_results caps every list, each with how many were left out.
    ...cappedList(cockpit, maxResults, "gravitee_cloud_customers", "gravitee_cloud_truncated"),
    ...cappedList(hostedNamespaces, maxResults, "hosted_namespaces", "hosted_namespaces_truncated"),
    ...cappedList(cloudNamespaces, maxResults, "cloud_namespaces", "cloud_namespaces_truncated"),
    ...(lookupFailed
      ? {
          namespace_lookup_failed: true,
          namespace_lookup_note:
            "Loki did not return its namespace list, so hosted namespaces and unattributed data planes " +
            "could not be checked.",
        }
      : {}),
  };

  if (map.source === "unavailable") {
    // Nothing was looked up in the map, so no note may say a name or an id is
    // not in it, or that nothing matched.
    result.note =
      "The customer map could not be read (map_warning says why), so Gravitee Cloud customers and ids were not checked. " +
      (lookupFailed
        ? "Loki did not return its namespace list either, so nothing could be checked."
        : hostedNamespaces.length || cloudNamespaces.length
          ? `Only namespaces found in Loki by name are listed${cloudNamespaces.length ? "; whose the ones in cloud_namespaces are cannot be said without the map" : ""}.`
          : `No namespace in Loki matched "${query}".`);
  } else if (cockpit.length > 1) {
    result.note =
      `"${query}" matches ${cockpit.length} different Gravitee Cloud customers. The log tools will not ` +
      "search them together — pass one exact customer name.";
  } else if (cockpit.length === 1 && cockpit[0].control_plane_ids.length > 1) {
    result.note =
      `"${cockpit[0].customer}" spans ${cockpit[0].control_plane_ids.length} separate Cockpit organizations ` +
      `(${cockpit[0].control_plane_ids.join(", ")}). Pass control_plane_id to narrow to one.`;
  } else if (byId && byId.kind === "unknown" && !cockpit.length && ID_SHAPED.test(query.trim())) {
    // A live namespace the map cannot attribute. Such namespaces exist, some on
    // control planes the CSV has never heard of. Saying nothing here would
    // leave the caller thinking the lookup simply failed, when the real
    // answer is "this exists and nobody knows whose it is".
    const live = hostedNamespaces.length > 0 || cloudNamespaces.length > 0;
    result.note =
      `${byId.note}${live ? " The namespace does exist in Loki, so this is a real deployment the map does not " +
      "cover — you can still query it directly by namespace, but its owner cannot be determined from the map." : ""}`;
  } else if (byId && byId.kind !== "unknown" && byId.note) {
    result.note = byId.note;
  } else if (!cockpit.length && lookupFailed) {
    result.note =
      `No Gravitee Cloud customer matched "${query}", and hosted namespaces could not be checked: ` +
      "Loki did not return its namespace list.";
  } else if (!cockpit.length && !hostedNamespaces.length && !cloudNamespaces.length) {
    result.note =
      byId && byId.kind === "unknown"
        ? `No Gravitee Cloud customer, hosted namespace, or known id matched "${query}".`
        : `No Gravitee Cloud customer or hosted namespace matched "${query}".`;
  }
  return result;
}

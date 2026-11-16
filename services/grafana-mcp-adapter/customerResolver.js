// Resolving a free-text client to the namespaces holding its logs, for
// grafana_logs_link, by combining two routes: the namespace label and the
// customer map. resolveFromRoutes() keeps the decisions and their order; an
// id typed as client (idResolution.js), which route's matches count
// (customerScope.js) and the answers to a name (resolutionAnswers.js) each
// have their own module. resolveClient() decides from data it is given, so it
// can be unit-tested directly; resolveNamespaces() checks the client and the
// range, then fetches that data: Loki's namespace values (namespaceList, in
// lokiDiscovery.js, logs why they could not be read) and the customer map.
import { matchNamespacesPhrase } from "./namespaceMatch.js";
import { namespaceList } from "./lokiDiscovery.js";
import { loadCustomerMap } from "./customerMapLoader.js";
import { fromProblem } from "./helpers.js";
import {
  splitNameAndTail,
  resolveCustomerNamespaces,
  matchCustomers,
  groupByCustomer,
  isCloudNamespace,
} from "./customerMatch.js";
import { resolveById, resolveDataPlaneId } from "./idResolution.js";
import { scopeToOneCustomer } from "./customerScope.js";
import {
  twoReadingsRefusal,
  scopeRefusal,
  sharedDataPlaneRefusal,
  unknownWordsRefusal,
  controlPlaneRefusal,
  ambiguousAnswer,
  sourcesDownRefusal,
  nothingFound,
  resolvedAnswer,
} from "./resolutionAnswers.js";

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
      return twoReadingsRefusal({ phrase, split, controlPlaneId, onId, map });
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
  if (scope.refusal) return scopeRefusal({ scope, map });
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
  if (resolved.shared_data_planes) return sharedDataPlaneRefusal({ resolved, map });

  // control_plane_id only ever narrows. If it selected nothing from the map —
  // an id that is not this customer's, a customer the map does not have, or a
  // name too ambiguous to pick one customer — refuse instead of searching
  // without it: the label route, or the caller's service_name fallback, would
  // return logs the id was meant to exclude.
  if (controlPlaneId && !resolved.namespaces.length) {
    if (resolved.unknown_qualifiers) return unknownWordsRefusal({ label, skipped, resolved, map });
    return controlPlaneRefusal({ phrase, controlPlaneId, resolved, map });
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
  if (resolved.ambiguous) return ambiguousAnswer({ byLabel, label, skipped, resolved, map });

  if (!namespaces.length && (resolved.unknown_qualifiers || skipped.length)) return unknownWordsRefusal({ label, skipped, resolved, map });

  if (!namespaces.length) {
    // A data plane's own id (`dp0001`) names no customer and no namespace, but
    // Cloud service names carry it, so the service_name search would reach that
    // data plane (or several sharing the id) without saying whose. Checked only
    // now, so a customer actually called like that is still found by name.
    const byDataPlaneId = resolveDataPlaneId({ phrase, namespaceValues, map });
    if (byDataPlaneId) return byDataPlaneId;
    // The service_name search is the last resort for a customer with no
    // namespace of its own (one living in a shared `prod`), and only once both
    // sources answered: with Loki's namespace list or the map missing, finding
    // nothing is not "no such customer", and service_name alone could return
    // another customer's logs. A stale snapshot did answer, and says how old.
    const mapUnavailable = map.source === "unavailable";
    if (!liveNamespacesKnown || mapUnavailable) {
      return sourcesDownRefusal({ phrase, liveNamespacesKnown, mapUnavailable, failure, map });
    }
    return nothingFound({ map });
  }

  return resolvedAnswer({
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
  });
}

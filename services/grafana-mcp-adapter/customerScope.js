// One customer per answer: which route's matches count, decided before anything
// is searched, between the hosted namespaces the label route found and the
// Gravitee Cloud customers the map matched (scopeToOneCustomer).
import { groupByCustomer, describeCustomer, sameName, listNames } from "./customerMatch.js";
import { cappedCandidates } from "./customerResponses.js";

// A hosted customer's namespaces are named after it by their first segment
// (`acmecorp-prod`, `acmecorp-dev` -> acmecorp); checked against the live
// namespace list, this holds for every hosted customer. Infrastructure named
// per tenant (`logstash-<tenant>`) is the exception, see the README.
const hostedName = (namespace) => String(namespace).toLowerCase().split("-")[0];

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
export function scopeToOneCustomer({ phrase, found, split, mapMatched, controlPlaneId, labelSearched, bothAnswered }) {
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

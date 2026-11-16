// grafana_find_customer: which customers and deployments a name, or an id seen
// in an alert, matches, without querying any logs. findCustomerMatches()
// decides from data it is given, so it can be unit-tested directly;
// findCustomer() only fetches that data (the customer map and Loki's namespace
// values) first, and logs why Loki's list could not be read.
import { matchNamespaces, matchNamespacesAnySegment } from "./namespaceMatch.js";
import { namespaceList } from "./lokiDiscovery.js";
import { loadCustomerMap } from "./customerMapLoader.js";
import { LOKI_MAX_DAYS_BACK } from "./helpers.js";
import {
  splitNameAndTail,
  matchCustomers,
  groupByCustomer,
  describeCustomer,
  listNames,
  lookupById,
  dataPlaneNamespace,
  controlPlaneOf,
  namespacesOf,
  isCloudNamespace,
  dataPlaneOwners,
} from "./customerMatch.js";
import { cappedList, cappedLists, mapFields, twoReadings } from "./customerResponses.js";

// An id or namespace as it appears in an alert, a pod name or a dashboard
// (`apim-dp-cp1111-dp0001`, `cp1111-dp0001`), as opposed to a customer name.
const ID_SHAPED = /^(apim-(dp|cp)-[0-9a-z-]+|[0-9a-z]+(-[0-9a-z]+)+)$/i;

// How far back grafana_find_customer looks for live namespaces: a deployment
// absent over that window is taken as gone, not merely quiet. As far back as
// Loki answers.
const FIND_WINDOW_DAYS = LOKI_MAX_DAYS_BACK;

// A Gravitee Cloud customer's and matched_by_id's own lists, capped by
// max_results like the answer's. A customer's shared and unattributed data
// planes are capped where they are built.
const CUSTOMER_LISTS = ["namespaces", "shared_control_plane_namespaces", "control_plane_ids", "envs", "regions"];
const MATCHED_BY_ID_LISTS = ["customers", "candidate_customers", "deployments"];

// Which customers and deployments a name, or an id seen in an alert, matches,
// without querying any logs.
export async function findCustomer(query, { datasourceUid, maxResults = 20 } = {}) {
  const map = await loadCustomerMap();
  const { namespaceValues, failure } = await namespaceList(datasourceUid, `now-${FIND_WINDOW_DAYS}d`);
  return findCustomerMatches({ query, map, namespaceValues, maxResults, lookupFailure: failure });
}

// `namespaceValues: null` means Loki did not return its namespace list: hosted
// namespaces and unattributed data planes could not be checked, which is not the
// same answer as "none matched".
export function findCustomerMatches({ query, map, namespaceValues: givenValues = [], maxResults = 20, lookupFailure: failure = null }) {
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
  // Customers whose whole name the query is: two or more when their names
  // differ only in separators ("acme dev", "acme-dev").
  const named = split.partial ? new Map() : groupByCustomer(matchCustomers(map.rows, split.core));
  const groups = groupByCustomer([
    ...matchCustomers(map.rows, split.core),
    ...(split.also ? matchCustomers(map.rows, split.also.core) : []),
  ]);
  const owners = dataPlaneOwners(map.rows);
  const cockpit = [...groups.values()]
    // The customer's namespaces, from namespacesOf as grafana_logs_link gets
    // them. A data plane the map lists under another customer too is flagged
    // here: grafana_logs_link refuses any search that includes it.
    .map((rows) => {
      const shared = [...new Set(rows.map((r) => r.data_plane_id))]
        .map((id) => ({ data_plane_id: id, customers: owners.get(id.toLowerCase()) }))
        .filter((d) => d.customers.length > 1);
      return {
        ...describeCustomer(rows),
        ...namespacesOf(rows),
        ...(shared.length
          ? cappedList(
              shared.map((d) => cappedLists(d, maxResults, ["customers"])),
              maxResults,
              "shared_data_planes",
              "shared_data_planes_truncated",
            )
          : {}),
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

  // max_results caps every list, each with how many were left out: a customer
  // with many deployments or a control plane with many customers must not make
  // the answer unbounded. The notes below read the whole lists, but name at
  // most ten of any list (listNames), so they stay bounded too.
  const customers = cappedList(cockpit, maxResults, "gravitee_cloud_customers", "gravitee_cloud_truncated");
  customers.gravitee_cloud_customers = customers.gravitee_cloud_customers.map((entry) =>
    cappedLists(entry, maxResults, CUSTOMER_LISTS),
  );
  const result = {
    query,
    ...(byId && byId.kind !== "unknown" ? { matched_by_id: cappedLists(byId, maxResults, MATCHED_BY_ID_LISTS) } : {}),
    ...mapFields(map),
    ...customers,
    ...cappedList(hostedNamespaces, maxResults, "hosted_namespaces", "hosted_namespaces_truncated"),
    ...cappedList(cloudNamespaces, maxResults, "cloud_namespaces", "cloud_namespaces_truncated"),
    ...(lookupFailed
      ? {
          namespace_lookup_failed: true,
          namespace_lookup_note:
            `Loki did not return its namespace list${failure ? ` (${failure.reason})` : ""}, so hosted namespaces ` +
            "and unattributed data planes could not be checked.",
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
  } else if (named.size > 1) {
    // This note and the next give what grafana_logs_link accepts for such a
    // name, not the exact name it refuses.
    result.note =
      `"${split.core}" is the name of ${named.size} different Gravitee Cloud customers ` +
      `(${listNames([...named.keys()].sort())}): their names differ only in spaces, dashes or underscores. ` +
      "The log tools cannot pick one of them by the name, nor with control_plane_id: pass the full id of one " +
      "of their data planes (listed in namespaces).";
  } else if (split.also) {
    const { reads, choice } = twoReadings(map.rows, needle, split);
    result.note = `${reads} The log tools refuse the name alone, since either reading could return the other's logs. ${choice}`;
  } else if (cockpit.length > 1) {
    result.note =
      `"${query}" matches ${cockpit.length} different Gravitee Cloud customers. The log tools will not ` +
      "search them together — pass one exact customer name.";
  } else if (cockpit.length === 1 && cockpit[0].control_plane_ids.length > 1) {
    result.note =
      `"${cockpit[0].customer}" spans ${cockpit[0].control_plane_ids.length} separate Cockpit organizations ` +
      `(${listNames(cockpit[0].control_plane_ids)}). Pass control_plane_id to narrow to one.`;
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
  } else if (byId && byId.kind === "data_plane") {
    // A data plane the map gives one owner is an answer, whether or not Loki
    // has its namespace: never "nothing matched".
    const namespace = dataPlaneNamespace(byId.deployments[0].data_plane_id);
    // Compared as written, as grafana_logs_link's selector compares it: the
    // map's ids are lower case, like the Kubernetes namespaces Loki has.
    const seen = namespaceValues.includes(namespace);
    result.note =
      `${byId.id} is ${byId.customer}'s data plane in the customer map (namespace ${namespace}).` +
      (lookupFailed || seen
        ? ""
        : ` Loki has not seen that namespace in the last ${FIND_WINDOW_DAYS} days: the customer map is probably ` +
          "stale (the deployment was removed, or recreated under a new id).");
  } else if (byId && byId.kind === "control_plane") {
    // One customer on a control plane (several get byId's own note).
    result.note = `The customer map lists one customer on control plane ${byId.id}: ${byId.customers[0]}.`;
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

// A client that is an id rather than a customer name, as an alert or a pod name
// shows it: what it names, and whether that is searched alone or refused.
// resolveById returns null when the phrase is not an id; resolveDataPlaneId,
// asked once the name search left nothing to search, when it is no data
// plane's id.
import {
  sameName,
  listNames,
  MAX_NAMES,
  lookupById,
  dataPlaneNamespace,
  controlPlaneNamespace,
  namespacesOf,
  isTrialControlPlane,
  dataPlanesWithId,
} from "./customerMatch.js";
import { deploymentOf, mapFields } from "./customerResponses.js";

// An id typed into client, as support sees it in an alert or a pod name
// (`apim-dp-cp1111-dp0001`, `cp1111-dp0001`, `cp1111`). Cloud namespaces are
// reached this way and through the map, never by the namespace label: `cp1111`
// is a segment of the shared `apim-cp-cp1111` and of every data plane on it, so
// matching it as a name would search several customers at once.
//
// A data plane is one deployment of one customer, so it is searched alone, and
// said whose it is when the map knows; one the map lists under several
// customers is refused, naming them. A control plane is shared by every
// customer on it and is refused, except a trial's, which hosts only that trial
// and is searched alone. A name the map has whole comes first: a trial is
// named by its control plane id (`trial-tt0001`), and that is one customer.
// Returns null when the phrase is not an id.
export function resolveById({ phrase, controlPlaneId, namespaceValues, liveNamespacesKnown, map }) {
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

  // A trial's control plane hosts only that trial, so it is one deployment's,
  // like a data plane: searched alone, never refused as shared. When the map
  // does not list the trial, or cannot be read, only if Loki has it.
  const controlPlane = controlPlaneNamespace(lookup.id);
  const listedTrial = lookup.kind === "control_plane" && isTrialControlPlane(lookup.id);
  if (listedTrial || (lookup.kind === "unknown" && isTrialControlPlane(lookup.id) && live.has(controlPlane))) {
    const matchedById = listedTrial
      ? { kind: "control_plane", id: lookup.id, customer: lookup.customers[0] }
      : { kind: lookup.kind, id: lookup.id };
    if (controlPlaneId && controlPlaneId !== lookup.id) {
      return refuse(matchedById, `${controlPlane} is control plane ${lookup.id}, not "${controlPlaneId}". Nothing was searched.`, {
        unknown_control_plane: true,
        requested_control_plane_id: controlPlaneId,
        control_plane_ids: [lookup.id],
      });
    }
    const absent = listedTrial && liveNamespacesKnown && !live.has(controlPlane);
    return {
      namespaces: [controlPlane],
      via: listedTrial ? "customer_map" : "namespace_label",
      matched_by_id: matchedById,
      ...(listedTrial ? {} : { owner_unknown: true }),
      note:
        (listedTrial
          ? `${controlPlane} is ${lookup.customers[0]}'s own control plane`
          : mapUnreadable
            ? `${controlPlane} is in Loki, but the customer map could not be read (map_warning says why); it is a trial's own control plane`
            : `${controlPlane} is in Loki but not in the customer map; it is a trial's own control plane`) +
        ", which hosts only that trial, so only it was searched. " +
        (listedTrial
          ? `Pass client "${lookup.customers[0]}" to search the whole trial.`
          : "The trial's data planes are searched by their full namespace (apim-dp-...)."),
      ...(absent ? { mapped_namespaces_absent_in_range: [controlPlane] } : {}),
      ...mapFields(map),
      label_namespaces: listedTrial ? [] : [controlPlane],
      control_plane_ids: [lookup.id],
      shared_control_plane_namespaces: [],
      control_plane_is_single_tenant: true,
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

// A data plane's own id typed as client (`dp0001`, the last segment of
// `apim-dp-<cp>-<dp>`): refused, naming the data planes with that id, in the
// map or in Loki, and whose they are when the map says. Returns null when
// the phrase is no data plane's id.
export function resolveDataPlaneId({ phrase, namespaceValues, map }) {
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
  return null;
}

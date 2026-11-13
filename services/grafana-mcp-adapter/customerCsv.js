// The Gravitee Cloud customer map as it arrives: the CSV in
// cloud-deployments-configuration/docs/summary, read into the minimum needed to
// resolve a customer to its namespaces. Pure, no I/O, so it can be unit-tested
// directly.
import { controlPlaneOf, isTrialControlPlane, TRIAL_ID_PATTERN } from "./customerMatch.js";

// Minimal RFC4180-ish CSV reader. Needed because the URLs and Custom DNS columns
// are quoted lists that themselves contain commas — splitting on "," loses the
// column alignment and silently shifts every field after them. Each row comes
// with the line of the file it starts on (1 = the header), so a row that cannot
// be used can be pointed at. Blank lines are skipped.
function csvRows(text = "") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const src = String(text).replace(/\r\n/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push({ fields: row, line: rowLine });
      row = [];
      field = "";
      line++;
      rowLine = line;
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push({ fields: row, line: rowLine });
  }
  return rows.filter((r) => r.fields.some((v) => String(v).trim() !== ""));
}

export function parseCsv(text = "") {
  return csvRows(text).map((r) => r.fields);
}

// The deployment's environment is the prefix of its gravitee.io gateway host
// (`prod-org-acme...`). We keep only that derived word, never the hostnames
// themselves: customer DNS is not needed to resolve a namespace, and the parsed
// rows end up in the local snapshot file and in an image built with it.
export function extractEnv(urls = "") {
  for (const raw of String(urls).split(",")) {
    const host = raw.trim();
    const m = /^([a-z0-9-]+?)-org-.*\.gateway\.gravitee\.io$/i.exec(host);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// `trial-tt0001-dp0011` -> `trial-tt0001`, the identifier a trial is known by.
const TRIAL_ID_RE = new RegExp(`^(${TRIAL_ID_PATTERN})-`, "i");

// The columns the map is read from. Customer and the two ids build the
// namespaces; Region, Provider and URLs (where the environment is read) are
// what a qualifier such as `acme prod` narrows by. A CSV without one of them
// cannot be read as the map: every row would lack that field (without URLs,
// `acme prod` was refused as if acme had no prod).
export const REQUIRED_COLUMNS = ["Customer", "ControlPlaneId", "DataPlaneId", "Region", "Provider", "URLs"];

// A data plane id is what follows `apim-dp-` in a Kubernetes namespace name:
// lower-case letters and digits in dash-separated parts, at least two
// (`<control plane id>-<its own id>`). Anything else names no namespace, and
// could change the LogQL it is put in.
const DATA_PLANE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

// Why a row of the map cannot be used, or null when it can. One check for the
// rows read from the CSV here and for the rows of a snapshot
// (customerMapLoader.js). The control plane id must be the start of the data
// plane id: the lookups by id rely on it (controlPlaneOf), and it fails when a
// row's cells sit in the wrong columns. The reasons quote no cell, since a
// misplaced cell can hold a customer's hostname.
export function rowProblem(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "not a row";
  if (typeof row.customer !== "string" || !row.customer.trim()) return "no customer";
  if (typeof row.data_plane_id !== "string" || !row.data_plane_id) return "no data plane id";
  if (!DATA_PLANE_ID.test(row.data_plane_id)) {
    return "the data plane id is not lower-case letters and digits in dash-separated parts";
  }
  if (row.control_plane_id !== controlPlaneOf(row.data_plane_id)) {
    return "the control plane id is not the start of the data plane id";
  }
  for (const key of ["region", "provider", "env"]) {
    if (row[key] != null && typeof row[key] !== "string") return `the ${key} is not text`;
  }
  if (row.is_trial !== undefined && row.is_trial !== true) return "is_trial is not true";
  // A trial is one id: its customer, its control plane and the start of its
  // data planes. namespacesOf searches a trial's control plane as its own, so
  // a row has is_trial exactly when its control plane is a trial's.
  if (row.is_trial && !isTrialControlPlane(row.control_plane_id)) {
    return "is_trial is set, but the control plane id is not a trial's";
  }
  if (!row.is_trial && isTrialControlPlane(row.control_plane_id)) {
    return "the control plane id is a trial's, but is_trial is not set";
  }
  if (row.is_trial && row.customer !== row.control_plane_id) return "a trial's customer is not its control plane id";
  return null;
}

// One row the CSV could not give, for a warning or a script's output.
export const describeLeftOut = ({ line, customer, problem }) =>
  `line ${line}${customer ? `, ${customer}` : ""}: ${problem}`;

// Turn the CSV into the minimum needed to resolve a customer to namespaces.
// Returns the rows that can be used, and the ones left out, each with the line
// it starts on, its customer when the row has the header's number of fields,
// and why. Only blank lines are skipped without a word: a customer on a row left
// out resolves only partly, or not at all, and the caller says so. Throws when
// the CSV is empty or lacks a column the map is read from.
export function parseCustomerCsv(text = "") {
  const [head, ...body] = csvRows(text);
  if (!head) throw new Error("the customer CSV is empty");
  const header = head.fields.map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((name) => !header.includes(name));
  if (missing.length === REQUIRED_COLUMNS.length) {
    throw new Error("the customer CSV has none of the columns the map needs, so GRAFANA_CUSTOMER_MAP_PATH may name another file");
  }
  if (missing.length) {
    const names = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} or ${missing.at(-1)}` : missing[0];
    throw new Error(`the customer CSV has no ${names} column, which the map needs`);
  }
  const [iCustomer, iCp, iDp, iRegion, iProvider, iUrls] = REQUIRED_COLUMNS.map((name) => header.indexOf(name));

  const rows = [];
  const leftOut = [];
  for (const { fields, line } of body) {
    // An unquoted comma in a cell gives the row a field too many, and every
    // field after it lands in the wrong column. Nothing on such a row can be
    // trusted, its customer included.
    if (fields.length !== header.length) {
      leftOut.push({ line, problem: `${fields.length} fields where the header has ${header.length}` });
      continue;
    }
    const customer = fields[iCustomer].trim();
    // A Kubernetes namespace is lower case, so an id in capitals can only name
    // the lower-case one.
    const dataPlaneId = fields[iDp].trim().toLowerCase();

    // Trial tenants have no customer name at all — the CSV carries "N/A". They
    // are still findable, by the identifier they DO have, which is embedded in
    // the data plane id: `trial-tt0001-dp0011` belongs to trial `trial-tt0001`.
    // Dropping them would hide every trial from every tool.
    //
    // Their control plane id needs deriving too. The CSV's value is the literal
    // string "trial", which would build `apim-cp-trial`, but their namespaces
    // are `apim-cp-trial-<id>` and `apim-dp-<id>-<dp>`.
    const trial = TRIAL_ID_RE.exec(dataPlaneId);
    const isTrial = trial !== null || customer.toUpperCase() === "N/A";
    if (isTrial && !trial) {
      leftOut.push({ line, problem: "the customer is N/A and the data plane id names no trial" });
      continue;
    }
    const row = {
      customer: isTrial ? trial[1] : customer.toLowerCase(),
      control_plane_id: isTrial ? trial[1] : fields[iCp].trim().toLowerCase(),
      data_plane_id: dataPlaneId,
      region: fields[iRegion].trim() || null,
      provider: fields[iProvider].trim() || null,
      env: extractEnv(fields[iUrls]),
      ...(isTrial ? { is_trial: true } : {}),
    };
    const problem = rowProblem(row);
    if (problem) leftOut.push({ line, ...(row.customer ? { customer: row.customer } : {}), problem });
    else rows.push(row);
  }
  return { rows, leftOut };
}

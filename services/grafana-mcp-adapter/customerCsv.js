// The Gravitee Cloud customer map as it arrives: the CSV in
// cloud-deployments-configuration/docs/summary, read into the minimum needed to
// resolve a customer to its namespaces. Pure, no I/O, so it can be unit-tested
// directly.

// Minimal RFC4180-ish CSV reader. Needed because the URLs and Custom DNS columns
// are quoted lists that themselves contain commas — splitting on "," loses the
// column alignment and silently shifts every field after them.
export function parseCsv(text = "") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
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
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

// The deployment's environment is the prefix of its gravitee.io gateway host
// (`prod-org-acme...`). We keep only that derived word, never the hostnames
// themselves: the snapshot is committed to a repo, and customer DNS is not
// needed to resolve a namespace.
export function extractEnv(urls = "") {
  for (const raw of String(urls).split(",")) {
    const host = raw.trim();
    const m = /^([a-z0-9-]+?)-org-.*\.gateway\.gravitee\.io$/i.exec(host);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// `trial-tt0001-dp0011` -> `trial-tt0001`, the identifier a trial is known by.
const TRIAL_ID_RE = /^(trial-[0-9a-z]+)-/i;

// Turn the CSV into the minimum needed to resolve a customer to namespaces.
export function parseCustomerCsv(text = "") {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const iCustomer = idx("Customer");
  const iCp = idx("ControlPlaneId");
  const iDp = idx("DataPlaneId");
  const iRegion = idx("Region");
  const iProvider = idx("Provider");
  const iUrls = idx("URLs");
  if (iCustomer === -1 || iDp === -1) return [];

  const out = [];
  for (const r of rows.slice(1)) {
    const customer = (r[iCustomer] || "").trim();
    const dataPlaneId = (r[iDp] || "").trim();
    if (!dataPlaneId) continue;

    // Trial tenants have no customer name at all — the CSV carries "N/A". They
    // are still findable, by the identifier they DO have, which is embedded in
    // the data plane id: `trial-tt0001-dp0011` belongs to trial `trial-tt0001`.
    // Dropping them made a whole population invisible to every tool.
    //
    // Their control plane id needs deriving too. The CSV's value is the literal
    // string "trial", which would build `apim-cp-trial` — verified against Loki,
    // the real namespaces are `apim-cp-trial-<id>` and `apim-dp-<id>-<dp>`.
    const trial = TRIAL_ID_RE.exec(dataPlaneId);
    const isTrial = trial !== null || customer.toUpperCase() === "N/A";
    if (isTrial && !trial) continue; // no name and no trial id: genuinely unusable
    const slug = isTrial ? trial[1].toLowerCase() : customer.toLowerCase();
    if (!slug) continue;

    out.push({
      customer: slug,
      control_plane_id: isTrial ? trial[1] : (r[iCp] || "").trim(),
      data_plane_id: dataPlaneId,
      region: (r[iRegion] || "").trim() || null,
      provider: (r[iProvider] || "").trim() || null,
      env: iUrls === -1 ? null : extractEnv(r[iUrls]),
      ...(isTrial ? { is_trial: true } : {}),
    });
  }
  return out;
}

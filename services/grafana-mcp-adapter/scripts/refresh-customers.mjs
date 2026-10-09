// Regenerate the bundled customer snapshot used when GitHub is unreachable.
//
//   GITHUB_PERSONAL_ACCESS_TOKEN=... npm run refresh-customers
//
// The snapshot is deliberately slimmed to what is needed to resolve a customer to
// a namespace. Customer hostnames and custom DNS are NOT written to disk.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCustomerCsv } from "../customerMap.js";

const REPO = process.env.GRAFANA_CUSTOMER_MAP_REPO || "gravitee-io/cloud-deployments-configuration";
const PATH = process.env.GRAFANA_CUSTOMER_MAP_PATH || "docs/summary/customers_summary.csv";
const REF = process.env.GRAFANA_CUSTOMER_MAP_REF || "prod";

const token = (process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "").trim();
if (!token) {
  console.error("GITHUB_PERSONAL_ACCESS_TOKEN is required (the source repo is private).");
  process.exit(1);
}

const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}?ref=${encodeURIComponent(REF)}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw", "User-Agent": "refresh-customers" },
});
if (!res.ok) {
  console.error(`GitHub responded ${res.status} for ${REPO}/${PATH}@${REF}`);
  process.exit(1);
}

const customers = parseCustomerCsv(await res.text());
if (!customers.length) {
  console.error("Parsed zero customers - refusing to overwrite the snapshot with an empty file.");
  process.exit(1);
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "customers-snapshot.json");
await writeFile(
  out,
  JSON.stringify(
    {
      generated_at: new Date().toISOString().slice(0, 10),
      source: `${REPO}@${REF} ${PATH}`,
      note: "Slimmed deliberately: only what is needed to resolve a customer to a namespace. Customer hostnames and custom DNS are NOT included.",
      customers,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Wrote ${customers.length} deployments (${new Set(customers.map((c) => c.customer)).size} customers) to ${out}`);

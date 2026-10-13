// Regenerate the bundled customer snapshot used when GitHub is unreachable.
//
//   GITHUB_PERSONAL_ACCESS_TOKEN=... npm run refresh-customers
//
// The snapshot is deliberately slimmed to what is needed to resolve a customer to
// a namespace. Customer hostnames and custom DNS are NOT written to disk.
import { writeFile } from "node:fs/promises";
import { parseCustomerCsv } from "../customerCsv.js";
import { fetchCustomerCsv, fetchGeneratedAt, buildSnapshot, SNAPSHOT_PATH } from "../customerMapLoader.js";

const token = (process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "").trim();
if (!token) {
  console.error("GITHUB_PERSONAL_ACCESS_TOKEN is required (the source repo is private).");
  process.exit(1);
}

let csv;
try {
  csv = await fetchCustomerCsv();
} catch (err) {
  console.error(`Could not fetch the customer CSV: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const customers = parseCustomerCsv(csv);
if (!customers.length) {
  console.error("Parsed zero customers - refusing to overwrite the snapshot with an empty file.");
  process.exit(1);
}

// The CSV's own date, not today's: the fallback's freshness warning must say how
// old the data is, not when it was copied.
const sourceGeneratedAt = await fetchGeneratedAt(token);
if (!sourceGeneratedAt) {
  console.warn("Could not read when the CSV was last generated; the snapshot records its source date as unknown.");
}

await writeFile(SNAPSHOT_PATH, JSON.stringify(buildSnapshot({ customers, sourceGeneratedAt }), null, 2) + "\n");
console.log(
  `Wrote ${customers.length} deployments (${new Set(customers.map((c) => c.customer)).size} customers) to ${SNAPSHOT_PATH} ` +
    `(source CSV generated ${sourceGeneratedAt ? sourceGeneratedAt.slice(0, 10) : "unknown"})`,
);

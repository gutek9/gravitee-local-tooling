import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCsv, extractEnv, parseCustomerCsv } from "./customerCsv.js";
import { dataPlaneNamespace, controlPlaneNamespace } from "./customerMatch.js";

// A faithful slice of the real file, including the parts that break naive
// parsing: quoted URL lists containing commas, an N/A trial row, and a customer
// whose slug is a prefix of another's.
const CSV = `Customer,ControlPlaneId,DataPlaneId,Region,Provider,Cloud Region,Custom DNS,URLs
acme,cp1111,cp1111-dp0001,unitedstates,aws,us-east-1,"callback.acme.example, api.acme.example","api.acme.example, callback.acme.example, prod-org-acme.us-aws-us-east-1.gateway.gravitee.io"
acme,cp1111,cp1111-dp0002,unitedstates,aws,us-east-1,None,dev-org-acme.us-aws-us-east-1.gateway.gravitee.io
orbit,cp2222,cp2222-dp0004,europe,az,westeurope,None,dev-org-orbit.eu-az-westeurope.gateway.gravitee.io
orbitalis,cp2222,cp2222-999999,europe,az,westeurope,None,dev-org-orbitalis.eu-az-westeurope.gateway.gravitee.io
beacon,cp1111,cp1111-dp0003,unitedstates,aws,us-east-1,None,dev-org-beacon-1700000000000.us-aws-us-east-1.gateway.gravitee.io
N/A,trial,trial-tt0001-dp0011,apac,az,australiaeast,None,*.au.trial-tt0001.gateway.gravitee.io
`;

// ---------------------------------------------------------------------------
// parseCsv
// ---------------------------------------------------------------------------

test("parseCsv: a quoted field containing commas stays one field", () => {
  // The URLs column is a quoted comma-separated list. Splitting on "," would
  // shift every column after it, silently mis-assigning ids to customers.
  const rows = parseCsv('a,b,"c,d,e",f\n1,2,"3,4",5\n');
  assert.deepEqual(rows[0], ["a", "b", "c,d,e", "f"]);
  assert.deepEqual(rows[1], ["1", "2", "3,4", "5"]);
});

test("parseCsv: handles escaped quotes and blank lines", () => {
  const rows = parseCsv('a,"say ""hi""",c\n\n\nx,y,z\n');
  assert.deepEqual(rows[0], ["a", 'say "hi"', "c"]);
  assert.deepEqual(rows[1], ["x", "y", "z"]);
  assert.equal(rows.length, 2);
});

// ---------------------------------------------------------------------------
// extractEnv
// ---------------------------------------------------------------------------

test("extractEnv: reads the env from the gravitee gateway host", () => {
  assert.equal(extractEnv("prod-org-acme.us-aws-us-east-1.gateway.gravitee.io"), "prod");
  assert.equal(extractEnv("data-development-org-globex-1749828047293.eu-gcp-europe-west3.gateway.gravitee.io"), "data-development");
});

test("extractEnv: ignores custom DNS and picks the gravitee host from a list", () => {
  // Custom DNS entries sort first in the real file; the env only exists on the
  // gravitee.io host, so the customer's own domain must not be mistaken for it.
  assert.equal(
    extractEnv("api.acme.example, callback.acme.example, prod-org-acme.us-aws-us-east-1.gateway.gravitee.io"),
    "prod",
  );
  assert.equal(extractEnv("None"), null);
  assert.equal(extractEnv("*.au.trial-tt0001.gateway.gravitee.io"), null);
});

// ---------------------------------------------------------------------------
// parseCustomerCsv
// ---------------------------------------------------------------------------

test("parseCustomerCsv: extracts the ids needed to build a namespace", () => {
  const rows = parseCustomerCsv(CSV);
  const prod = rows.find((r) => r.customer === "acme" && r.env === "prod");
  assert.deepEqual(prod, {
    customer: "acme",
    control_plane_id: "cp1111",
    data_plane_id: "cp1111-dp0001",
    region: "unitedstates",
    provider: "aws",
    env: "prod",
  });
});

test("parseCustomerCsv: keeps no customer hostnames", () => {
  // The snapshot is committed to a repo. Resolving a namespace never needs a
  // customer's DNS, so none of it is carried.
  const serialised = JSON.stringify(parseCustomerCsv(CSV));
  assert.ok(!serialised.includes("acme.example"), "customer DNS must not be retained");
  assert.ok(!serialised.includes("gateway.gravitee.io"), "gateway hostnames must not be retained");
});

test("parseCustomerCsv: keeps trials, named by the id they actually have", () => {
  // The CSV has no customer for a trial ("N/A"). Dropping the row made a whole
  // population invisible; instead it is keyed by the trial identifier embedded in
  // the data plane id, which is what someone would search for.
  const trial = parseCustomerCsv(CSV).find((r) => r.is_trial);
  assert.equal(trial.customer, "trial-tt0001");
  assert.equal(trial.data_plane_id, "trial-tt0001-dp0011");
  // Verified against Loki: apim-cp-trial-<id> is the real namespace, so the CSV's
  // literal "trial" control plane id must not be carried through - it would build
  // `apim-cp-trial`, which does not exist.
  assert.equal(trial.control_plane_id, "trial-tt0001");
  assert.equal(controlPlaneNamespace(trial.control_plane_id), "apim-cp-trial-tt0001");
  assert.equal(dataPlaneNamespace(trial.data_plane_id), "apim-dp-trial-tt0001-dp0011");
});

test("parseCustomerCsv: tolerates junk instead of throwing", () => {
  assert.deepEqual(parseCustomerCsv(""), []);
  assert.deepEqual(parseCustomerCsv("nothing,useful\n1,2\n"), []);
});

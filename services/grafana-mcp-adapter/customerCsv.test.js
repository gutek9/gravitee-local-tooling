import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCsv, extractEnv, parseCustomerCsv, rowProblem, REQUIRED_COLUMNS } from "./customerCsv.js";
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
  const { rows, leftOut } = parseCustomerCsv(CSV);
  assert.deepEqual(leftOut, []);
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
  const trial = parseCustomerCsv(CSV).rows.find((r) => r.is_trial);
  assert.equal(trial.customer, "trial-tt0001");
  assert.equal(trial.data_plane_id, "trial-tt0001-dp0011");
  // Verified against Loki: apim-cp-trial-<id> is the real namespace, so the CSV's
  // literal "trial" control plane id must not be carried through - it would build
  // `apim-cp-trial`, which does not exist.
  assert.equal(trial.control_plane_id, "trial-tt0001");
  assert.equal(controlPlaneNamespace(trial.control_plane_id), "apim-cp-trial-tt0001");
  assert.equal(dataPlaneNamespace(trial.data_plane_id), "apim-dp-trial-tt0001-dp0011");
});

test("parseCustomerCsv: a CSV without a column the map is read from is refused, naming it", () => {
  // Regression (#9 review): only Customer and DataPlaneId were required. Without
  // URLs every row lost its environment and `acme prod` was refused as if acme
  // had no prod; without ControlPlaneId no control plane could be looked up.
  for (const column of REQUIRED_COLUMNS) {
    const renamed = CSV.replace(new RegExp(`(^|,)${column}(,|\\n)`), `$1Old ${column}$2`);
    assert.throws(() => parseCustomerCsv(renamed), { message: `the customer CSV has no ${column} column, which the map needs` });
  }
  assert.throws(() => parseCustomerCsv(CSV.replace("Customer,ControlPlaneId,DataPlaneId,Region", "Customer,Org,DataPlaneId,region")), {
    message: "the customer CSV has no ControlPlaneId or Region column, which the map needs",
  });
  assert.throws(() => parseCustomerCsv("nothing,useful\n1,2\n"), {
    message: "the customer CSV has none of the columns the map needs, so GRAFANA_CUSTOMER_MAP_PATH may name another file",
  });
  for (const empty of ["", "\n\n", " , \n"]) {
    assert.throws(() => parseCustomerCsv(empty), { message: "the customer CSV is empty" }, JSON.stringify(empty));
  }
});

test("parseCustomerCsv: the columns are read by name, in any order and next to others", () => {
  const reordered =
    "URLs,Notes,DataPlaneId,Provider,Customer,Region,ControlPlaneId\n" +
    "prod-org-acme.us-aws-us-east-1.gateway.gravitee.io,x,cp1111-dp0001,aws,acme,unitedstates,cp1111\n";
  assert.deepEqual(parseCustomerCsv(reordered), {
    rows: [parseCustomerCsv(CSV).rows.find((r) => r.data_plane_id === "cp1111-dp0001")],
    leftOut: [],
  });
});

// The real header, and rows built from cells so each case says what it changes.
const HEADER = "Customer,ControlPlaneId,DataPlaneId,Region,Provider,Cloud Region,Custom DNS,URLs";
const row = (customer, cp, dp, env = "prod") =>
  `${customer},${cp},${dp},europe,az,westeurope,None,${env}-org-${customer}.eu-az-westeurope.gateway.gravitee.io`;

test("parseCustomerCsv: a row with a field too many is left out whole, its customer not named", () => {
  // An unquoted comma in the Customer cell moves every later field one column
  // right: the data plane id read was the control plane's, and the search went
  // to a namespace that does not exist, reported as a stale map.
  const csv = [
    HEADER,
    row("acme", "cp1111", "cp1111-dp0001"),
    "globex, inc,cp2222,cp2222-dp0001,europe,az,westeurope,None,prod-org-globex.eu-az-westeurope.gateway.gravitee.io",
  ].join("\n");
  const { rows, leftOut } = parseCustomerCsv(csv);
  assert.deepEqual(rows.map((r) => r.customer), ["acme"]);
  assert.deepEqual(leftOut, [{ line: 3, problem: "9 fields where the header has 8" }]);
});

test("parseCustomerCsv: a row that names no namespace is left out with its line, never dropped silently", () => {
  // Regression (#9 review): odd ids reached the LogQL selector as they were (a
  // quote ended its string), and rows without an id or a name were dropped with
  // nothing said, so their customer looked absent from the map.
  const csv = [
    HEADER,
    row("acme", "cp1111", "cp1111-dp0001"),
    row("globex", "cp2222", '"cp2222-dp""1"'),
    row("globex", "cp2222", "cp2222 dp0002"),
    row("globex", "cp2222-dp0003", "cp2222"),
    row("globex", "cp9999", "cp2222-dp0004"),
    row("globex", "cp2222", ""),
    row("N/A", "trial", "cp2222-dp0009"),
    row("", "cp2222", "cp2222-dp0005"),
  ].join("\n");
  const { rows, leftOut } = parseCustomerCsv(csv);
  assert.deepEqual(rows.map((r) => r.data_plane_id), ["cp1111-dp0001"]);
  const notAnId = "the data plane id is not lower-case letters and digits in dash-separated parts";
  assert.deepEqual(leftOut, [
    { line: 3, customer: "globex", problem: notAnId },
    { line: 4, customer: "globex", problem: notAnId },
    { line: 5, customer: "globex", problem: notAnId },
    { line: 6, customer: "globex", problem: "the control plane id is not the start of the data plane id" },
    { line: 7, customer: "globex", problem: "no data plane id" },
    { line: 8, problem: "the customer is N/A and the data plane id names no trial" },
    { line: 9, problem: "no customer" },
  ]);
  // No cell is quoted back: a misplaced one can hold a customer's hostname.
  assert.doesNotMatch(JSON.stringify(leftOut), /dp"|dp0002|cp9999|dp0004|dp0009|dp0005/);
});

test("parseCustomerCsv: a line number counts every line of a quoted field that spans several", () => {
  const csv = [
    HEADER,
    'acme,cp1111,cp1111-dp0001,europe,az,westeurope,"a.example,\nb.example",prod-org-acme.eu-az-westeurope.gateway.gravitee.io',
    "",
    row("globex", "cp2222", "cp2222 dp0001"),
  ].join("\n");
  assert.deepEqual(parseCustomerCsv(csv).leftOut.map((r) => r.line), [5]);
});

test("parseCustomerCsv: an id in capitals names the lower-case namespace", () => {
  // A Kubernetes namespace is lower case, so CP1111-DP0001 can only be
  // apim-dp-cp1111-dp0001.
  const { rows, leftOut } = parseCustomerCsv([HEADER, row("acme", "CP1111", "CP1111-DP0001")].join("\n"));
  assert.deepEqual(leftOut, []);
  assert.deepEqual([rows[0].control_plane_id, rows[0].data_plane_id], ["cp1111", "cp1111-dp0001"]);
});

// ---------------------------------------------------------------------------
// rowProblem
// ---------------------------------------------------------------------------

test("rowProblem: every row parseCustomerCsv gives passes, so a snapshot refresh-customers writes loads", () => {
  for (const r of parseCustomerCsv(CSV).rows) assert.equal(rowProblem(r), null, JSON.stringify(r));
});

test("rowProblem: a snapshot row of the wrong shape is named by what is wrong", () => {
  const good = parseCustomerCsv(CSV).rows[0];
  const notAnId = "the data plane id is not lower-case letters and digits in dash-separated parts";
  for (const [r, problem] of [
    [null, "not a row"],
    [[good], "not a row"],
    ["acme", "not a row"],
    [{ ...good, customer: 42 }, "no customer"],
    [{ ...good, customer: " " }, "no customer"],
    [{ customer: "acme" }, "no data plane id"],
    [{ ...good, data_plane_id: 'cp1111-dp"1' }, notAnId],
    [{ ...good, data_plane_id: "CP1111-DP0001" }, notAnId],
    [{ ...good, data_plane_id: "cp1111" }, notAnId],
    [{ ...good, control_plane_id: "cp9999" }, "the control plane id is not the start of the data plane id"],
    [{ ...good, control_plane_id: undefined }, "the control plane id is not the start of the data plane id"],
    [{ ...good, region: 3 }, "the region is not text"],
    [{ ...good, env: {} }, "the env is not text"],
    [{ ...good, is_trial: "yes" }, "is_trial is not true"],
  ]) {
    assert.equal(rowProblem(r), problem, JSON.stringify(r));
  }
  // A field the map may lack (no region, no environment) is not a problem.
  assert.equal(rowProblem({ ...good, region: null, provider: undefined, env: null }), null);
});

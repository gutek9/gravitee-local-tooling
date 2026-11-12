import { test } from "node:test";
import assert from "node:assert/strict";

import { matchNamespaces, matchNamespacesAnySegment, matchNamespacesPhrase } from "./namespaceMatch.js";

// ---------------------------------------------------------------------------
// matchNamespaces
// ---------------------------------------------------------------------------

const NAMESPACES = [
  "prod",
  "nonprod",
  "kestrel-prod",
  "kestrel-rec",
  "orbit-plt-live",
  "orbit-multitenant",
  "vega-prod",
];

test("matchNamespaces: returns the customer's own namespaces", () => {
  assert.deepEqual(matchNamespaces(NAMESPACES, "kestrel"), ["kestrel-prod", "kestrel-rec"]);
  assert.deepEqual(matchNamespaces(NAMESPACES, "orbit"), ["orbit-plt-live", "orbit-multitenant"]);
});

test("matchNamespaces: customer with no dedicated namespace -> [] (fall back to service_name)", () => {
  // 'globex' lives only in the shared `prod`/`nonprod` namespaces.
  assert.deepEqual(matchNamespaces(NAMESPACES, "globex"), []);
});

test("matchNamespaces: empty core matches nothing (avoids matching every namespace)", () => {
  assert.deepEqual(matchNamespaces(NAMESPACES, ""), []);
  assert.deepEqual(matchNamespaces(NAMESPACES, "   "), []);
});

// ---------------------------------------------------------------------------
// Tiered namespace matching
// ---------------------------------------------------------------------------

const FLEET = [
  "acme-int", "acme-ppr", "acme-prod", "acme-rec", "acme-sandbox",
  "orbit-plt-live", "orbit-plt-live-ap", "orbit-plt-live-au", "orbit-multitenant",
  "beacon-management-prod1", "beacon-management-uat",
  "prod", "dev",
];

test("matchNamespaces: the whole name wins over its own siblings", () => {
  // Substring matching returned plt-live AND plt-live-ap/au for "orbit plt live".
  assert.deepEqual(matchNamespaces(FLEET, "orbit plt live"), ["orbit-plt-live"]);
  assert.deepEqual(matchNamespaces(FLEET, "beacon management uat"), ["beacon-management-uat"]);
});

test("matchNamespaces: a namespace that IS an environment word still resolves", () => {
  // Regression: a list of environment words classified the whole phrase as
  // environment, leaving no name.
  assert.deepEqual(matchNamespaces(FLEET, "prod"), ["prod"]);
  assert.deepEqual(matchNamespaces(FLEET, "dev"), ["dev"]);
});

test("matchNamespaces: a customer name alone returns their whole estate", () => {
  assert.deepEqual(matchNamespaces(FLEET, "acme"), ["acme-int", "acme-ppr", "acme-prod", "acme-rec", "acme-sandbox"]);
});

test("matchNamespaces: falls back to part of the first word, never of the others", () => {
  // "plt live ap" are whole segments; "multiten" is the first word, part of one.
  assert.deepEqual(matchNamespaces(FLEET, "orbit plt live ap"), ["orbit-plt-live-ap"]);
  assert.deepEqual(matchNamespaces(FLEET, "multiten"), ["orbit-multitenant"]);
  // "ultitenant" is only part of a segment and not the first word: no match.
  assert.deepEqual(matchNamespaces(FLEET, "orbit ultitenant"), []);
  assert.deepEqual(matchNamespaces(FLEET, "nosuchcustomer"), []);
  assert.deepEqual(matchNamespaces(FLEET, ""), []);
});

test("matchNamespaces: an environment word is never matched inside another word", () => {
  // Regression: "prod" matched inside nonprod and preprod, so "orbit prod"
  // searched both although orbit has no prod.
  assert.deepEqual(matchNamespaces(["orbit-nonprod", "orbit-preprod"], "orbit prod"), []);
  assert.deepEqual(matchNamespacesPhrase(["orbit-nonprod", "orbit-preprod"], "orbit prod"), {
    namespaces: ["orbit-nonprod", "orbit-preprod"],
    name: "orbit",
    tail: ["prod"],
    partial: false,
  });
  // Regression: "dev" matched inside another customer's name.
  assert.deepEqual(matchNamespacesPhrase(["zeta-prod", "zetadevtools-prod"], "zeta dev"), {
    namespaces: ["zeta-prod"],
    name: "zeta",
    tail: ["dev"],
    partial: false,
  });
});

test("matchNamespacesPhrase: every cut is tried exactly before any is tried partly", () => {
  // Regression: "acme" read as part of another customer's acmecorp-prod before
  // the exact acme-dev was found by dropping "prod".
  assert.deepEqual(matchNamespacesPhrase(["acme-dev", "acmecorp-prod"], "acme prod"), {
    namespaces: ["acme-dev"],
    name: "acme",
    tail: ["prod"],
    partial: false,
  });
});

test("matchNamespacesPhrase: a word after a namespace's first segment names only part of it", () => {
  // Regression: "nova" read zeta-nova-prod as an exact match, and "nova prod"
  // returned it instead of nova's own namespace.
  assert.deepEqual(matchNamespacesPhrase(["zeta-nova-prod", "zeta-prod"], "nova"), {
    namespaces: ["zeta-nova-prod"],
    name: "nova",
    tail: [],
    partial: true,
  });
  assert.deepEqual(matchNamespacesPhrase(["nova-dev", "zeta-nova-prod"], "nova prod"), {
    namespaces: ["nova-dev"],
    name: "nova",
    tail: ["prod"],
    partial: false,
  });
  // The owner first, then whole segments: exact, in one word or several.
  assert.deepEqual(matchNamespacesPhrase(["zeta-nova-prod", "zeta-prod"], "zeta nova"), {
    namespaces: ["zeta-nova-prod"],
    name: "zeta nova",
    tail: [],
    partial: false,
  });
  assert.deepEqual(matchNamespacesPhrase(["northstar-prod"], "north star prod").partial, false);
});

test("matchNamespacesAnySegment: for namespaces with no owner segment, any whole segment counts", () => {
  const cloud = ["apim-cp-cp1111", "apim-dp-cp1111-dp0001", "apim-dp-cp11112-dp0003"];
  assert.deepEqual(matchNamespacesAnySegment(cloud, "cp1111"), ["apim-cp-cp1111", "apim-dp-cp1111-dp0001"]);
  assert.deepEqual(matchNamespacesAnySegment(cloud, "dp0003"), ["apim-dp-cp11112-dp0003"]);
  // Only part of a segment when no whole one matches.
  assert.deepEqual(matchNamespacesAnySegment(cloud, "cp111"), cloud);
});

test("matchNamespaces: separators do not count", () => {
  const values = ["northstar-prod", "northwind-prod"];
  assert.deepEqual(matchNamespaces(values, "north star"), ["northstar-prod"]);
  assert.deepEqual(matchNamespaces(values, "north-star"), ["northstar-prod"]);
  assert.deepEqual(matchNamespaces(values, "north star prod"), ["northstar-prod"]);
  // Part of the first word, the rest whole segments.
  assert.deepEqual(matchNamespaces(["beaconlabs-prod"], "beaconl prod"), ["beaconlabs-prod"]);
  assert.deepEqual(matchNamespaces(["beaconlabs-prod"], "beaconl pro"), []);
});

test("matchNamespacesPhrase: drops the tail only when the whole phrase names nothing, and returns it", () => {
  assert.deepEqual(matchNamespacesPhrase(FLEET, "acme rec"), {
    namespaces: ["acme-rec"],
    name: "acme rec",
    tail: [],
    partial: false,
  });
  // "gatewaytesting" is a Cockpit environment: no hosted namespace has it, so the
  // tail comes back for the map to explain rather than being thrown away.
  assert.deepEqual(matchNamespacesPhrase(FLEET, "acme gatewaytesting"), {
    namespaces: ["acme-int", "acme-ppr", "acme-prod", "acme-rec", "acme-sandbox"],
    name: "acme",
    tail: ["gatewaytesting"],
    partial: false,
  });
  assert.deepEqual(matchNamespacesPhrase(FLEET, "nobody here"), {
    namespaces: [],
    name: "",
    tail: ["nobody", "here"],
    partial: false,
  });
  // Part of a name is said to be part of one.
  assert.deepEqual(matchNamespacesPhrase(FLEET, "multiten"), {
    namespaces: ["orbit-multitenant"],
    name: "multiten",
    tail: [],
    partial: true,
  });
});

// Which namespaces a client phrase names, matched against the Loki `namespace`
// label values: hosted customers get namespaces named after them. Pure: takes
// the label values, returns the matching ones, so it is tested without Loki.

// From the full list of `namespace` label values, pick the ones the phrase names.
//
// Tried in three tiers, most specific first — measured against every live hosted
// customer (296 namespaces), asking for each by its own name plus environment:
//
//   whole name   `orbit plt live` -> `orbit-plt-live`   exact 296
//   segments     every word is a whole `-` segment                exact 270
//   substring    every word appears anywhere                      exact 245
//
// The tiers matter because customers' names nest: `orbit-plt-live` is a
// prefix of `orbit-plt-live-ap`, and namespaces exist that are called just
// `prod` or `dev`. Substring alone returns the siblings too; whole-name first
// returns the one that was asked for, and falls through when the phrase names a
// customer rather than a deployment (`acme` -> all five of acme's namespaces).
//
// No environment word list is involved: the phrase is matched as typed, and what
// the caller meant by the last word is decided by what exists.
export function matchNamespaces(namespaceValues = [], phrase = "") {
  const words = String(phrase || "").toLowerCase().trim().split(/[\s-]+/).filter(Boolean);
  if (!words.length) return [];
  const values = [...new Set((namespaceValues || []).filter(Boolean))];

  const joined = words.join("-");
  const whole = values.filter((n) => n.toLowerCase() === joined);
  if (whole.length) return whole;

  const bySegment = values.filter((n) => {
    const segments = n.toLowerCase().split("-");
    return words.every((w) => segments.includes(w));
  });
  if (bySegment.length) return bySegment;

  return values.filter((n) => {
    const l = n.toLowerCase();
    return words.every((w) => l.includes(w));
  });
}

// The same, but allowed to give ground: if the whole phrase names nothing, drop
// one trailing word at a time. The dropped tail is returned rather than
// discarded — it is what the caller said about the deployment ("recette",
// "gatewaytesting"), and the customer map, not a word list, decides whether it
// means anything.
export function matchNamespacesPhrase(namespaceValues = [], phrase = "") {
  const words = String(phrase || "").trim().split(/\s+/).filter(Boolean);
  for (let n = words.length; n > 0; n--) {
    const namespaces = matchNamespaces(namespaceValues, words.slice(0, n).join(" "));
    if (namespaces.length) {
      return { namespaces, name: words.slice(0, n).join(" "), tail: words.slice(n) };
    }
  }
  return { namespaces: [], name: "", tail: words };
}

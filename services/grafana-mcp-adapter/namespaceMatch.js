// Which namespaces a client phrase names, matched against the Loki `namespace`
// label values: hosted customers get namespaces named after them. Pure: takes
// the label values, returns the matching ones, so it is tested without Loki.

// The words of a phrase or a namespace. Separators do not count, so "north
// star", "north-star" and "north_star" are the same two words.
const words = (text) => String(text || "").toLowerCase().split(/[\s_-]+/).filter(Boolean);

// Can these words be read as whole segments of a namespace? Each run of
// consecutive words, joined, must be one whole segment: "north star" reads
// `northstar-prod`, "orbit plt live" reads `orbit-plt-live-ap`. Never part of a
// segment, so "prod" does not read `nonprod`.
function readsAsSegments(phraseWords, segments) {
  const known = new Set(segments);
  // covered[i]: the first i words are whole segments.
  const covered = [true];
  for (let i = 1; i <= phraseWords.length; i++) {
    covered[i] = false;
    for (let j = 0; j < i && !covered[i]; j++) {
      covered[i] = covered[j] && known.has(phraseWords.slice(j, i).join(""));
    }
  }
  return covered[phraseWords.length];
}

const distinct = (namespaceValues) => [...new Set((namespaceValues || []).filter(Boolean))];

// The namespaces the phrase names exactly: the whole namespace, or else every
// word as whole segments of it. The whole name comes first because names nest:
// `orbit-plt-live` is a prefix of `orbit-plt-live-ap`, and namespaces exist that
// are called just `prod` or `dev`. Asking for one must not return its siblings;
// a customer name alone (`acme`) still returns all of that customer's namespaces.
function matchNamespacesExactly(namespaceValues, phrase) {
  const phraseWords = words(phrase);
  if (!phraseWords.length) return [];
  const values = distinct(namespaceValues);
  const joined = phraseWords.join("");
  const whole = values.filter((n) => words(n).join("") === joined);
  if (whole.length) return whole;
  return values.filter((n) => readsAsSegments(phraseWords, words(n)));
}

// Only for when nothing is named exactly: the first word may be part of a
// segment (`beaconl` -> `beaconlabs-prod`), but every other word must still be
// a whole one. Those words are what the caller said about the deployment, and
// reading them as parts of words is how "prod" found `nonprod` and "dev" found
// another customer's `zetadevtools`.
function matchNamespacesPartly(namespaceValues, phrase) {
  const [first, ...rest] = words(phrase);
  if (!first) return [];
  return distinct(namespaceValues).filter((n) => {
    const segments = words(n);
    return segments.some((s) => s.includes(first)) && readsAsSegments(rest, segments);
  });
}

// From the full list of `namespace` label values, pick the ones the phrase
// names: exactly if any, else partly.
//
// No environment word list is involved: the phrase is matched as typed, and what
// the caller meant by the last word is decided by what exists.
export function matchNamespaces(namespaceValues = [], phrase = "") {
  const exact = matchNamespacesExactly(namespaceValues, phrase);
  return exact.length ? exact : matchNamespacesPartly(namespaceValues, phrase);
}

// The same, but allowed to give ground: if the whole phrase names nothing, drop
// one trailing word at a time. The dropped tail is returned rather than
// discarded — it is what the caller said about the deployment ("recette",
// "gatewaytesting"), and the customer map, not a word list, decides whether it
// means anything.
//
// Every cut is tried exactly before any is tried partly. With `acme-dev` and
// another customer's `acmecorp-prod`, "acme prod" names acme exactly once
// "prod" is dropped; reading "acme" as part of `acmecorp` first would search
// the other customer's prod instead of saying acme has none. `partial` says
// which it was, so a caller can let a whole name elsewhere outrank it.
export function matchNamespacesPhrase(namespaceValues = [], phrase = "") {
  const all = String(phrase || "").trim().split(/\s+/).filter(Boolean);
  for (const match of [matchNamespacesExactly, matchNamespacesPartly]) {
    for (let n = all.length; n > 0; n--) {
      const name = all.slice(0, n).join(" ");
      const namespaces = match(namespaceValues, name);
      if (namespaces.length) {
        return { namespaces, name, tail: all.slice(n), partial: match === matchNamespacesPartly };
      }
    }
  }
  return { namespaces: [], name: "", tail: all, partial: false };
}

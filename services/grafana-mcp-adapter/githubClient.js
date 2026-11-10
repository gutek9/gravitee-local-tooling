// GitHub HTTP client: the one place the adapter calls the GitHub API.
//
// The adapter only reads from GitHub (the customer map CSV and its last commit
// date), but GITHUB_PERSONAL_ACCESS_TOKEN is shared with the GitHub MCP server
// and may carry write scopes. So reading is enforced here, not by convention at
// call sites: the only request this module can send is a GET to api.github.com.
//
// Each path segment is URL-encoded here, so a value cannot add a query or cut
// the URL short (a `#` in a file name would). An empty, "." or ".." segment is
// refused: encoding leaves ".." as it is, and the URL parser would resolve it
// to a different endpoint.
//
// Redirects are followed as fetch does: GitHub answers a renamed repository with
// a redirect on the same host. fetch drops Authorization when a redirect leaves
// the origin (checked on Node 20, the image's runtime), so the token does not
// follow a redirect to another host.

const BASE_URL = "https://api.github.com";

function encodeSegment(segment, segments) {
  const value = String(segment ?? "");
  if (value === "" || value === "." || value === "..") {
    throw new Error(
      `Refusing GitHub API path "${segments.join("/")}": empty, "." and ".." segments are not allowed`,
    );
  }
  return encodeURIComponent(value);
}

// GET `${BASE_URL}/<segments>?<params>` and return the body as text. Throws when
// the token is missing (before any request), on a non-2xx status, and when the
// request or its body takes longer than `timeoutMs`. Error messages carry the
// status only: never the token, never the response body.
export async function githubGet(segments, { params = {}, accept = "application/vnd.github+json", timeoutMs } = {}) {
  const path = segments.map((s) => encodeSegment(s, segments)).join("/");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    // setTimeout treats a missing delay as 0, which would abort every request
    // at once and look like GitHub being down.
    throw new Error("githubGet needs timeoutMs, a whole number of milliseconds");
  }
  const token = (process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("GITHUB_PERSONAL_ACCESS_TOKEN is not set");
  const search = new URLSearchParams(params);
  const url = `${BASE_URL}/${path}${search.size ? `?${search}` : ""}`;
  const controller = new AbortController();
  // Cleared only after the body is read, so a response that starts but never
  // finishes is bounded too.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: accept, "User-Agent": "grafana-mcp-adapter" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

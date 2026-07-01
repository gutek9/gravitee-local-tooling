# grafana-mcp-adapter

Read-only MCP server that exposes Grafana datasources and metric/log queries as
tools.

## Architecture

The adapter *is* the MCP server. Internally it calls the **Grafana HTTP API**
directly. MCP servers are
not chained to one another.

- Auth (required): this adapter needs a Grafana **service account** and its
  **token**, sent as a Bearer token in the `Authorization` header. The service
  account is provisioned by Gravitee personnel — request it via a change
  management request, scoped to a read-only role (Viewer). Put the token in
  `GRAFANA_TOKEN` in your `.env`.
- Most tools return **raw** payloads (e.g. datasource lists). The exception is
  the high-volume one: `grafana_query` returns a compact per-series digest by
  default (a full `up` query is ~8 MB of frames, far past what an MCP context
  wants); pass `raw=true` for the full frames. `grafana_logs_link` never returns
  log bodies at all — it discovers matching streams via Loki's `/series` (label
  sets only) and returns links plus those stream labels.
- Read-only by design. Note that `grafana_query` is a `POST` (Grafana's
  `/api/ds/query` is POST-shaped) but only **reads** metrics/logs.

## Tools

| Tool | Purpose |
| --- | --- |
| `grafana_health` | Config/connectivity check (makes one authenticated call). |
| `grafana_list_datasources` | List configured datasources (uid, name, type). |
| `grafana_query` | Run a PromQL/LogQL/etc. query against a datasource uid over a time range. Returns a per-series digest by default. |
| `grafana_logs_link` | Build a shareable Grafana logs link for a customer's logs. Discovers matching streams via Loki's `/series` (label sets only, no log lines) to scope the link. Defaults to Logs Drilldown links (per-namespace); pass `link_style="explore"` for a raw LogQL Explore link. |

### `grafana_query` response shape

The raw `/api/ds/query` response carries a full timestamp+value array per series,
and a query like `up` can return thousands of series (~8 MB). By default the tool
collapses each series to its labels + a numeric digest and caps the list:

```jsonc
{
  "results": {
    "A": {
      "status": 200,
      "series_count": 3085,        // total series before capping
      "series": [                  // capped to maxSeries (50)
        { "labels": { "job": "..." }, "count": 60, "first": 1, "last": 1, "min": 0, "max": 1, "avg": 0.98 }
      ],
      "truncated": 3035            // how many series were dropped from `series`
    }
  }
}
```

Pass `raw=true` to get the full (potentially very large) frames instead.

### `grafana_logs_link`

Identify a customer/component with free text (`client='april'`,
`component='gateway'`); it matches case-insensitively against the `service_name`
label, which on this instance encodes both (e.g.
`graviteeio-ae-april-rec-engine`). Returns `{ query, link_style,
resolved_namespaces, links, range, matched_count, matched_streams }`, where
`matched_streams` is the list of `{ namespace, service_name }` label sets the
selector matched (discovered via Loki's `/series` — no log lines are fetched) and
`resolved_namespaces` is the customer's own namespace(s) the `client` resolved to
(empty when the customer only lives in a shared namespace — see the drilldown
section). The default range is the last hour; widen with `from`/`to`. When nothing
matches, it returns close `service_name` values as `suggestions` so typos like
`aprl → april` surface.

Two conditional fields also appear:

- `env_filter_dropped: true` — set when the query pinned the customer's namespace,
  the `client` asked for an env (e.g. `prod`), the first `/series` discovery
  returned nothing, and dropping the env token and retrying *did* find streams.
  Env tokens aren't reliably in `service_name` for every tenant (some name prod
  `plt-live`/`multitenant`), so this flags that the reported streams are the
  customer's namespace-wide results, not env-narrowed ones.
- `suggestions` — close `service_name` values (see above), only when the `client`
  matched no namespace **and** no streams.

#### `link_style`: Logs Drilldown (default) vs Explore

`link_style` chooses the link format in `links`:

- **`drilldown`** (default) — links into Grafana's **Logs Drilldown** app (the
  "Logs" menu, plugin `grafana-lokiexplore-app`). This app navigates
  **per-namespace** (`/explore/namespace/{ns}/logs`), so `links` carries **one
  link per namespace** the query matched (a customer's logs can span several
  namespaces — e.g. `april-prod`, `april-rec`). Each link pins the namespace and
  adds a `service_name` filter built from the **exact** service names seen in
  that namespace (the app treats a raw LogQL regex value as a literal and matches
  nothing, so we use `=` for one value or a `=~` alternation for several),
  dropping you in already scoped so you can filter/drill (levels, fields,
  patterns) by hand in the UI.
- **`explore`** — a single raw **Explore** deep link carrying the LogQL `query`
  (Grafana 11+ `panes` form). Use this when you want the raw query view.

Each entry in `links` is `{ url }` (explore) or `{ namespace, service_names, url }`
(drilldown). The matching stream label sets are always returned in
`matched_streams` regardless of `link_style` — no log lines are fetched.

> **Multitenant note.** On the multitenant Cockpit instance the customer name is
> *not* in `service_name`/`namespace` (it uses a tenant id, e.g. `ba813`), so a
> free-text `client` won't find those tenants. Resolving customer → tenant id is
> a planned improvement; for now pass the tenant's namespace/id you were given.

#### Examples (how a user asks for it)

Just ask in plain language — the agent maps it to the `client` / `component` /
`from` / `to` / `line_filter` arguments for you.

> "Give me the last hour of API gateway logs for **Northwind**."
> → `{ "client": "northwind", "component": "gateway" }`

> "Show me the engine logs for **Contoso** over the last 6 hours."
> → `{ "client": "contoso", "component": "engine", "from": "now-6h" }`

> "Find the gateway errors for **Globex** in the last 3 hours."
> → `{ "client": "globex", "component": "gateway", "line_filter": "error", "from": "now-3h" }`

> "I need the UI logs for **Initech** during yesterday's incident between 10:00 and 11:00."
> → `{ "client": "initech", "component": "ui", "from": "<epoch ms 10:00>", "to": "<epoch ms 11:00>" }`

> "Give me the **production** gateway logs for **Northwind**."
> → `{ "client": "northwind prod", "component": "gateway" }`

(The environment — `prod`, `rec`, `dev` — isn't a separate argument: it lives
inside `service_name`, so just fold it into `client` as another word. Words are
matched as case-insensitive substrings with `.*` between them, so `northwind
prod` matches `…-northwind-prod-…`. Known environment words (`prod`, `rec`,
`dev`, `nonprod`, `preprod`, `qa`, `int`, `ppr`, `sandbox`, …) are anchored to a
whole `service_name` segment, so `prod` matches `…-prod-…` but **not** the
`prod` inside `nonprod`/`preprod`. Non-env words stay plain substrings, so a
partial customer name like `arcelor` still matches `arcelor-mittal`.)

Each call returns `links` — shareable Grafana links (Logs Drilldown per namespace
by default; see `link_style` above) — plus `matched_streams`, the
`{ namespace, service_name }` label sets the selector matched. No log lines are
fetched; open a link to read the logs in Grafana.

## Setup

This service ships as part of `ia-tooling`. It is **opt-in** and disabled by
default, so teams that don't use Grafana are unaffected.

To enable it, set the following in your `ia-tooling` `.env` (which is
git-ignored — never hardcode the token):

```bash
GRAFANA_ENABLED=true
GRAFANA_BASE_URL=https://your-grafana-host   # e.g. https://gravitee.grafana.net
GRAFANA_TOKEN=...                            # service account token (see Auth above)
```

Then build and start the stack as usual (`bin/local-tooling start`). Once
`GRAFANA_ENABLED=true`, `bin/local-tooling` exposes the `grafana` MCP server
automatically — it is added to your agent config (`.mcp.json` / Codex) just like
`zendesk` / `vectordb` / `github`, with no manual wiring. It only needs HTTPS
egress to the Grafana instance.

`GRAFANA_LOGS_DATASOURCE_UID` is optional; it defaults to `grafanacloud-logs`,
which is the Loki datasource uid on the Gravitee Grafana instance.

## Testing

Tests use Node's built-in runner — no extra framework. Run them with:

```bash
npm test          # node --test
npm run check     # syntax-check the source files
```

Coverage:

- `helpers.test.js` — the pure helpers (`helpers.js`).
- `grafanaClient.test.js` — the HTTP client (`grafanaClient.js`): config
  validation, auth headers, param handling.
- `server.test.js` — the `server.js` orchestration that talks to Loki, with
  `fetch` stubbed per Loki endpoint: `grafana_logs_link`'s namespace resolution,
  per-namespace drilldown grouping, the `explore_url` fallback, the env
  auto-retry, and the empty-result `note`/`suggestions` branches, plus
  `grafana_query`'s digest-vs-`raw` output. `server.js` only starts the stdio
  transport when run as the entrypoint, so tests import it and invoke the
  registered tool handlers directly (via the exported `tools` map).

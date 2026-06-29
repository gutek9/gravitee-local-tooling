# grafana-mcp-adapter

Read-only MCP server that exposes Grafana dashboards, datasources and metric/log
queries as tools, for use by skills in the TICKETS workspace.

This is a **private, standalone** adapter: its own git repo, its own `.env`. It is
**not** part of `ia-tooling` and does not depend on its stack — it only makes HTTPS
calls out to the Grafana HTTP API (`${GRAFANA_BASE_URL}/api`). It was scaffolded by
cloning the structure of `fathom-mcp-adapter`.

## Architecture

The adapter *is* the MCP server. Internally it calls the **Grafana HTTP API**
directly (just as the Fathom adapter calls Fathom's REST API). MCP servers are
not chained to one another.

- Auth: a Grafana **service account token** sent as a Bearer token in the
  `Authorization` header. Scope it to a read-only role (Viewer). Create the
  service account + token in Grafana → Administration → Service accounts.
- Most tools return **raw** payloads (dashboard JSON, datasource lists). The
  exceptions are the high-volume ones: `grafana_query` returns a compact
  per-series digest by default (a full `up` query is ~8 MB of frames, far past
  what an MCP context wants), and `grafana_logs_link` returns a capped preview.
  Both can be pushed back toward raw (`raw=true` / a higher `limit`).
- Read-only by design. Note that `grafana_query` is a `POST` (Grafana's
  `/api/ds/query` is POST-shaped) but only **reads** metrics/logs.

## Tools

| Tool | Purpose |
| --- | --- |
| `grafana_health` | Config/connectivity check (makes one authenticated call). |
| `grafana_search_dashboards` | Search dashboards by title substring and/or tags. |
| `grafana_get_dashboard` | Full dashboard JSON by `uid`. |
| `grafana_list_datasources` | List configured datasources (uid, name, type). |
| `grafana_query` | Run a PromQL/LogQL/etc. query against a datasource uid over a time range. Returns a per-series digest by default. |
| `grafana_logs_link` | Build a permanent Grafana Explore (Loki) deep link for a customer's logs and return a preview of recent lines. |

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
`graviteeio-ae-april-rec-engine`). Returns `{ query, explore_url, range,
preview_count, preview }` — paste `explore_url` (a permanent Grafana 11+ Explore
link) into the ticket. The default range is the last hour; widen with
`from`/`to`. When nothing matches, it returns close `service_name` values as
`suggestions` so typos like `aprl → april` surface.

#### Examples (how a user asks for it)

Just ask in plain language — the agent maps it to the `client` / `component` /
`from` / `to` / `line_filter` arguments for you.

> "Give me the last hour of API gateway logs for **Northwind**."
> → `{ "client": "northwind", "component": "gateway" }`

> "Show me the engine logs for **Contoso** over the last 6 hours."
> → `{ "client": "contoso", "component": "engine", "from": "now-6h" }`

> "Find the gateway errors for **Globex** in the last 3 hours, give me up to 200 lines."
> → `{ "client": "globex", "component": "gateway", "line_filter": "error", "from": "now-3h", "limit": 200 }`

> "I need the UI logs for **Initech** during yesterday's incident between 10:00 and 11:00."
> → `{ "client": "initech", "component": "ui", "from": "<epoch ms 10:00>", "to": "<epoch ms 11:00>" }`

> "Give me the **production** gateway logs for **Northwind**."
> → `{ "client": "northwind prod", "component": "gateway" }`

(The environment — `prod`, `rec`, `dev` — isn't a separate argument: it lives
inside `service_name`, so just fold it into `client` as another word. Both
`client` and `component` are matched as case-insensitive substrings with `.*`
between them, so `northwind prod` matches `…-northwind-prod-…`.)

Each call returns `explore_url` — paste it into the ticket as a permanent link —
plus a capped `preview` of the newest matching lines.

## Setup

```bash
npm install
cp .env.example .env   # then fill in GRAFANA_BASE_URL and GRAFANA_TOKEN
npm test
npm start              # speaks MCP over stdio
```

`GRAFANA_TOKEN` must come from `.env` (which is git-ignored) — never hardcode it.

## Wiring into the TICKETS MCP session

Build the image and add a `grafana` entry to the TICKETS `.mcp.json`, alongside
`fathom` / `zendesk` / `vectordb` / `github`. It only needs HTTPS egress.

```bash
docker build -t grafana-mcp-adapter .
```

```jsonc
// .mcp.json (TICKETS)
{
  "mcpServers": {
    "grafana": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "--env-file", "/ABSOLUTE/PATH/TO/.env", "grafana-mcp-adapter"]
    }
  }
}
```

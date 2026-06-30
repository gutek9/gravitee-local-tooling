from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path

from .files import atomic_write, backup_file
from .grafana import grafana_enabled
from .paths import ROOT
from .zendesk import zendesk_enabled

CODEX_MARKER_START = "# >>> local-tooling managed"
CODEX_MARKER_END = "# <<< local-tooling managed"
MANAGED_CODEX_SERVERS = {"vectordb", "github-mcp-server", "atlassian", "kapa", "zendesk"}

GITHUB_DISABLED_TOOLS = [
    "create_branch",
    "create_pull_request",
    "create_repository",
    "delete_file",
    "fork_repository",
    "issue_write",
    "merge_pull_request",
    "pull_request_review_write",
    "push_files",
    "request_copilot_review",
    "update_pull_request",
    "update_pull_request_branch",
    "assign_copilot_to_issue",
    "add_issue_comment",
    "add_comment_to_pending_review",
    "create_or_update_file",
]

ATLASSIAN_DISABLED_TOOLS = [
    "editJiraIssue",
    "createJiraIssue",
    "addCommentToJiraIssue",
    "transitionJiraIssue",
    "addWorklogToJiraIssue",
]


def local_tooling_command() -> str:
    return str(ROOT / "bin" / "local-tooling")


def parse_agents(value: str) -> list[str]:
    if value == "all":
        return ["codex", "cursor", "claude"]
    agents = [item.strip().lower() for item in value.split(",") if item.strip()]
    invalid = sorted(set(agents) - {"codex", "cursor", "claude"})
    if invalid:
        raise SystemExit(f"Unsupported agent(s): {', '.join(invalid)}")
    return agents


def env_path(env: dict[str, str], key: str, default: Path) -> Path:
    configured = env.get(key, "").strip()
    return Path(configured).expanduser() if configured else default.expanduser()


def codex_config_path(env: dict[str, str]) -> Path:
    return env_path(env, "CODEX_CONFIG", Path("~/.codex/config.toml"))


def cursor_config_path(env: dict[str, str]) -> Path:
    return env_path(env, "CURSOR_MCP_CONFIG", Path("~/.cursor/mcp.json"))


def claude_config_path(env: dict[str, str]) -> Path:
    if env.get("CLAUDE_MCP_CONFIG", "").strip():
        return Path(env["CLAUDE_MCP_CONFIG"]).expanduser()
    if sys.platform == "darwin":
        return Path("~/Library/Application Support/Claude/claude_desktop_config.json").expanduser()
    return Path("~/.config/Claude/claude_desktop_config.json").expanduser()


def toml_array(items: list[str]) -> str:
    return "[\n" + "".join(f'  "{item}",\n' for item in items) + "]"


def codex_block(env: dict[str, str] | None = None) -> str:
    cmd = local_tooling_command()
    zendesk_block = ""
    if env is not None and zendesk_enabled(env):
        zendesk_block = f"""

[mcp_servers.zendesk]
command = "{cmd}"
args = ["mcp", "zendesk"]
enabled = true
""".rstrip()
    grafana_block = ""
    if env is not None and grafana_enabled(env):
        grafana_block = f"""

[mcp_servers.grafana]
command = "{cmd}"
args = ["mcp", "grafana"]
enabled = true
""".rstrip()
    return f"""
{CODEX_MARKER_START}

[mcp_servers.vectordb]
command = "{cmd}"
args = ["mcp", "vectordb"]
enabled = true

[mcp_servers.github-mcp-server]
command = "{cmd}"
args = ["mcp", "github"]
disabled_tools = {toml_array(GITHUB_DISABLED_TOOLS)}
enabled = true

[mcp_servers.atlassian]
command = "{cmd}"
args = ["mcp", "atlassian"]
disabled_tools = {toml_array(ATLASSIAN_DISABLED_TOOLS)}
enabled = true

[mcp_servers.kapa]
command = "{cmd}"
args = ["mcp", "kapa"]
enabled = true
{zendesk_block}{grafana_block}

[mcp_servers.vectordb.tools.rag_health]
approval_mode = "approve"

[mcp_servers.vectordb.tools.rag_search]
approval_mode = "approve"

[mcp_servers.vectordb.tools.rag_prepare_task]
approval_mode = "approve"

[mcp_servers.vectordb.tools.rag_ingest]
approval_mode = "approve"

{CODEX_MARKER_END}
""".strip()


def remove_managed_codex_sections(text: str) -> str:
    """Remove legacy and previously managed MCP tables without touching other Codex settings."""
    header = re.compile(r"^\s*\[mcp_servers\.([^\]]+)\]\s*(?:#.*)?$")
    kept: list[str] = []
    skip = False
    for line in text.splitlines(keepends=True):
        match = header.match(line)
        if match:
            server = match.group(1).split(".", 1)[0]
            skip = server in MANAGED_CODEX_SERVERS
        if not skip:
            kept.append(line)
    return "".join(kept)


def patch_codex(env: dict[str, str]) -> Path:
    path = codex_config_path(env)
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    pattern = re.compile(
        rf"\n?{re.escape(CODEX_MARKER_START)}.*?{re.escape(CODEX_MARKER_END)}\n?",
        re.DOTALL,
    )
    cleaned = remove_managed_codex_sections(pattern.sub("\n", existing)).rstrip()
    updated = (cleaned + "\n\n" if cleaned else "") + codex_block(env) + "\n"
    if updated != existing:
        backup_file(path)
        atomic_write(path, updated)
    return path


def _mcp_server(payload: dict[str, object], name: str) -> dict[str, object]:
    servers = payload.get("mcp_servers")
    if not isinstance(servers, dict):
        return {}
    server = servers.get(name)
    return server if isinstance(server, dict) else {}


def _remote_url(args: object) -> str:
    if not isinstance(args, list):
        return ""
    for item in args:
        if isinstance(item, str) and item.startswith(("https://", "http://")):
            return item
    return ""


def _option_value(args: object, option: str) -> str:
    if not isinstance(args, list):
        return ""
    for index, item in enumerate(args[:-1]):
        if item == option and isinstance(args[index + 1], str):
            return args[index + 1]
    return ""


def legacy_codex_env(path: Path) -> dict[str, str]:
    """Extract supported connection settings from legacy Codex MCP tables."""
    if not path.exists():
        return {}
    try:
        payload = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise SystemExit(f"Cannot parse Codex config {path}: {exc}") from exc
    if not isinstance(payload, dict):
        return {}

    updates: dict[str, str] = {}
    github_env = _mcp_server(payload, "github-mcp-server").get("env")
    if isinstance(github_env, dict):
        token = github_env.get("GITHUB_PERSONAL_ACCESS_TOKEN")
        if isinstance(token, str) and token:
            updates["GITHUB_PERSONAL_ACCESS_TOKEN"] = token

    atlassian = _mcp_server(payload, "atlassian")
    atlassian_url = _remote_url(atlassian.get("args"))
    if atlassian_url:
        updates["ATLASSIAN_MCP_URL"] = atlassian_url
    atlassian_site = _option_value(atlassian.get("args"), "--resource")
    if atlassian_site:
        updates["ATLASSIAN_SITE_URL"] = atlassian_site

    kapa = _mcp_server(payload, "kapa")
    kapa_url = _remote_url(kapa.get("args"))
    if kapa_url:
        updates["KAPA_REMOTE_MCP_URL"] = kapa_url
    kapa_header = _option_value(kapa.get("args"), "--header")
    if kapa_header:
        updates["KAPA_REMOTE_MCP_AUTH_HEADER"] = kapa_header
    return updates


def merge_env_file(updates: dict[str, str]) -> list[str]:
    """Add missing MCP settings to .env while preserving existing user choices and comments."""
    existing = ENV_FILE.read_text(encoding="utf-8") if ENV_FILE.exists() else ""
    lines = existing.splitlines()
    present: set[str] = set()
    for line in lines:
        match = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if match and match.group(2).strip():
            present.add(match.group(1))

    missing = [key for key, value in updates.items() if value and key not in present]
    if not missing:
        return []
    suffix = "" if not existing or existing.endswith("\n") else "\n"
    updated = existing + suffix + "\n".join(f"{key}={updates[key]}" for key in missing) + "\n"
    if ENV_FILE.exists():
        backup_file(ENV_FILE)
    atomic_write(ENV_FILE, updated)
    return missing


def migrate_codex_mcp(env: dict[str, str]) -> tuple[Path, list[str]]:
    """Move legacy MCP connection settings to .env and replace their Codex tables."""
    path = codex_config_path(env)
    migrated_keys = merge_env_file(legacy_codex_env(path))
    return patch_codex(env), migrated_keys


def mcp_json(env: dict[str, str] | None = None) -> dict[str, object]:
    cmd = local_tooling_command()
    servers = {
        "vectordb": {"command": cmd, "args": ["mcp", "vectordb"]},
        "github-mcp-server": {
            "command": cmd,
            "args": ["mcp", "github"],
            "disabledTools": GITHUB_DISABLED_TOOLS,
        },
        "atlassian-mcp-server": {
            "command": cmd,
            "args": ["mcp", "atlassian"],
            "disabledTools": ATLASSIAN_DISABLED_TOOLS,
        },
        "kapa": {"command": cmd, "args": ["mcp", "kapa"]},
    }
    if env is not None and zendesk_enabled(env):
        servers["zendesk"] = {"command": cmd, "args": ["mcp", "zendesk"]}
    if env is not None and grafana_enabled(env):
        servers["grafana"] = {"command": cmd, "args": ["mcp", "grafana"]}
    return servers


def patch_json_mcp(path: Path, env: dict[str, str] | None = None) -> Path:
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Cannot parse JSON config {path}: {exc}") from exc
    else:
        payload = {}

    if not isinstance(payload, dict):
        raise SystemExit(f"Expected JSON object in {path}")

    servers = payload.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        raise SystemExit(f"Expected mcpServers object in {path}")

    servers.update(mcp_json(env))
    if env is not None and not zendesk_enabled(env):
        servers.pop("zendesk", None)
    if env is not None and not grafana_enabled(env):
        servers.pop("grafana", None)
    updated = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if updated != existing:
        backup_file(path)
        atomic_write(path, updated)
    return path


def configure_agents(agents: list[str], env: dict[str, str]) -> None:
    for agent in agents:
        if agent == "codex":
            path = patch_codex(env)
        elif agent == "cursor":
            path = patch_json_mcp(cursor_config_path(env), env)
        elif agent == "claude":
            path = patch_json_mcp(claude_config_path(env), env)
        else:
            raise AssertionError(agent)
        print(f"Configured {agent}: {path}")

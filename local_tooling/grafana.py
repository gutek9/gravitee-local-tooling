from __future__ import annotations

from .env import bool_env

GRAFANA_DISABLED_MESSAGE = (
    "Grafana is disabled. Set GRAFANA_ENABLED=true in .env and configure GRAFANA_* secrets."
)


def grafana_enabled(env: dict[str, str]) -> bool:
    return bool_env(env, "GRAFANA_ENABLED", False)


def require_grafana_enabled(env: dict[str, str]) -> None:
    if not grafana_enabled(env):
        raise SystemExit(GRAFANA_DISABLED_MESSAGE)


def grafana_base_url(env: dict[str, str]) -> str:
    return env.get("GRAFANA_BASE_URL", "").strip().rstrip("/")


def grafana_config_errors(env: dict[str, str]) -> list[str]:
    if not grafana_enabled(env):
        return []
    errors: list[str] = []
    base_url = grafana_base_url(env)
    if not base_url or "your-grafana-host" in base_url:
        errors.append("GRAFANA_BASE_URL must be set to the team's Grafana instance URL")
    if not env.get("GRAFANA_TOKEN", "").strip():
        errors.append("GRAFANA_TOKEN is required (service account token, sent as a Bearer token)")
    return errors


def require_grafana_config(env: dict[str, str]) -> None:
    require_grafana_enabled(env)
    errors = grafana_config_errors(env)
    if errors:
        raise SystemExit("Grafana configuration is invalid:\n- " + "\n- ".join(errors))

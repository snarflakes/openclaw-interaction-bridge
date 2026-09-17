# Changelog

## Unreleased

- Security-scan fix: approval secret moved from the `OPENCLAW_APPROVAL_SECRET` env var to plugin config (`approvalSecret`) — clears the `suspicious.env_credential_access` finding. Random-UUID-per-startup fallback preserved; snarling echo flow unchanged (verified: snarling.py never reads the env var, no snarling changes needed).
- Manifest: removed legacy `channelEnvVars` and obsolete env-var metadata.

## 1.6.6 (2026-09-17)

- README: corrected the bottom "Install from ClawHub" block (was `clawhub:@snarflakes/openclaw-interaction-bridge` — broken spec, contradicted the top section); removed the dead NOTIFICATION_POLICY.md link.

## 1.6.5 (2026-09-17)

- Fix: `before_agent_start` → `before_agent_run` (removed hook name; unblocks the ClawHub plugin inspector against current OpenClaw).

- Data kill switches: `environmentalEventsEnabled` and `presenceTarget=disabled` (route or fully disable environmental event processing).
- Notification feedback mapped to revealed / dismissed / timed_out states.
- Removed agent wake calls from the notification feedback path.
- Docs: data kill switches + notification delivery; README now documents the ClawHub install, update, and allowlist path (removed the stale clone-into-extensions instructions); corrected plugin entry id in the config example.
- Packaging: refreshed `openclaw.build` metadata (tested against 2026.9.1), added manifest category.

## 1.6.4

- OpenClaw 2.0 plugin runtime API compatibility and approval/notification callback delivery via `subagent.run`.
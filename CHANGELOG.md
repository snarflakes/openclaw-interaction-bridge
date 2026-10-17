# Changelog

## 1.8.0 (2026-10-17) — Gateway-native approvals (2026.10.2 port)

- **Breaking fix for OpenClaw 2026.10.2:** `request_user_approval` no longer uses the homegrown TaskFlow bridge (`api.runtime.taskFlow.fromToolContext` / `bindSession` no longer exist — the old flow silently failed with "TaskFlow not available"). The tool is now a Gateway-native plugin approval:
  - A `before_tool_call` hook returns `requireApproval` (allowedDecisions `[allow-once, deny]`, timeout from `pluginApprovalTimeoutMs`, default 120000). The Gateway blocks the tool call until a decision resolves; the tool's `execute()` only runs after `allow-once` and reports `approved: allow-once`.
  - The plugin registers a minimal `snarling` **channel plugin** (Gateway-native approval forwarding target). With `approvals.plugin { enabled: true, mode: "targets", targets: [{ channel: "snarling", to: "display" }] }` in openclaw.json, the Gateway forwards pending plugin approvals to the channel, which pushes the card to the display on port 5000 (`/approval/alert`, same shape as before: `request_id`, `message`, `timeout_seconds`, `secret`). The `request_id` is now the native approval id `plugin:<uuid>`.
  - `/approval-callback` (unchanged URL + `approvalSecret` body check) now resolves the NATIVE approval over the Gateway RPC via `openclaw/plugin-sdk/approval-gateway-runtime` (`approval.resolve`, kind `plugin`). **Owner config required** — see README "v1.8.0 native approvals setup".
  - Resolution feedback pushes a `type: "approval_resolved"` alert (with `request_id`) to the display so the card clears only after the decision; also fires from the hook's `onResolution` for decisions made on other surfaces (webchat /approve, Control UI, timeout).
- `send_notification` / `/notification-callback`: the optional TaskFlow feedback path was removed (it never worked on 2026.10.2 and always fell back to fire-and-forget); `/notification-callback` now records display-side feedback stats and acknowledges. Priority/duration behavior unchanged.
- Manifest: adds `channels: ["snarling"]` and `pluginApprovalTimeoutMs` config (default 120000, Gateway-capped at 600000).
- Reports: `reports/native-approvals-verify.md` — every SDK API verified with dist file:line evidence.

## 1.7.0 (2026-09-16)

- Security-scan fix: approval secret moved from the `OPENCLAW_APPROVAL_SECRET` env var to plugin config (`approvalSecret`) — clears the `suspicious.env_credential_access` finding. Random-UUID-per-startup fallback preserved; snarling echo flow unchanged (verified: snarling.py never reads the env var, no snarling changes needed).
- Manifest: removed legacy `channelEnvVars` and obsolete env-var metadata.
- Manifest category: `integrations` → `other` (valid on both the local-gateway and ClawHub registry taxonomies; the previous category blocked 2026.9.1 gateways from loading the plugin).

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
# native-approvals verify — APIs used by the v1.8.0 port

Branch: feature/native-approvals · Host verified against: openclaw 2026.10.2

Evidence key: `file:line` refers to the 2026.10.2 dist
(`/home/openpi/.npm-global/lib/node_modules/openclaw/...`).

## APIs verified in the 2026.10.2 dist

1. `before_tool_call` hook can return `requireApproval` with
   `onResolution(decision)`:
   - hook-runner-global-Jvv9WFUW.d.ts:590-609 (`PluginHookBeforeToolCallResult.requireApproval`
     — title, description, severity, timeoutMs, allowedDecisions, onResolution);
     resolution union `allow-once|allow-always|deny|timeout|cancelled`
     (`PluginApprovalResolutions`, hook-runner-global-Jvv9WFUW.d.ts:577-583).
   - hooks-YoifYPsl.mjs:843-865 (`runBeforeToolCall` merges `requireApproval`).
   - agent-tools.before-tool-call-DG_c7plZ.mjs:859-871
     (`notifyPluginApprovalResolution` invokes `onResolution`);
     :931-946 (`resolveDecision` maps disallowed/unknown decisions to
     `timeout` → `onResolution` fires for allow/deny/timeout).
   - `api.on(...)` = `registerTypedHook` (registry-854ZO8XT.mjs:904, :3000).
2. Gateway creates pending approval with `plugin:` id:
   - plugin-approval-OUOyi4b6.mjs:122 `manager.create(request, timeoutMs, `
     ``plugin:${randomUUID()}``)`.
3. Approval forwarding for channel targets (`approvals.plugin`):
   - server-aux-handlers-3gNFvgTg.mjs:543-547 (`pluginApprovalStrategy` reads
     `cfg.approvals?.plugin`), :1916
     (`forwardPluginApprovalRequest: execApprovalForwarder.handlePluginApprovalRequested`).
   - :352-379 `resolveForwardTargets` (mode "targets" uses
     `config.targets` entries).
   - :264-281 `shouldSkipForwardingFallback` — for `approvalKind === "plugin"`
     a target channel is skipped only when a per-channel reviewer policy
     exists (`cfg.approvals.plugin[channel]`) AND the channel capability lacks
     `supportsScopedPluginApprovalApprovers` (logic in
     approval-channel-policy-support-DWQOjoD0.mjs:3-5). We do NOT set
     `approvals.plugin.snarling`, so generic forwarding proceeds.
   - :654 `buildForwardedPluginPendingPayload` — falls back to
     `buildTypedPluginApprovalPendingReplyPayload` unless the channel defines
     `approvalCapability.render.plugin.buildPendingPayload`.
   - ChannelApprovalCapability surface:
     channel-core-lfZRnmWl.d.ts:3324-3399 (`render`, `outbound` send hooks).
4. Forwarded payload reaches the channel's outbound:
   - deliverToTargets → deliver = `sendDurableMessageBatchCore`
     (server-aux-handlers-3gNFvgTg.mjs:571-573, :398-402).
   - deliver-prepare-5rU1jeJQ.mjs:293-302 (`createChannelHandler` loads the
     channel plugin), :564-573 (`sendPayload` passes the full `ReplyPayload`
     including `channelData` to the plugin's `outbound.sendPayload`).
   - capabilities-CZr1Vdri.mjs:41-44 (`payloadRequiresDurablePayloadTransport`
     → true when the payload has `presentation`/`channelData`, which the typed
     pending payload does).
   - We set `render.plugin.buildPendingPayload`
     (buildTypedPluginApprovalPendingReplyPayload +
     channelData.snarling toolCallId binding) and `outbound.sendPayload` posts
     the card to http://localhost:5000/approval/alert.
5. Plugin-side resolution of a NATIVE approval:
   - `resolveApprovalOverGateway({ approvalKind: "plugin", approvalId,
     decision, cfg })` — exported SDK subpath
     `openclaw/plugin-sdk/approval-gateway-runtime` (package.json exports:577,
     dist/plugin-sdk/approval-gateway-runtime.d.ts:3);
     approval-gateway-resolver-D1Colrz2.mjs:11-79 — validates id format
     (`isWellFormedApprovalId`, `plugin:` prefix accepted), decision, then
     opens an operator-approvals Gateway client (
     operator-approvals-client-DR_uf87L.mjs:8-60, scopes
     `["operator.approvals"]`, approvalRuntime token for local loopback) and
     calls `approval.resolve { id, kind, decision }`.
   - Gateway method `approval.resolve` (approval-2REs-jFg.mjs:327) with
     kind "plugin" (pluginApprovalManager, :385-388); authorization via
     `canResolveOperatorApproval` (approval-request-authority-Ky-w53FL.mjs:141,
     operator-approval-authorization-BCjW3avN.mjs:13-16 — operator.approvals
     scope + internal approvalRuntime true on loopback).
   - Local loopback client described in
     operator-approval-runtime-token-qKRD1Cec.mjs:23-31 (reads the shared
     exec-approvals socket token and derives the approval runtime token) —
     works in-process for a native plugin.
6. Channel registration minimal surface:
   - registry-854ZO8XT.mjs:1808-1836 (`normalizeRegisteredChannelPlugin`
     requires id, non-empty valid `capabilities.chatTypes`,
     `config.listAccountIds`, `config.resolveAccount`; meta filled from
     defaults with warnings).
   - `api.registerChannel` exists on `OpenClawPluginApi`
     (channel-core-lfZRnmWl.d.ts:21340-21346).
   - Manifest `channels` field marks channel ownership
     (docs/plugins/sdk-channel-plugins.md §Package and manifest).
   - No `gateway.startAccount` → account start skipped without error
     (server-channels-BgDrrfZk.mjs:485-493).
7. Config surface:
   - schema-Bc7Xr5WK.mjs:1029-1039 documents `approvals.plugin.*`
     (enabled, mode, targets).
   - `DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120000`,
     `MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600000`
     (approval-types-DOLowId2.d.ts:176-177);
     plugin-approval-OUOyi4b6.mjs:46 `resolvePluginApprovalTimeoutMs` clamps.

## APIs assumed (documented fallbacks)

1. `approvals.plugin` reviewers are NOT configured for the snarling channel;
   display-button resolution is performed by our /approval-callback route via
   the operator-approvals client (guarded by the existing approvalSecret body
   check + `auth: "gateway"` transport). If an operator later adds
   `approvals.plugin.snarling...` reviewer config, the generic forwarding path
   would be skipped until the channel implements
   `supportsScopedPluginApprovalApprovers` (our capability intentionally does
   not declare it — we cannot enforce per-user reviewer lists on a shared
   display). Fallback in that case: route plugin approvals through the same
   channel with reviewer lists unset, or use Control UI approvals.
2. Snarling display: the resolution push uses `type: "approval_resolved"`
   with `request_id` on the same /approval/alert endpoint. If the display
   does not yet recognize `approval_resolved`, it will treat the push as an
   unknown-type notification (best-effort clear documented in the README
   setup section for the snarling side).

## Unverified risks

1. End-to-end forwarding was verified by code reading and a dry-run of the
   plugin entry + channel render/sendPayload paths; a live gateway restart
   with `approvals.plugin` configured is still required to prove delivery
   in production (forwarder logs `exec approvals:` errors in the gateway log
   if delivery fails).
2. `resolveApprovalOverGateway` timeout/connectivity: if the display presses
   a button after the approval expired, the route returns 404 and the card
   resolution push still fires — card clears, tool call was already timed
   out by the Gateway. Safe (fail closed).
3. If two `request_user_approval` calls pend simultaneously from different
   sessions, `handleHookResolution`'s sessionKey match is unique per session,
   but the display card ordering is display-managed; decisions posted by
   snarling carry the exact request_id, so cross-clearing is not possible
   from the button path. Only third-surface resolution (onResolution
   fallback) relies on the best-effort single-entry match.

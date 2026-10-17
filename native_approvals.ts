// native_approvals.ts — Gateway-native plugin approval flow for the OpenClaw
// Interaction Bridge (v1.8.0, OpenClaw 2026.10.2 pluginSdk).
//
// Replaces the old homegrown TaskFlow approval bridge, which no longer works on
// 2026.10.2 (api.runtime.taskFlow.fromToolContext / bindSession are gone).
//
// How it works:
// 1. A `before_tool_call` hook returns `requireApproval` when the tool is
//    `request_user_approval`. The Gateway creates a pending native approval
//    (id: `plugin:<uuid>`), blocks the tool call, and asks its approval
//    surfaces (docs/plugins/plugin-permission-requests).
// 2. The plugin registers a minimal `snarling` channel plugin
//    (api.registerChannel). With `approvals.plugin` configured with a
//    `snarling` target, the Gateway forwards the pending plugin approval to
//    the channel; our `render.plugin.buildPendingPayload` renderer produces
//    the typed pending payload including a `channelData.snarling` block with
//    the toolCallId↔approvalId binding, and `outbound.sendPayload` POSTs the
//    native approval card to the snarling display on
//    http://localhost:5000/approval/alert — same endpoint and shape as the
//    old push, so the display needs no changes.
// 3. When snarling presses A/B, it POSTs to the bridge's /approval-callback
//    route (approvalSecret body check preserved). The route first pushes the
//    resolution card-clear to the display, then resolves the NATIVE approval
//    over the Gateway RPC via `resolveApprovalOverGateway(... kind:"plugin",
//    decision)` from openclaw/plugin-sdk/approval-gateway-runtime. The
//    Gateway unblocks or denies the waiting tool call and also invokes the
//    hook's `onResolution` (which is a no-op here because the route already
//    pushed the clear; it still fires for decisions made on other surfaces).
// 4. The request_user_approval tool's execute() only runs after allow-once
//    and returns a text result reporting the decision.

import { buildTypedPluginApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";

const SNARLING_ALERT_URL = "http://localhost:5000/approval/alert";

// The Gateway caps plugin approval timeouts at 600000ms (10 min).
export const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120000;
export const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600000;

export function resolvePluginApprovalTimeoutMs(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
  return Math.min(Math.round(n), MAX_PLUGIN_APPROVAL_TIMEOUT_MS);
}

// Plugin-side approval statistics (mirrors the old approvalStats contract).
export const approvalStats = {
  requested: 0,
  approved: 0,
  rejected: 0,
  timedOut: 0,
  errored: 0,
  resolutionPushes: 0,
};

export type ApprovalResolution =
  | "allow-once"
  | "allow-always"
  | "deny"
  | "timeout"
  | "cancelled";

function resolutionLabel(decision: ApprovalResolution): string {
  switch (decision) {
    case "allow-once":
      return "approved (allow-once)";
    case "allow-always":
      return "approved (allow-always)";
    case "deny":
      return "denied";
    case "timeout":
      return "timed out";
    default:
      return "cancelled";
  }
}

function isApprovedResolution(decision: ApprovalResolution): boolean {
  return decision === "allow-once" || decision === "allow-always";
}

export interface SnarlingPushOptions {
  approvalSecret: string;
}

/** POST an alert payload to the snarling display (same endpoint as v1.7). */
export async function pushToSnarling(payload: Record<string, unknown>, opts: SnarlingPushOptions): Promise<boolean> {
  try {
    const response = await fetch(SNARLING_ALERT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, secret: opts.approvalSecret })
    });
    return response.ok;
  } catch (_e) {
    console.error(`[native-approvals] Could not reach snarling display: ${_e}`);
    approvalStats.errored++;
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Pending native approval registry (toolCallId -> approvalId binding) */
/* ------------------------------------------------------------------ */

interface PendingApprovalEntry {
  approvalId: string;
  toolCallId?: string | null;
  sessionKey?: string | null;
  action: string;
  createdAt: number;
}

const MAX_PENDING_ENTRY_AGE_MS = 30 * 60 * 1000; // 30 min — beyond any approval timeout
const pendingApprovals = new Map<string, PendingApprovalEntry>(); // key: toolCallId ?? approvalId

function prunePendingEntries() {
  const now = Date.now();
  for (const [key, entry] of pendingApprovals.entries()) {
    if (now - entry.createdAt > MAX_PENDING_ENTRY_AGE_MS) pendingApprovals.delete(key);
  }
}

/** Called by the channel renderer when a forwarded pending card is built. */
function recordPendingApproval(request: PluginApprovalRequest, action: string) {
  prunePendingEntries();
  const entry: PendingApprovalEntry = {
    approvalId: request.id,
    toolCallId: request.request?.toolCallId ?? null,
    sessionKey: request.request?.sessionKey ?? null,
    action,
    createdAt: Date.now()
  };
  if (entry.toolCallId) pendingApprovals.set(entry.toolCallId, entry);
  pendingApprovals.set(entry.approvalId, entry);
}

/** Drop the registry entry for an approval id (/approval-callback side). */
export function noteApprovalResolvedLocally(approvalId: string): void {
  for (const [key, entry] of pendingApprovals.entries()) {
    if (entry.approvalId === approvalId) pendingApprovals.delete(key);
  }
}

export function getPendingApprovalInfo(): Array<{ approvalId: string; toolCallId?: string | null; sessionKey?: string | null; action: string; ageSeconds: number }> {
  prunePendingEntries();
  const now = Date.now();
  const seen = new Set<PendingApprovalEntry>();
  const out: Array<{ approvalId: string; toolCallId?: string | null; sessionKey?: string | null; action: string; ageSeconds: number }> = [];
  for (const entry of pendingApprovals.values()) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push({
      approvalId: entry.approvalId,
      toolCallId: entry.toolCallId,
      sessionKey: entry.sessionKey,
      action: entry.action,
      ageSeconds: Math.round((now - entry.createdAt) / 1000)
    });
  }
  return out;
}

/** Push a resolution/clear notification for a resolved native approval card. */
export async function pushApprovalResolution(
  resolution: { requestId?: string | null; decision: ApprovalResolution },
  opts: SnarlingPushOptions
): Promise<boolean> {
  const decision = resolution.decision;
  const approved = isApprovedResolution(decision);
  if (approved) approvalStats.approved++;
  else if (decision === "deny") approvalStats.rejected++;
  else if (decision === "timeout") approvalStats.timedOut++;

  const requestId = resolution.requestId ?? "";
  const ok = await pushToSnarling({
    // Same /approval/alert endpoint as the legacy card; typed body so the
    // display can clear the card for this request_id.
    type: "approval_resolved",
    request_id: requestId || undefined,
    approved,
    decision: decision === "cancelled" ? "cancelled" : decision,
    message: requestId
      ? `Approval ${resolutionLabel(decision)}. (request: ${requestId})`
      : `Approval ${resolutionLabel(decision)}.`,
    priority: "normal",
    duration: 0
  }, opts);
  if (ok) approvalStats.resolutionPushes++;
  return ok;
}

/**
 * onResolution hook callback. Normally the display-button path resolves via
 * /approval-callback, which pushes the clear itself and drops the registry
 * entry; onResolution still fires for decisions made on other surfaces
 * (webchat /approve, Control UI, timeout).
 */
export async function handleHookResolution(
  decision: unknown,
  ctx: { toolCallId?: string | null; sessionKey?: string | null } | undefined,
  opts: SnarlingPushOptions
): Promise<void> {
  const d: ApprovalResolution = typeof decision === "string" ? (decision as ApprovalResolution) : "cancelled";
  console.info(`[native-approvals] approval resolution (hook): ${d}`);
  if (d === "cancelled") return; // cancelled = run/config issue, no card clear
  const matched = ctx
    ? (() => {
        const bounded = ctx.toolCallId ? pendingApprovals.get(ctx.toolCallId) : undefined;
        if (bounded) {
          for (const [key, entry] of pendingApprovals.entries()) if (entry === bounded) pendingApprovals.delete(key);
          return bounded;
        }
        if (ctx.sessionKey) {
          const entries = [...pendingApprovals.values()].filter((e, i, a) => a.indexOf(e) === i && e.sessionKey === ctx.sessionKey);
          if (entries.length === 1) {
            pendingApprovals.delete(entries[0].approvalId);
            if (entries[0].toolCallId) pendingApprovals.delete(entries[0].toolCallId as string);
            return entries[0];
          }
        }
        return null;
      })()
    : null;
  try {
    await pushApprovalResolution({ requestId: matched?.approvalId, decision: d }, opts);
  } catch (_e) { /* push errors already logged */ }
}

/* ------------------------------------------------------------------ */
/* requireApproval hook payload                                        */
/* ------------------------------------------------------------------ */

/**
 * Build the `requireApproval` result when the model calls
 * `request_user_approval`. The Gateway blocks the tool call, creates the
 * pending approval (id prefix `plugin:`), forwards it to configured
 * `approvals.plugin` targets, and resolves it via /approve, an approval
 * client, or our /approval-callback route → resolveApprovalOverGateway.
 *
 * Returns null when this hook does not want to gate the call (must be
 * transparent for every other tool).
 */
export function requireApprovalForRequestUserApproval(
  toolName: string | undefined,
  params: Record<string, unknown> | undefined,
  ctx: { toolCallId?: string | null; sessionKey?: string | null } | undefined,
  opts: SnarlingPushOptions & { pluginApprovalTimeoutMs: number }
) {
  if (toolName !== "request_user_approval") return null;
  const action = typeof params?.action === "string" ? params.action : "action";
  const message = typeof params?.message === "string" ? params.message : "";
  approvalStats.requested++;
  const toolCallId = ctx?.toolCallId ?? null;
  return {
    requireApproval: {
      title: action.slice(0, 80),
      description: message.slice(0, 512),
      severity: "warning" as const,
      allowedDecisions: ["allow-once", "deny"],
      timeoutMs: opts.pluginApprovalTimeoutMs,
      onResolution: (decision: unknown) => {
        try {
          void handleHookResolution(decision, { toolCallId, sessionKey: ctx?.sessionKey ?? null }, opts);
        } catch (_e) { /* resolution push errors are logged inside */ }
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* snarling channel plugin (Gateway-native approval forwarding target) */
/* ------------------------------------------------------------------ */

function makeOutboundDeliveryResult(messageId: string) {
  return {
    channel: "snarling" as const,
    messageId,
    timestamp: Date.now()
  };
}

function readPluginApprovalChannelData(payload: any): Record<string, any> | null {
  const data = payload?.channelData?.execApproval;
  return data && typeof data === "object" ? data : null;
}

/**
 * Minimal channel plugin surface for the snarling display. Registered via
 * `api.registerChannel(...)` so the Gateway can forward plugin approval
 * prompts to it through `approvals.plugin.targets`.
 *
 * Required surface (verified: dist/registry-854ZO8XT.mjs
 * normalizeRegisteredChannelPlugin): id, capabilities.chatTypes (non-empty,
 * valid chat types), config.listAccountIds + config.resolveAccount.
 * No gateway adapter → account start skips gracefully
 * (dist/server-channels-BgDrrfZk.mjs `startAccount` guard), which is what we
 * want: this channel is an approval/notice push target, not a conversation
 * transport.
 */
export function createSnarlingChannelPlugin(opts: () => SnarlingPushOptions) {
  return {
    id: "snarling",
    meta: {
      id: "snarling",
      label: "Snarling Display",
      selectionLabel: "Snarling display (local, port 5000)",
      docsPath: "/plugins/sdk-channel-plugins/approvals",
      blurb: "Local physical display + A/B button approval surface."
    },
    capabilities: {
      chatTypes: ["direct"]
    },
    config: {
      listAccountIds: (_cfg: unknown) => ["default"],
      resolveAccount: (_cfg: unknown, accountId?: string | null) => ({ accountId: accountId ?? "default" }),
      inspectAccount: () => ({
        enabled: true,
        configured: true,
        tokenStatus: "available"
      })
    },
    approvalCapability: {
      describePluginApprovalSetup: (params: { channel: string }) => {
        if (params.channel !== "snarling") return null;
        return "Set approvals.plugin { enabled: true, mode: \"targets\", targets: [{ channel: \"snarling\", to: \"display\" }] } in openclaw.json to forward plugin approval prompts to the Snarling display.";
      }
    },
    render: {
      plugin: {
        // The typed renderer gives us the richest view of the request: we
        // re-emit the Gateway's own typed pending payload and add a
        // `channelData.snarling` block binding the request to its toolCallId
        // so button presses can resolve the exact approval.
        buildPendingPayload: (params: { cfg: unknown; request: PluginApprovalRequest; target: unknown; nowMs: number }) => {
          const request = params.request;
          const action =
            typeof request.request?.toolName === "string" && request.request.toolName
              ? request.request.toolName
              : typeof request.request?.title === "string"
                ? request.request.title.slice(0, 80)
                : "request";
          recordPendingApproval(request, action);
          const base = buildTypedPluginApprovalPendingReplyPayload({
            request,
            nowMs: params.nowMs
          });
          return {
            ...base,
            channelData: {
              ...(base as any).channelData,
              snarling: {
                toolCallId: request.request?.toolCallId ?? null,
                sessionKey: request.request?.sessionKey ?? null,
                createdAtMs: request.createdAtMs,
                expiresAtMs: request.expiresAtMs
              }
            }
          };
        }
        // buildResolvedPayload: intentionally omitted — resolution feedback is
        // pushed directly (see pushApprovalResolution), and forwarded
        // resolved payloads are suppressed in outbound.normalizePayload.
      }
    },
    outbound: {
      deliveryMode: "direct" as const,
      textChunkLimit: 8000,
      // Suppress the Gateway's forwarded plugin "resolved" payloads: the
      // resolution push (route or hook onResolution) owns the card clear.
      normalizePayload: ({ payload }: { payload: any }) => {
        const data = readPluginApprovalChannelData(payload);
        if (data?.state === "resolved") return null;
        return payload;
      },
      // Durable payload transport: forwarded typed plugin approval payloads
      // (presentation + channelData) arrive here together with our
      // channelData.snarling binding.
      sendPayload: async (ctx: { text?: string; payload?: any }) => {
        const o = opts();
        const data = readPluginApprovalChannelData(ctx.payload);
        if (data?.approvalKind === "plugin" && data?.state === "pending") {
          const expiresAtMs = Number(ctx.payload?.channelData?.snarling?.expiresAtMs ?? 0);
          const timeoutSeconds = expiresAtMs
            ? Math.max(1, Math.round((expiresAtMs - Date.now()) / 1000))
            : Math.max(1, Math.round(resolvePluginApprovalTimeoutMs(undefined) / 1000));
          const ok = await pushToSnarling({
            request_id: String(data.approvalId),
            message: String(ctx.payload?.text ?? ctx.text ?? ""),
            timeout_seconds: timeoutSeconds,
            allowed_decisions: Array.isArray(data.allowedDecisions) ? data.allowedDecisions : ["allow-once", "deny"],
            sessionKey: ctx.payload?.channelData?.snarling?.sessionKey ?? undefined,
            approval_kind: "plugin"
          }, o);
          return makeOutboundDeliveryResult(ok ? `approval:${String(data.approvalId)}` : `${String(data.approvalId)}-push-failed`);
        }
        // Non-approval structured payload: fall back to a text notice.
        const ok = await pushToSnarling({
          type: "notification",
          message: String(ctx.payload?.text ?? ctx.text ?? ""),
          priority: "normal",
          duration: 0
        }, o);
        return makeOutboundDeliveryResult(ok ? `notif:${crypto.randomUUID()}` : "");
      },
      // Text-only delivery (e.g. forwarded approval expiry notices, or any
      // explicit send targeting the snarling channel).
      sendText: async (ctx: { text?: string }) => {
        const o = opts();
        const ok = await pushToSnarling({
          type: "notification",
          message: String(ctx.text ?? ""),
          priority: "normal",
          duration: 0
        }, o);
        return makeOutboundDeliveryResult(ok ? `text:${crypto.randomUUID()}` : "");
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Native resolution over the Gateway RPC                              */
/* ------------------------------------------------------------------ */

/**
 * Resolve a pending NATIVE plugin approval over the Gateway RPC
 * (approval.resolve, kind "plugin"). Called by the /approval-callback HTTP
 * route when a display button press arrives.
 *
 * Uses the supported SDK surface
 * openclaw/plugin-sdk/approval-gateway-runtime → resolveApprovalOverGateway
 * (dist/approval-gateway-resolver-D1Colrz2.mjs), which opens an
 * operator-approvals Gateway client and issues
 * `approval.resolve { id, kind: "plugin", decision }`.
 */
export async function resolveNativePluginApproval(
  cfg: any,
  approvalId: string,
  decision: "allow-once" | "allow-always" | "deny"
): Promise<{ applied: boolean; approval?: Record<string, unknown> }> {
  return (await (resolveApprovalOverGateway as (params: any) => Promise<any>)({
    cfg,
    approvalKind: "plugin",
    approvalId,
    decision,
    clientDisplayName: "snarling display approval"
  })) as unknown as { applied: boolean; approval?: Record<string, unknown> };
}

/**
 * Automatic approvals.transport setup (v1.8.0).
 *
 * Seeds the Gateway transport config `approvals.plugin` so a fresh install
 * works out of the box: the native approval forwarding target points at the
 * "snarling" channel this plugin registers.
 *
 * Idempotent and strictly non-destructive:
 * - if `approvals.plugin` exists at all (any shape), the user owns that config
 *   and this migration returns null (no changes);
 * - otherwise it merges `approvals.plugin` into the (possibly absent)
 *   `approvals` block, preserving any other keys already there.
 *
 * Registered via api.registerConfigMigration — the SDK runs these before the
 * plugin runtime loads, through the gateway's normal backup/verify config
 * write flow (docs/gateway/doctor/config-migrations.md).
 */
export function registerApprovalsConfigMigration(api: any): void {
  if (typeof api?.registerConfigMigration !== "function") return; // older hosts
  api.registerConfigMigration((config: Record<string, unknown> | undefined | null) => {
    const cfg = (config ?? {}) as Record<string, any>;
    const approvals = cfg.approvals;
    if (approvals && typeof approvals === "object" && approvals.plugin) return null;
    const seededPlugin = {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "snarling", to: "display" }]
    };
    const next = {
      ...cfg,
      approvals: { ...(approvals && typeof approvals === "object" ? approvals : {}), plugin: seededPlugin }
    };
    return {
      config: next,
      changes: [
        "openclaw-interaction-bridge-v2: seeded approvals.plugin targets with the registered snarling display channel (idempotent install setup; no existing approvals config was present)"
      ]
    };
  });
}

// ~/.openclaw/extensions/openclaw-interaction-bridge/index.ts
// OpenClaw Interaction Bridge Plugin (v1.8.0 — Gateway-native approvals)
// - Sends agent state updates directly to snarling (processing/speaking/idle)
// - Gateway-native approval flow: requireApproval hook + snarling channel
//   plugin + /approval-callback resolution over plugin.approval.resolve
// - Registers send_notification (unchanged) and environmental/routes

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import {
  approvalStats,
  createSnarlingChannelPlugin,
  getPendingApprovalInfo,
  noteApprovalResolvedLocally,
  pushApprovalResolution,
  requireApprovalForRequestUserApproval,
  resolveNativePluginApproval,
  resolvePluginApprovalTimeoutMs,
} from "./native_approvals";

// Notification feedback stats — display-side only on 2026.10.2+ (the old
// TaskFlow feedback path is gone; see approval_tool.ts header note).
const notificationStats = {
  revealed: 0,
  dismissed: 0,
  timedOut: 0,
  errored: 0,
};

const SNARLING_URL = "http://localhost:5000/state";
// Approval callback secret — config-driven (was OPENCLAW_APPROVAL_SECRET env var)
let APPROVAL_SECRET = crypto.randomUUID();
// Plugin approval timeout — config-driven (openclaw.plugin.json pluginApprovalTimeoutMs)
let PLUGIN_APPROVAL_TIMEOUT_MS = 120000; // overridden from pluginConfig below
// Session routing now handled by in-process SDK (enqueueSystemEvent + runHeartbeatOnce)
// Non-wake events are informational and will be picked up by next heartbeat
//
// presenceTarget config: routes presence events to a specific agent (default: 'main')
// Set via plugins.entries.openclaw-interaction-bridge-v2.config.presenceTarget
// Set to 'disabled' to disable event routing entirely
// environmentalEventsEnabled config: controls whether the /environmental-event route is registered
// Default: true. Set to false to completely disable environmental event processing.
let idleTimeout: ReturnType<typeof setTimeout> | null = null;
const PROCESSING_IDLE_DELAY_MS = 10000; // 10s — same as communicating, simple uniform timeout
const COMMUNICATING_IDLE_DELAY_MS = 10000; // 10s — reply is near-instant, shorter timeout
let lastState = ""; // Track last state sent to avoid duplicates
let lastPresenceSettledAt = 0; // Dedupe window for presence_settled wake

// Wake policy: wake agent for observation_report events
// The event type is always observation_report; trigger_reason distinguishes why:
//   "presence_settled" — human arrived and is stable
//   "scheduled" — periodic check (30m active / 2-4h inactive)
//   "startup" — first observation after boot
function shouldWakeAgent(eventType: string): boolean {
  return eventType === "observation_report" || eventType === "presence_settled";
}

// Track if HTTP route is registered (only register once)
let routeRegistered = false;

// Map OpenClaw agent states to snarling states
function mapToSnarlingState(status: string): string {
  switch (status) {
    case "processing":
    case "speaking":
      return "processing";
    case "idle":
      return "sleeping";
    default:
      return "sleeping";
  }
}

async function updateState(status: string, sessionId: string) {
  try {
    // Map to snarling state
    const isCommunicating = status === "speaking";
    const stateToSend = isCommunicating ? "communicating" : mapToSnarlingState(status);
    const idleDelay = isCommunicating ? COMMUNICATING_IDLE_DELAY_MS : PROCESSING_IDLE_DELAY_MS;
    console.info(`[interaction-bridge-v2] updateState: status=${status} stateToSend=${stateToSend} lastState=${lastState} sessionId=${sessionId} idleDelay=${idleDelay}ms`);

    // Only send if state changed (avoid flooding)
    if (stateToSend === lastState) {
      // State unchanged, just reset the idle timer
      if (idleTimeout) clearTimeout(idleTimeout);
      const idleDelay = isCommunicating ? COMMUNICATING_IDLE_DELAY_MS : PROCESSING_IDLE_DELAY_MS;
      idleTimeout = setTimeout(() => {
        lastState = "";
        void fetch(SNARLING_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: "sleeping", timestamp: Date.now() })
        });
        idleTimeout = null;
      }, idleDelay);
      return;
    }

    lastState = stateToSend;

    // Clear existing idle timer
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = null;

    void fetch(SNARLING_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: stateToSend, timestamp: Date.now() })
    });

    // Set idle timeout — after no new activity, go to sleeping
    if (status === "processing" || status === "speaking") {
      const idleDelay = isCommunicating ? COMMUNICATING_IDLE_DELAY_MS : PROCESSING_IDLE_DELAY_MS;
      idleTimeout = setTimeout(() => {
        lastState = "";
        void fetch(SNARLING_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: "sleeping", timestamp: Date.now() })
        });
        idleTimeout = null;
      }, idleDelay);
    }
  } catch (_e) {
    // Silent fail - snarling is optional
  }
}

function formatEnvironmentalEvent(event: any): string {
  // V1 event types — backwards compatible with current snarling
  if (event.type === 'presence_change') {
    let msg = event.present ? 'someone is now present' : 'nobody here';
    if (event.absent_duration) {
      msg += ` (absent for ${event.absent_duration})`;
    }
    return `Presence changed: ${msg}`;
  }
  // V1 presence_settled without trigger_reason — current snarling sends this
  if (event.type === 'presence_settled' && !event.trigger_reason) {
    let msg = 'presence settled';
    if (event.absent_duration) {
      msg += ` (absent for ${event.absent_duration} before return)`;
    }
    return `Presence settled: ${msg}`;
  }
  // V2 observation_report — unified event type from trigger scheduler
  // trigger_reason: "presence_settled" | "scheduled" | "startup"
  if (event.type === 'observation_report' || event.trigger_reason) {
    const reason = event.trigger_reason || 'presence_settled';
    let msg = `Observation report (${reason}).`;
    if (event.absent_duration && reason === 'presence_settled') {
      msg += ` Absent for ${event.absent_duration} before return.`;
    }
    if (event.world_state) {
      msg += ` World state: ${event.world_state.source_count} sources.`;
    }
    if (event.changes_since_last) {
      const changes = event.changes_since_last;
      if (changes.bootstrap) return `Observation report (${reason}): bootstrap, ${event.world_state.source_count} sources.`;
      if (changes.appeared) msg += ` New: ${Object.keys(changes.appeared).join(', ')}.`;
      if (changes.disappeared) msg += ` Gone: ${Object.keys(changes.disappeared).join(', ')}.`;
      if (changes.changed) msg += ` Changed: ${Object.keys(changes.changed).join(', ')}.`;
      if (!changes.appeared && !changes.disappeared && !changes.changed) msg += ' No changes.';
    }
    return msg;
  }
  return `Environmental event: ${JSON.stringify(event)}`;
}

export default definePluginEntry({
  id: "openclaw-interaction-bridge-v2",
  name: "OpenClaw Interaction Bridge",
  description: "Bridge OpenClaw agent state directly to snarling display via HTTP API",
  register(api: any) {
    // Approval callback secret — config-driven (was OPENCLAW_APPROVAL_SECRET env var)
    APPROVAL_SECRET = api.pluginConfig?.approvalSecret || crypto.randomUUID();

    // Plugin approval timeout — config-driven (defaults to 120000, Gateway caps at 600000)
    PLUGIN_APPROVAL_TIMEOUT_MS = resolvePluginApprovalTimeoutMs(api.pluginConfig?.pluginApprovalTimeoutMs);

    const snarlingPushOpts = () => ({ approvalSecret: APPROVAL_SECRET });

    // State monitoring hooks - track when agent is processing or speaking

    api.on("before_agent_run", (event: any) => {
      const sessionKey = event.sessionKey || event.ctx?.sessionKey || "unknown";
      updateState("processing", sessionKey);
    });

    // before_tool_call: processing state + the Gateway-native requireApproval
    // gate for request_user_approval (returns requireApproval for that tool
    // only; other tools pass through untouched).
    api.on("before_tool_call", (event: any, ctx: any) => {
      const sessionKey = event.sessionKey || event.ctx?.sessionKey || ctx?.sessionKey || "unknown";
      updateState("processing", sessionKey);
      const gate = requireApprovalForRequestUserApproval(
        event?.toolName,
        event?.params,
        { toolCallId: event?.toolCallId ?? ctx?.toolCallId ?? null, sessionKey },
        { approvalSecret: APPROVAL_SECRET, pluginApprovalTimeoutMs: PLUGIN_APPROVAL_TIMEOUT_MS }
      );
      if (gate) return gate;
      return undefined;
    });

    api.on("before_agent_reply", (event: any) => {
      const sessionKey = event.sessionKey || event.ctx?.sessionKey || "unknown";
      updateState("speaking", sessionKey);
    });

    api.on("agent_end", (event: any) => {
      // Agent finished its turn — go idle immediately
      lastState = "";
      void fetch(SNARLING_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "sleeping", timestamp: Date.now() })
      });
      if (idleTimeout) { clearTimeout(idleTimeout); idleTimeout = null; }
    });

    // Register the snarling channel plugin — the Gateway-native approval
    // forwarding target. With approvals.plugin { targets: [{ channel:
    // "snarling", to: "display" }] } the Gateway forwards pending plugin
    // approvals (created by the requireApproval hook above) to this
    // channel's outbound adapter, which POSTs the card to the display.
    try {
      api.registerChannel(createSnarlingChannelPlugin(snarlingPushOpts));
      console.info("[openclaw-interaction-bridge] Registered snarling channel plugin (native approval forwarding target)");
    } catch (err) {
      console.error(`[openclaw-interaction-bridge] Failed to register snarling channel plugin: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Register the approval tool — the deliberate ask-the-user tool.
    // The requireApproval gate in before_tool_call blocks the call until the
    // decision resolves; execute() therefore only runs after allow-once
    // (allowedDecisions are [allow-once, deny]) and just reports the result.
    api.registerTool((ctx: any) => {
      return {
        name: "request_user_approval",
        description: "Ask the user for a deliberate yes/no decision via the snarling display (physical A/B buttons). Do NOT call this for routine progress or informational updates — use send_notification instead for those. Fire-and-forget questions, status updates, and 'heads up' alerts do not need this tool. Use it when the action genuinely must not proceed without explicit user approval.",
        parameters: Type.Object({
          action: Type.String({ description: "The action requiring approval (e.g., 'delete_file', 'send_email')" }),
          message: Type.String({ description: "Human-readable message explaining what needs approval" })
        }),
        async execute(_toolCallId: string, _params: any) {
          // Reaching here means the Gateway native approval resolved with
          // allow-once (deny/timeout never execute the tool).
          return {
            content: [{
              type: "text",
              text: "approved: allow-once — user approved the action on the snarling display. Proceed with the action, then report the result. (The approval decision itself is final; you do not need to re-ask unless the approved action fails for a different reason.)"
            }]
          };
        }
      };
    }, { optional: true });

    // Register send_notification tool — with feedback tracking via TaskFlow
    api.registerTool((ctx: any) => {
      const sessionKey = ctx?.sessionKey;

      return {
        name: "send_notification",
        description: "Send a notification to the snarling display. Fire-and-forget — does not wait for user response. Use for informational alerts, reminders, or status updates that don't require a decision.",
        parameters: Type.Object({
          message: Type.String({ description: "The notification message to display" }),
          priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")], { description: "Priority level: low, normal (default), or high", default: "normal" })),
          duration: Type.Optional(Type.Number({ description: "Display duration in seconds (0 = use priority-based default: low=300s, others=no timeout)", default: 0 }))
        }),
        async execute(_toolCallId: string, params: any) {
          const { message, priority = "normal", duration = 0 } = params;

          // Fire-and-forget notification (no feedback; the TaskFlow
          // feedback path was removed with the 2026.10.2 API change)
          try {
            const response = await fetch("http://localhost:5000/approval/alert", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "notification",
                message,
                priority,
                duration,
                secret: APPROVAL_SECRET
              })
            });

            if (!response.ok) {
              return {
                content: [{ type: "text", text: `Notification sent but snarling returned HTTP ${response.status}` }]
              };
            }

            return {
              content: [{ type: "text", text: `Notification sent: "${message}" (priority: ${priority}, duration: ${duration}s)` }]
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send notification: ${error instanceof Error ? error.message : String(error)}` }]
            };
          }
        }
      };
    }, { optional: true });

    // Register approval callback route (exact match).
    // Resolves the NATIVE plugin approval (id `plugin:<uuid>`) via the
    // Gateway RPC (approval.resolve, kind "plugin"), preserving the
    // approvalSecret body check. Transport auth remains auth: "gateway".
    if (api.registerHttpRoute && !routeRegistered) {
      routeRegistered = true;

      api.registerHttpRoute({
        method: "POST",
        path: "/approval-callback",
        auth: "gateway",
        match: "exact",
        replaceExisting: true,
        handler: async (req: any, res: any) => {
          let body: any = {};
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) { chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk); }
            const raw = Buffer.concat(chunks).toString();
            body = JSON.parse(raw);
          } catch (_e) {
            console.warn(`[approval-callback] Failed to parse body: ${_e}`);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return true;
          }

          // Stats request: send {"action":"stats"} to /approval-callback
          if (body.action === 'stats') {
            res.statusCode = 200;
            res.end(JSON.stringify({ stats: { approvals: approvalStats, notifications: notificationStats }, pending: getPendingApprovalInfo() }));
            return true;
          }

          const { request_id, approved, secret } = body;

          if (!request_id) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing request_id" }));
            return true;
          }

          console.info(`[approval-callback] Received: request_id=${request_id}, approved=${approved}`);

          // Verify approval secret from request body (display → bridge auth)
          if (secret !== APPROVAL_SECRET) {
            console.warn(`[approval-callback] Invalid secret for request ${request_id}`);
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "Invalid or missing approval secret" }));
            return true;
          }

          // Native plugin approval ids are minted by the Gateway as `plugin:<uuid>`.
          const approvalId = typeof request_id === 'string' && request_id.startsWith('plugin:')
            ? request_id
            : null;
          if (approvalId === null) {
            // Legacy TaskFlow-era id (approval-<ts>-<rand>) from a stale card —
            // those approvals no longer exist in the gateway.
            console.warn(`[approval-callback] Rejecting non-native approval id ${request_id} (legacy TaskFlow-era card)`);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Unsupported approval id (expected native plugin approval id 'plugin:<id>')", request_id }));
            return true;
          }

          // A/B button semantics preserved: approved=true → allow-once, false → deny.
          const decision = approved === true ? "allow-once" : approved === false ? "deny" : null;
          if (decision === null) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "approved must be true or false", request_id }));
            return true;
          }

          // Drop the local pending-card binding for this approval — the
          // resolution push below clears the card on the display.
          noteApprovalResolvedLocally(approvalId);

          // Push the resolution card-clear FIRST so the card clears only
          // after the decision.
          try {
            await pushApprovalResolution(
              { requestId: approvalId, decision },
              { approvalSecret: APPROVAL_SECRET }
            );
          } catch (pushErr) {
            console.warn(`[approval-callback] Resolution push to display failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)} (continuing with gateway resolution)`);
          }

          // Resolve the native approval over the Gateway RPC. The waiting
          // tool call resumes (allow-once) or is denied — no manual session
          // wake needed.
          try {
            const result = await resolveNativePluginApproval(api.config, approvalId, decision as "allow-once" | "deny");
            res.statusCode = 200;
            res.end(JSON.stringify({
              status: "success",
              request_id,
              approved,
              decision,
              applied: result?.applied !== false
            }));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const notFound = /expired or not found|not found|approval(s)? expired/i.test(message);
            console.error(`[approval-callback] approval.resolve failed: ${message}`);
            res.statusCode = notFound ? 404 : 500;
            res.end(JSON.stringify({ error: notFound ? "Approval expired or not found" : "Failed to resolve approval over gateway", details: message, request_id }));
          }
          return true;
        }
      });

      console.info("[openclaw-interaction-bridge] Registered /approval-callback route (native plugin approval resolution)");

    // Register notification callback route (exact match).
    // v1.8.0: acknowledges display-side feedback; the old TaskFlow resume
    // path was removed (api.runtime.taskFlow no longer exists on 2026.10.2).
      api.registerHttpRoute({
        method: "POST",
        path: "/notification-callback",
        auth: "gateway",
        match: "exact",
        replaceExisting: true,
        handler: async (req: any, res: any) => {
          // Parse body from raw request
          let body: any = {};
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) { chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk); }
            const raw = Buffer.concat(chunks).toString();
            body = JSON.parse(raw);
          } catch (_e) {
            console.warn(`[notification-callback] Failed to parse body: ${_e}`);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return true;
          }

          // Stats request
          if (body.action === 'stats') {
            res.statusCode = 200;
            res.end(JSON.stringify({ stats: notificationStats }));
            return true;
          }

          const { notification_id, action, time_to_reveal_sec, secret, sessionKey: bodySessionKey } = body;

          // Map action-based format from snarling to revealed/dismissed/timed_out booleans
          let revealed = body.revealed ?? null;
          let dismissed = body.dismissed ?? null;
          let timed_out = body.timed_out ?? undefined;
          if (action) {
            if (action === 'accepted') { revealed = true; dismissed = false; timed_out = false; }
            else if (action === 'rejected') { revealed = true; dismissed = true; timed_out = false; }
            else if (action === 'timed_out') { revealed = false; dismissed = false; timed_out = true; }
          }

          if (!notification_id) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing notification_id" }));
            return true;
          }

          console.info(`[notification-callback] Received: notification_id=${notification_id}, action=${action ?? 'N/A'}, revealed=${revealed}, dismissed=${dismissed}`);

          // Verify secret
          if (secret !== APPROVAL_SECRET) {
            console.warn(`[notification-callback] Invalid secret for notification ${notification_id}`);
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "Invalid or missing approval secret" }));
            return true;
          }

          // Record display-side feedback stats (the agent-visible TaskFlow
          // path is gone; feedback is informational only).
          if (timed_out) notificationStats.timedOut++;
          else if (revealed) notificationStats.revealed++;
          else if (dismissed) notificationStats.dismissed++;
          else notificationStats.errored++;
          try {
            console.info(`[notification-callback] Feedback recorded (display-side only): notification_id=${notification_id}, sessionKey=${bodySessionKey || 'n/a'}`);
          } catch (_ignore) {}

          res.statusCode = 200;
          res.end(JSON.stringify({ status: "success", notification_id, recorded: "display-side" }));
          return true;
        }
      });

      console.info("[openclaw-interaction-bridge] Registered /notification-callback route");

      // Register environmental event route (exact match)
      // Only register if environmentalEventsEnabled is not explicitly false
      const envEventsEnabled = api.pluginConfig?.environmentalEventsEnabled !== false; // default true
      if (envEventsEnabled) {
      api.registerHttpRoute({
        method: "POST",
        path: "/environmental-event",
        auth: "gateway",
        match: "exact",
        replaceExisting: true,
        handler: async (req: any, res: any) => {
          // Parse body from raw request
          let body: any = {};
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) { chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk); }
            const raw = Buffer.concat(chunks).toString();
            body = JSON.parse(raw);
          } catch (_e) {
            console.info(`[environmental-event] Failed to parse body: ${_e}`);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return true;
          }

          // Auth is handled by gateway Bearer token (auth: "gateway" on this route).
          // No body.secret check needed — environmental events originate from snarling,
          // which authenticates via Authorization header. The body.secret pattern is
          // for callbacks where snarling received the secret from a prior tool call.

          console.info(`[environmental-event] Received: type=${body.type}, present=${body.present}, absent_duration=${body.absent_duration}`);

          // Check if environmental events are disabled via config
          const envEventsEnabledCheck = api.pluginConfig?.environmentalEventsEnabled !== false; // default true
          if (!envEventsEnabledCheck) {
            console.info(`[environmental-event] Environmental events disabled via config, skipping`);
            res.statusCode = 200;
            res.end(JSON.stringify({ status: "disabled", reason: "environmentalEventsEnabled=false" }));
            return true;
          }

          // Read presenceTarget from plugin config (default: 'main')
          // 'disabled' means don't route events to any agent
          const presenceTarget = api.pluginConfig?.presenceTarget || 'main';
          if (presenceTarget === 'disabled') {
            console.info(`[environmental-event] presenceTarget is 'disabled', acknowledging but not routing`);
            res.statusCode = 200;
            res.end(JSON.stringify({ status: "received", routedTo: "disabled" }));
            return true;
          }

          const eventText = formatEnvironmentalEvent(body);

          // Determine if this event type should trigger an immediate wake
          const shouldWake = shouldWakeAgent(body.type);
          const now = Date.now();
          const dedupeOk = shouldWake && (now - lastPresenceSettledAt > 5000);

          if (shouldWake && dedupeOk) {
            lastPresenceSettledAt = now;

            // Route based on presenceTarget config — use in-process SDK (no HTTP loopback, no CLI)
            const agentId = presenceTarget === 'main' ? 'main' : presenceTarget;
            const sessionKey = `agent:${agentId}:main`;

            console.info(`[environmental-event] Routing ${body.type} to agent '${agentId}' via in-process SDK (sessionKey=${sessionKey})`);

            // Send HTTP response FIRST — flush before waking agent
            res.statusCode = 200;
            res.end(JSON.stringify({ status: "received", routedTo: agentId }));

            // Enqueue the system event on the target session
            const systemApi = api.runtime?.system;
            if (systemApi?.enqueueSystemEvent) {
              const enqueued = systemApi.enqueueSystemEvent(eventText, {
                sessionKey,
                trusted: false,
              });
              console.info(`[environmental-event] enqueueSystemEvent result: ${enqueued} (sessionKey=${sessionKey})`);
            } else {
              console.warn(`[environmental-event] enqueueSystemEvent not available — event may not reach agent`);
            }

            // Wake the agent immediately via runHeartbeatOnce (fire-and-forget — don't await the full heartbeat cycle)
            // Small delay to avoid race condition: enqueueSystemEvent may not be fully committed
            // before runHeartbeatOnce checks the queue
            if (systemApi?.runHeartbeatOnce) {
              setTimeout(() => {
                systemApi.runHeartbeatOnce({
                  agentId,
                  sessionKey,
                  reason: "hook",
                  heartbeat: { target: "last" },
                }).then((wakeResult: any) => {
                  console.info(`[environmental-event] runHeartbeatOnce result: ${JSON.stringify(wakeResult)} (agentId=${agentId})`);
                }).catch((wakeErr: any) => {
                  console.warn(`[environmental-event] runHeartbeatOnce failed: ${wakeErr instanceof Error ? wakeErr.message : String(wakeErr)}`);
                });
              }, 300);
            } else {
              console.warn(`[environmental-event] runHeartbeatOnce not available — agent may not wake immediately`);
            }

            return true;
          }

          // Non-wake events: acknowledge but don't enqueue.
          // Agent will see these via next heartbeat if needed.
          console.info(`[environmental-event] Non-wake event ${body.type} acknowledged`);

          res.statusCode = 200;
          res.end(JSON.stringify({ status: "received" }));

          return true;
        }
      });

      console.info("[openclaw-interaction-bridge] Registered /environmental-event route");
      } else {
        console.info("[openclaw-interaction-bridge] Environmental events disabled via config, skipping /environmental-event route registration");
      }
    }
  }
});

// ~/.openclaw/extensions/openclaw-interaction-bridge/index.ts
// OpenClaw Interaction Bridge Plugin
// - Sends agent state updates directly to snarling (processing/speaking/idle)
// - Registers approval callback HTTP route for snarling button responses
// - Exposes /approval-callback and /approval/stats HTTP endpoints

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
// exec import removed — environmental-event handler now uses in-process SDK
import { requestUserApproval, resumeApprovalFlow, resumeNotificationFlow, sendNotificationWithFeedback, forceClearApprovalLock, approvalStats, notificationStats, cleanupOrphanedFlows, getPendingInfo } from "./approval_tool";

const SNARLING_URL = "http://localhost:5000/state";
const CALLBACK_BASE_URL = "http://localhost:18789";
const APPROVAL_SECRET = process.env.OPENCLAW_APPROVAL_SECRET || crypto.randomUUID();
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
    // State monitoring hooks - track when agent is processing or speaking
    // Also run periodic orphan TaskFlow cleanup on each agent start
    let lastOrphanCleanup = 0;
    const ORPHAN_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // Clean up every 30 minutes

    api.on("before_agent_start", (event: any) => {
      const sessionKey = event.sessionKey || event.ctx?.sessionKey || "unknown";
      updateState("processing", sessionKey);

      // Periodic orphan cleanup
      const now = Date.now();
      if (now - lastOrphanCleanup > ORPHAN_CLEANUP_INTERVAL_MS) {
        lastOrphanCleanup = now;
        const taskFlowApi = api.runtime?.taskFlow;
        if (taskFlowApi) {
          cleanupOrphanedFlows(taskFlowApi).then((result) => {
            if (result.cancelled > 0 || result.errors > 0 || result.details.length > 0) {
              console.info(`[approval-tool] Orphan cleanup: ${JSON.stringify(result)}`);
            }
          }).catch((err: any) => {
            console.warn(`[approval-tool] Orphan cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
    });

    api.on("before_tool_call", (event: any) => {
      const sessionKey = event.sessionKey || event.ctx?.sessionKey || "unknown";
      updateState("processing", sessionKey);
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

    // Register the approval tool using factory pattern
    // The factory function receives (ctx: OpenClawPluginToolContext) with sessionKey, sessionId, etc.
    // Plain tool objects do NOT receive ctx in execute — the 3rd arg is empty/undefined at runtime.
    api.registerTool((ctx: any) => {
      const sessionKey = ctx?.sessionKey;

      return {
        name: "request_user_approval",
        description: "Request user approval via snarling display. Creates a TaskFlow that waits for user response. Only one approval at a time.",
        parameters: Type.Object({
          action: Type.String({ description: "The action requiring approval (e.g., 'delete_file', 'send_email')" }),
          message: Type.String({ description: "Human-readable message explaining what needs approval" })
        }),
        async execute(_toolCallId: string, params: any) {
          const { action, message } = params;

          if (!sessionKey) {
            return {
              content: [{ type: "text", text: "Error: No sessionKey in tool context." }]
            };
          }

          // Get TaskFlow bound to this tool context
          let taskFlow: any = null;
          try {
            taskFlow = api.runtime?.taskFlow?.fromToolContext?.(ctx);
          } catch (e) {
            console.warn(`[approval-tool] fromToolContext failed: ${e instanceof Error ? e.message : String(e)}, falling back to bindSession`);
          }

          if (!taskFlow) {
            const taskFlowApi = api.runtime?.taskFlow;
            if (taskFlowApi?.bindSession) {
              console.info(`[approval-tool] Using bindSession with sessionKey=${sessionKey}`);
              taskFlow = taskFlowApi.bindSession({
                sessionKey,
                requesterOrigin: "openclaw-interaction-bridge/approval-tool"
              });
            }
          }

          if (!taskFlow) {
            return {
              content: [{
                type: "text",
                text: "Error: TaskFlow not available. This tool requires an active agent session."
              }]
            };
          }

          const callbackUrl = `${CALLBACK_BASE_URL}/approval-callback`;

          try {
            const result = await requestUserApproval({ action, message }, taskFlow, { callbackUrl, approvalSecret: APPROVAL_SECRET, sessionKey });
            return {
              content: [{ type: "text", text: result }]
            };
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Error requesting approval: ${error instanceof Error ? error.message : String(error)}`
              }]
            };
          }
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

          // Try TaskFlow-based notification with feedback
          if (sessionKey) {
            let taskFlow: any = null;
            try {
              taskFlow = api.runtime?.taskFlow?.fromToolContext?.(ctx);
            } catch (e) {
              console.warn(`[notification-tool] fromToolContext failed: ${e instanceof Error ? e.message : String(e)}, falling back to bindSession`);
            }

            if (!taskFlow) {
              const taskFlowApi = api.runtime?.taskFlow;
              if (taskFlowApi?.bindSession) {
                console.info(`[notification-tool] Using bindSession with sessionKey=${sessionKey}`);
                taskFlow = taskFlowApi.bindSession({
                  sessionKey,
                  requesterOrigin: "openclaw-interaction-bridge/notification-tool"
                });
              }
            }

            if (taskFlow) {
              const callbackUrl = `${CALLBACK_BASE_URL}/notification-callback`;
              try {
                const result = await sendNotificationWithFeedback({ message, priority, duration }, taskFlow, { callbackUrl, approvalSecret: APPROVAL_SECRET, sessionKey });
                return {
                  content: [{ type: "text", text: result }]
                };
              } catch (error) {
                // Fall through to fire-and-forget on TaskFlow error
                console.warn(`[notification-tool] TaskFlow notification failed, falling back to fire-and-forget: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }

          // Fallback: fire-and-forget notification (no feedback)
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

    // Register approval callback route (exact match)
    if (api.registerHttpRoute && !routeRegistered) {
      routeRegistered = true;

      api.registerHttpRoute({
        method: "POST",
        path: "/approval-callback",
        auth: "gateway",
        match: "exact",
        replaceExisting: true,
        handler: async (req: any, res: any) => {
          // Parse body from raw request first (needed for both stats and callback)
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
            res.end(JSON.stringify({ stats: approvalStats, pending: getPendingInfo() }));
            return true;
          }

          const { request_id, approved, secret } = body;

          if (!request_id) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing request_id" }));
            return true;
          }

          console.info(`[approval-callback] Received: request_id=${request_id}, approved=${approved}`);

          // Verify approval secret from request body
          const callbackSecret = secret;
          if (callbackSecret !== APPROVAL_SECRET) {
            console.warn(`[approval-callback] Invalid secret for request ${request_id} (got='${callbackSecret}', expected='${APPROVAL_SECRET}')`);
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "Invalid or missing approval secret" }));
            return true;
          }

          // Try sessionKey from body first (gateway strips query params), then URL params
          const bodySessionKey = body.sessionKey;
          const sessionKey = bodySessionKey || url.searchParams.get('sessionKey');
          if (!sessionKey) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing sessionKey parameter" }));
            return true;
          }
          console.info(`[approval-callback] Using sessionKey: ${sessionKey} (from body: ${!!bodySessionKey})`);

          // Bind TaskFlow to the main session for webhook context
          const taskFlowApi = api.runtime?.taskFlow;
          if (!taskFlowApi) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "TaskFlow API not available", request_id }));
            return true;
          }

          const boundTaskFlow = taskFlowApi.bindSession({
            sessionKey,
            requesterOrigin: "snarling-webhook"
          });

          // Get system API for waking the agent session
          const systemApi = api.runtime?.system;
          if (!systemApi?.enqueueSystemEvent) {
            console.warn(`[approval-callback] Warning: system API not available, agent may not wake up after approval`);
          }

          try {
            const result = await resumeApprovalFlow(
              request_id,
              approved === true,
              boundTaskFlow,
              // Pass minimal systemApi — just enqueueSystemEvent
              // Wake will happen AFTER HTTP response is sent
              { enqueueSystemEvent: systemApi?.enqueueSystemEvent?.bind(systemApi) ?? (() => {}), requestHeartbeatNow: () => {}, runHeartbeatOnce: undefined },
              sessionKey
            );

            // Safety net: always clear the lock after handling a callback
            forceClearApprovalLock(request_id);

            // Send HTTP response FIRST — must fully flush before attempting wake
            if (result.success) {
              res.statusCode = 200;
              res.end(JSON.stringify({ status: "success", request_id, approved, message: result.message }));
            } else {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: result.message, request_id }));
            }

            // Schedule wake on NEXT event loop tick to ensure HTTP response is fully flushed
            // and the session lane is no longer considered "in-flight"
            setImmediate(() => {
              try {
                const wakeReason = "hook:approval";
                if (systemApi?.requestHeartbeatNow) {
                  systemApi.requestHeartbeatNow({
                    reason: wakeReason,
                    sessionKey,
                    coalesceMs: 100
                  });
                }
                if (systemApi?.runHeartbeatOnce) {
                  systemApi.runHeartbeatOnce({
                    sessionKey,
                    reason: wakeReason,
                    heartbeat: { target: "last" }
                  }).catch(() => {});
                }
                // Second wake attempt after a short delay
                setTimeout(() => {
                  try {
                    systemApi.requestHeartbeatNow?.({
                      reason: wakeReason,
                      sessionKey,
                      coalesceMs: 0
                    });
                  } catch (_e) {}
                }, 500);
              } catch (_wakeErr) {
                // Wake best-effort
              }
            });
          } catch (error) {
            console.error(`[approval-callback] Error: ${error}`);
            forceClearApprovalLock(request_id);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Failed to resume TaskFlow", details: String(error), request_id }));
          }
          return true;
        }
      });

      console.info("[openclaw-interaction-bridge] Registered /approval-callback route (with ?stats=1 for tracker)");

      // Register notification callback route (exact match)
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

          const { notification_id, revealed, time_to_reveal_sec, dismissed, timed_out, secret, sessionKey: bodySessionKey } = body;

          if (!notification_id) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing notification_id" }));
            return true;
          }

          console.info(`[notification-callback] Received: notification_id=${notification_id}, revealed=${revealed}, dismissed=${dismissed}`);

          // Verify secret
          if (secret !== APPROVAL_SECRET) {
            console.warn(`[notification-callback] Invalid secret for notification ${notification_id}`);
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "Invalid or missing approval secret" }));
            return true;
          }

          // sessionKey from body, or fall back to URL query params
          const url = new URL(req.url || '/', `http://localhost`);
          const sessionKey = bodySessionKey || url.searchParams.get('sessionKey');
          if (!sessionKey) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing sessionKey parameter" }));
            return true;
          }
          console.info(`[notification-callback] Using sessionKey: ${sessionKey} (from body: ${!!bodySessionKey})`);

          // Bind TaskFlow to the session
          const taskFlowApi = api.runtime?.taskFlow;
          if (!taskFlowApi) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "TaskFlow API not available", notification_id }));
            return true;
          }

          const boundTaskFlow = taskFlowApi.bindSession({
            sessionKey,
            requesterOrigin: "snarling-webhook"
          });

          // Get system API for waking the agent session
          const systemApi = api.runtime?.system;
          if (!systemApi?.enqueueSystemEvent) {
            console.warn(`[notification-callback] Warning: system API not available, agent may not wake up after notification feedback`);
          }

          try {
            const result = await resumeNotificationFlow(
              notification_id,
              { revealed: revealed ?? null, time_to_reveal_sec: time_to_reveal_sec ?? null, dismissed: dismissed ?? null, timed_out: timed_out ?? undefined },
              boundTaskFlow,
              { enqueueSystemEvent: systemApi?.enqueueSystemEvent?.bind(systemApi) ?? (() => {}), requestHeartbeatNow: () => {}, runHeartbeatOnce: undefined },
              sessionKey
            );

            // Send HTTP response FIRST
            if (result.success) {
              res.statusCode = 200;
              res.end(JSON.stringify({ status: "success", notification_id, message: result.message }));
            } else {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: result.message, notification_id }));
            }

            // Schedule wake on NEXT event loop tick
            setImmediate(async () => {
              try {
                const wakeReason = "hook:notification_feedback";
                if (systemApi?.requestHeartbeatNow) {
                  systemApi.requestHeartbeatNow({
                    reason: wakeReason,
                    sessionKey,
                    coalesceMs: 100
                  });
                }
                if (systemApi?.runHeartbeatOnce) {
                  systemApi.runHeartbeatOnce({
                    sessionKey,
                    reason: wakeReason,
                    heartbeat: { target: "last" }
                  }).catch(() => {});
                }
                // Second wake attempt after a short delay
                setTimeout(() => {
                  try {
                    systemApi.requestHeartbeatNow?.({
                      reason: wakeReason,
                      sessionKey,
                      coalesceMs: 0
                    });
                  } catch (_e) {}
                }, 500);

                // Reliable fallback: POST to /hooks/wake to trigger heartbeat
                // Plugin runtime APIs may silently no-op, but /hooks/wake always enqueues + requests heartbeat
                try {
                  const hooksToken = process.env.OPENCLAW_HOOKS_TOKEN || "voicebridge-local-hooks-secret";
                  const hooksUrl = `http://127.0.0.1:${process.env.OPENCLAW_PORT || 18789}/hooks/wake`;
                  const http = await import("http");
                  const postData = JSON.stringify({ text: `Notification feedback received: ${notification_id}`, mode: "now" });
                  const wakeReq = http.request(hooksUrl, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "Authorization": `Bearer ${hooksToken}`,
                      "Content-Length": Buffer.byteLength(postData),
                    },
                    timeout: 3000,
                  }, (wakeRes: any) => {
                    let data = "";
                    wakeRes.on("data", (chunk: any) => { data += chunk; });
                    wakeRes.on("end", () => {
                      console.info(`[notification-callback] /hooks/wake fallback response: ${wakeRes.statusCode} ${data}`);
                    });
                  });
                  wakeReq.on("error", (e: any) => {
                    console.warn(`[notification-callback] /hooks/wake fallback failed: ${e.message}`);
                  });
                  wakeReq.write(postData);
                  wakeReq.end();
                } catch (_wakeFallbackErr) {
                  console.warn(`[notification-callback] /hooks/wake fallback error: ${_wakeFallbackErr}`);
                }
              } catch (_wakeErr) {
                // Wake best-effort
              }
            });
          } catch (error) {
            console.error(`[notification-callback] Error: ${error}`);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Failed to resume notification TaskFlow", details: String(error), notification_id }));
          }
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
          const envEventsEnabled = api.pluginConfig?.environmentalEventsEnabled !== false; // default true
          if (!envEventsEnabled) {
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
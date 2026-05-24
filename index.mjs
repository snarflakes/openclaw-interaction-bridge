// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";

// approval_tool.ts
var pendingApprovals = /* @__PURE__ */ new Map();
var pendingNotifications = /* @__PURE__ */ new Map();
var currentApprovalInProgress = null;
var currentApprovalStartedAt = null;
var APPROVAL_LOCK_TIMEOUT_MS = 30 * 60 * 1e3;
var approvalStats = {
  requested: 0,
  approved: 0,
  rejected: 0,
  timedOut: 0,
  errored: 0
};
var notificationStats = {
  sent: 0,
  revealed: 0,
  dismissed: 0,
  timedOut: 0,
  errored: 0
};
function clearStaleLock() {
  if (!currentApprovalInProgress) return false;
  const entry = pendingApprovals.get(currentApprovalInProgress);
  if (!entry) {
    console.error(`[approval-tool] Clearing orphaned lock: ${currentApprovalInProgress} (no matching pending entry)`);
    currentApprovalInProgress = null;
    currentApprovalStartedAt = null;
    return true;
  }
  const elapsed = Date.now() - (currentApprovalStartedAt ?? entry.createdAt);
  if (elapsed > APPROVAL_LOCK_TIMEOUT_MS) {
    console.error(`[approval-tool] Clearing stale lock: ${currentApprovalInProgress} (held for ${Math.round(elapsed / 6e4)}min, timeout=${APPROVAL_LOCK_TIMEOUT_MS / 6e4}min)`);
    approvalStats.timedOut++;
    pendingApprovals.delete(currentApprovalInProgress);
    currentApprovalInProgress = null;
    currentApprovalStartedAt = null;
    return true;
  }
  return false;
}
function forceClearApprovalLock(requestId) {
  if (requestId && currentApprovalInProgress !== requestId) {
    clearStaleLock();
    return;
  }
  if (requestId) {
    pendingApprovals.delete(requestId);
  }
  currentApprovalInProgress = null;
  currentApprovalStartedAt = null;
}
async function requestUserApproval(input, taskFlow, config) {
  const { action, message } = input;
  const { callbackUrl, approvalSecret, sessionKey } = config;
  clearStaleLock();
  if (currentApprovalInProgress) {
    const entry = pendingApprovals.get(currentApprovalInProgress);
    return `\u26A0\uFE0F Approval request blocked \u2014 another approval is already in progress (ID: ${currentApprovalInProgress}, started ${entry ? Math.round((Date.now() - entry.createdAt) / 6e4) + "min ago" : "recently"}). Respond to that one first.

Blocked action: ${action}`;
  }
  const requestId = `approval-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  if (!taskFlow) {
    throw new Error("TaskFlow API not available - cannot create approval flow");
  }
  const created = await taskFlow.createManaged({
    controllerId: "openclaw-interaction-bridge/approval",
    goal: `Request approval for: ${action}`,
    currentStep: "awaiting_user_approval",
    stateJson: {
      requestId,
      action,
      message,
      approved: null,
      respondedAt: null
    }
  });
  if (!created || !created.flowId) {
    const detail = created ? JSON.stringify(created) : "null result";
    throw new Error(`Failed to create approval TaskFlow: ${detail}`);
  }
  const flowId = created.flowId;
  const now = Date.now();
  pendingApprovals.set(requestId, { flowId, createdAt: now });
  currentApprovalInProgress = requestId;
  currentApprovalStartedAt = now;
  const waiting = await taskFlow.setWaiting({
    flowId,
    expectedRevision: created.revision,
    currentStep: "awaiting_user_approval",
    stateJson: {
      requestId,
      action,
      message,
      approved: null,
      respondedAt: null
    },
    waitJson: {
      kind: "user_approval",
      channel: "snarling",
      requestId,
      action,
      message
    }
  });
  if (!waiting || !waiting.applied) {
    pendingApprovals.delete(requestId);
    currentApprovalInProgress = null;
    currentApprovalStartedAt = null;
    const detail = waiting ? JSON.stringify(waiting) : "null result";
    throw new Error(`Failed to set approval flow to waiting: ${detail}`);
  }
  approvalStats.requested++;
  try {
    await fetch("http://localhost:5000/approval/alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        message: `${action}: ${message}`,
        secret: approvalSecret,
        sessionKey,
        timeout_seconds: 7200
      })
    });
  } catch (_e) {
    console.error(`[approval-tool] Could not notify snarling: ${_e}`);
    approvalStats.errored++;
  }
  console.error(`[approval-tool] Approval request sent, waiting for callback (request: ${requestId})`);
  return `\u23F3 Waiting for approval via Snarling display.

Action: ${action}
Details: ${message}
Request: ${requestId}`;
}
async function resumeApprovalFlow(requestId, approved, taskFlowApi, systemApi, sessionKey) {
  const entry = pendingApprovals.get(requestId);
  if (!entry) {
    if (currentApprovalInProgress === requestId) {
      console.error(`[approval-tool] Clearing lock for missing entry: ${requestId}`);
      currentApprovalInProgress = null;
      currentApprovalStartedAt = null;
    }
    return { success: false, message: `No pending approval found for request: ${requestId}` };
  }
  const flowId = entry.flowId;
  try {
    const getResult = await taskFlowApi.get(flowId);
    const flow = getResult?.flow ?? getResult;
    if (!flow || !flow.flowId) {
      pendingApprovals.delete(requestId);
      forceClearApprovalLock(requestId);
      return { success: false, message: `TaskFlow not found: ${flowId}` };
    }
    const resumed = await taskFlowApi.resume({
      flowId,
      expectedRevision: flow.revision,
      status: "running",
      currentStep: "approval_responded",
      stateJson: {
        ...flow.stateJson,
        approved,
        respondedAt: Date.now()
      }
    });
    if (!resumed || !resumed.applied) {
      pendingApprovals.delete(requestId);
      forceClearApprovalLock(requestId);
      return { success: false, message: `Failed to resume flow: ${resumed?.reason || "unknown error"}` };
    }
    const finished = await taskFlowApi.finish({
      flowId,
      expectedRevision: resumed.flow.revision,
      stateJson: {
        ...resumed.flow.stateJson,
        approved,
        respondedAt: Date.now()
      }
    });
    if (!finished || !finished.applied) {
      console.error(`[approval-tool] Warning: could not finish flow ${flowId}: ${finished?.reason || "unknown"}`);
    }
    const approvalResult = approved ? "APPROVED" : "REJECTED";
    if (approved) {
      approvalStats.approved++;
    } else {
      approvalStats.rejected++;
    }
    try {
      systemApi.enqueueSystemEvent(
        `User approval response: ${approvalResult}. ${approved ? "Proceeding with the action." : "Action cancelled by user."} (request: ${requestId})`,
        { sessionKey }
      );
    } catch (wakeErr) {
      console.error(`[approval-tool] Warning: failed to enqueue system event: ${wakeErr}`);
    }
    return { success: true, message: `Approval ${approved ? "APPROVED" : "REJECTED"} for ${requestId}` };
  } finally {
    pendingApprovals.delete(requestId);
    forceClearApprovalLock(requestId);
  }
}
async function sendNotificationWithFeedback(input, taskFlow, config) {
  const { message, priority = "normal", duration = 0 } = input;
  const { callbackUrl, approvalSecret, sessionKey } = config;
  const notificationId = `notify-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  if (!taskFlow) {
    throw new Error("TaskFlow API not available - cannot create notification flow");
  }
  const truncatedMessage = message.length > 50 ? message.substring(0, 50) + "..." : message;
  const created = await taskFlow.createManaged({
    controllerId: "openclaw-interaction-bridge/notification",
    goal: `Notification feedback: ${truncatedMessage}`,
    currentStep: "awaiting_user_interaction",
    stateJson: {
      notificationId,
      message,
      priority,
      revealed: null,
      dismissed: null,
      timeToRevealSec: null,
      timedOut: null
    }
  });
  if (!created || !created.flowId) {
    const detail = created ? JSON.stringify(created) : "null result";
    throw new Error(`Failed to create notification TaskFlow: ${detail}`);
  }
  const flowId = created.flowId;
  const now = Date.now();
  pendingNotifications.set(notificationId, { flowId, createdAt: now, sessionKey });
  const waiting = await taskFlow.setWaiting({
    flowId,
    expectedRevision: created.revision,
    currentStep: "awaiting_user_interaction",
    stateJson: {
      notificationId,
      message,
      priority,
      revealed: null,
      dismissed: null,
      timeToRevealSec: null,
      timedOut: null
    },
    waitJson: {
      kind: "notification_feedback",
      channel: "snarling",
      notificationId,
      message,
      priority
    }
  });
  if (!waiting || !waiting.applied) {
    pendingNotifications.delete(notificationId);
    const detail = waiting ? JSON.stringify(waiting) : "null result";
    throw new Error(`Failed to set notification flow to waiting: ${detail}`);
  }
  notificationStats.sent++;
  try {
    await fetch("http://localhost:5000/approval/alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "notification",
        notification_id: notificationId,
        message,
        priority,
        duration,
        secret: approvalSecret,
        callback_url: callbackUrl,
        sessionKey
      })
    });
  } catch (_e) {
    console.error(`[notification-tool] Could not notify snarling: ${_e}`);
    notificationStats.errored++;
  }
  console.error(`[notification-tool] Notification sent, waiting for feedback (id: ${notificationId})`);
  return `\u23F3 Notification sent, awaiting feedback.

Message: ${message}
Priority: ${priority}
ID: ${notificationId}`;
}
async function resumeNotificationFlow(notificationId, feedback, taskFlowApi, systemApi, sessionKey) {
  const entry = pendingNotifications.get(notificationId);
  if (!entry) {
    return { success: false, message: `No pending notification found for id: ${notificationId}` };
  }
  const flowId = entry.flowId;
  try {
    const getResult = await taskFlowApi.get(flowId);
    const flow = getResult?.flow ?? getResult;
    if (!flow || !flow.flowId) {
      pendingNotifications.delete(notificationId);
      return { success: false, message: `TaskFlow not found: ${flowId}` };
    }
    const resumed = await taskFlowApi.resume({
      flowId,
      expectedRevision: flow.revision,
      status: "running",
      currentStep: "notification_responded",
      stateJson: {
        ...flow.stateJson,
        revealed: feedback.revealed,
        timeToRevealSec: feedback.time_to_reveal_sec,
        dismissed: feedback.dismissed,
        timedOut: feedback.timed_out ?? false
      }
    });
    if (!resumed || !resumed.applied) {
      pendingNotifications.delete(notificationId);
      return { success: false, message: `Failed to resume flow: ${resumed?.reason || "unknown error"}` };
    }
    const finished = await taskFlowApi.finish({
      flowId,
      expectedRevision: resumed.flow.revision,
      stateJson: {
        ...resumed.flow.stateJson,
        revealed: feedback.revealed,
        timeToRevealSec: feedback.time_to_reveal_sec,
        dismissed: feedback.dismissed,
        timedOut: feedback.timed_out ?? false
      }
    });
    if (!finished || !finished.applied) {
      console.error(`[notification-tool] Warning: could not finish flow ${flowId}: ${finished?.reason || "unknown"}`);
    }
    if (feedback.timed_out) {
      notificationStats.timedOut++;
    } else if (feedback.revealed) {
      notificationStats.revealed++;
    } else if (feedback.dismissed) {
      notificationStats.dismissed++;
    }
    const timedOutStr = feedback.timed_out ? ", timed_out=true" : "";
    try {
      systemApi.enqueueSystemEvent(
        `Notification feedback: revealed=${feedback.revealed}, time_to_reveal_sec=${feedback.time_to_reveal_sec}, dismissed=${feedback.dismissed}${timedOutStr} (id: ${notificationId})`,
        { sessionKey }
      );
    } catch (wakeErr) {
      console.error(`[notification-tool] Warning: failed to enqueue system event: ${wakeErr}`);
    }
    return { success: true, message: `Notification feedback received for ${notificationId}` };
  } finally {
    pendingNotifications.delete(notificationId);
  }
}

// index.ts
var SNARLING_URL = "http://localhost:5000/state";
var CALLBACK_BASE_URL = "http://localhost:18789";
var APPROVAL_SECRET = process.env.OPENCLAW_APPROVAL_SECRET || crypto.randomUUID();
var idleTimeout = null;
var IDLE_DELAY_MS = 1e4;
var lastState = "";
var lastPresenceSettledAt = 0;
function shouldWakeAgent(eventType) {
  return eventType === "presence_settled";
}
var routeRegistered = false;
function mapToSnarlingState(status) {
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
async function updateState(status, sessionId) {
  try {
    const isCommunicating = status === "speaking";
    const stateToSend = isCommunicating ? "communicating" : mapToSnarlingState(status);
    if (stateToSend === lastState) {
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        lastState = "";
        void fetch(SNARLING_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: "sleeping", timestamp: Date.now() })
        });
        idleTimeout = null;
      }, IDLE_DELAY_MS);
      return;
    }
    lastState = stateToSend;
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = null;
    void fetch(SNARLING_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: stateToSend, timestamp: Date.now() })
    });
    if (status === "processing" || status === "speaking") {
      idleTimeout = setTimeout(() => {
        lastState = "";
        void fetch(SNARLING_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: "sleeping", timestamp: Date.now() })
        });
        idleTimeout = null;
      }, IDLE_DELAY_MS);
    }
  } catch (_e) {
  }
}
function formatEnvironmentalEvent(event) {
  if (event.type === "presence_change") {
    let msg = event.present ? "someone is now present" : "nobody here";
    if (event.absent_duration) {
      msg += ` (absent for ${event.absent_duration})`;
    }
    return `Presence changed: ${msg}`;
  }
  if (event.type === "presence_settled") {
    let msg = "presence settled";
    if (event.absent_duration) {
      msg += ` (absent for ${event.absent_duration} before return)`;
    }
    return `Presence settled: ${msg}`;
  }
  return `Environmental event: ${JSON.stringify(event)}`;
}
var index_default = definePluginEntry({
  id: "openclaw-interaction-bridge-v2",
  name: "OpenClaw Interaction Bridge",
  description: "Bridge OpenClaw agent state directly to snarling display via HTTP API",
  register(api) {
    api.on("before_tool_call", (event) => {
      const sessionKey = event.sessionKey || event.ctx?.sessionKey || "unknown";
      updateState("processing", sessionKey);
    });
    api.on("before_agent_reply", (event) => {
      const sessionKey = event.sessionKey || event.ctx?.sessionKey || "unknown";
      updateState("speaking", sessionKey);
    });
    api.on("agent_end", (event) => {
      lastState = "";
      void fetch(SNARLING_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "sleeping", timestamp: Date.now() })
      });
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
      }
    });
    api.registerTool((ctx) => {
      const sessionKey = ctx?.sessionKey;
      return {
        name: "request_user_approval",
        description: "Request user approval via snarling display. Creates a TaskFlow that waits for user response. Only one approval at a time.",
        parameters: Type.Object({
          action: Type.String({ description: "The action requiring approval (e.g., 'delete_file', 'send_email')" }),
          message: Type.String({ description: "Human-readable message explaining what needs approval" })
        }),
        async execute(_toolCallId, params) {
          const { action, message } = params;
          if (!sessionKey) {
            return {
              content: [{ type: "text", text: "Error: No sessionKey in tool context." }]
            };
          }
          let taskFlow = null;
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
    api.registerTool((ctx) => {
      const sessionKey = ctx?.sessionKey;
      return {
        name: "send_notification",
        description: "Send a notification to the snarling display. Fire-and-forget \u2014 does not wait for user response. Use for informational alerts, reminders, or status updates that don't require a decision.",
        parameters: Type.Object({
          message: Type.String({ description: "The notification message to display" }),
          priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")], { description: "Priority level: low, normal (default), or high", default: "normal" })),
          duration: Type.Optional(Type.Number({ description: "Display duration in seconds (0 = use priority-based default: low=300s, others=no timeout)", default: 0 }))
        }),
        async execute(_toolCallId, params) {
          const { message, priority = "normal", duration = 0 } = params;
          if (sessionKey) {
            let taskFlow = null;
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
                console.warn(`[notification-tool] TaskFlow notification failed, falling back to fire-and-forget: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
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
    if (api.registerHttpRoute && !routeRegistered) {
      routeRegistered = true;
      api.registerHttpRoute({
        method: "POST",
        path: "/approval-callback",
        auth: "gateway",
        match: "exact",
        replaceExisting: true,
        handler: async (req, res) => {
          let body = {};
          try {
            const chunks = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            }
            const raw = Buffer.concat(chunks).toString();
            body = JSON.parse(raw);
          } catch (_e) {
            console.warn(`[approval-callback] Failed to parse body: ${_e}`);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return true;
          }
          if (body.action === "stats") {
            res.statusCode = 200;
            res.end(JSON.stringify({ stats: approvalStats }));
            return true;
          }
          const { request_id, approved, secret } = body;
          if (!request_id) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing request_id" }));
            return true;
          }
          console.info(`[approval-callback] Received: request_id=${request_id}, approved=${approved}`);
          const callbackSecret = secret;
          if (callbackSecret !== APPROVAL_SECRET) {
            console.warn(`[approval-callback] Invalid secret for request ${request_id} (got='${callbackSecret}', expected='${APPROVAL_SECRET}')`);
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "Invalid or missing approval secret" }));
            return true;
          }
          const bodySessionKey = body.sessionKey;
          const sessionKey = bodySessionKey || url.searchParams.get("sessionKey");
          if (!sessionKey) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing sessionKey parameter" }));
            return true;
          }
          console.info(`[approval-callback] Using sessionKey: ${sessionKey} (from body: ${!!bodySessionKey})`);
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
              { enqueueSystemEvent: systemApi?.enqueueSystemEvent?.bind(systemApi) ?? (() => {
              }), requestHeartbeatNow: () => {
              }, runHeartbeatOnce: void 0 },
              sessionKey
            );
            forceClearApprovalLock(request_id);
            if (result.success) {
              res.statusCode = 200;
              res.end(JSON.stringify({ status: "success", request_id, approved, message: result.message }));
            } else {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: result.message, request_id }));
            }
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
                  }).catch(() => {
                  });
                }
                setTimeout(() => {
                  try {
                    systemApi.requestHeartbeatNow?.({
                      reason: wakeReason,
                      sessionKey,
                      coalesceMs: 0
                    });
                  } catch (_e) {
                  }
                }, 500);
              } catch (_wakeErr) {
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
      api.registerHttpRoute({
        method: "POST",
        path: "/notification-callback",
        auth: "gateway",
        match: "exact",
        replaceExisting: true,
        handler: async (req, res) => {
          let body = {};
          try {
            const chunks = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            }
            const raw = Buffer.concat(chunks).toString();
            body = JSON.parse(raw);
          } catch (_e) {
            console.warn(`[notification-callback] Failed to parse body: ${_e}`);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return true;
          }
          if (body.action === "stats") {
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
          if (secret !== APPROVAL_SECRET) {
            console.warn(`[notification-callback] Invalid secret for notification ${notification_id}`);
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "Invalid or missing approval secret" }));
            return true;
          }
          const url2 = new URL(req.url || "/", `http://localhost`);
          const sessionKey = bodySessionKey || url2.searchParams.get("sessionKey");
          if (!sessionKey) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing sessionKey parameter" }));
            return true;
          }
          console.info(`[notification-callback] Using sessionKey: ${sessionKey} (from body: ${!!bodySessionKey})`);
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
          const systemApi = api.runtime?.system;
          if (!systemApi?.enqueueSystemEvent) {
            console.warn(`[notification-callback] Warning: system API not available, agent may not wake up after notification feedback`);
          }
          try {
            const result = await resumeNotificationFlow(
              notification_id,
              { revealed: revealed ?? null, time_to_reveal_sec: time_to_reveal_sec ?? null, dismissed: dismissed ?? null, timed_out: timed_out ?? void 0 },
              boundTaskFlow,
              { enqueueSystemEvent: systemApi?.enqueueSystemEvent?.bind(systemApi) ?? (() => {
              }), requestHeartbeatNow: () => {
              }, runHeartbeatOnce: void 0 },
              sessionKey
            );
            if (result.success) {
              res.statusCode = 200;
              res.end(JSON.stringify({ status: "success", notification_id, message: result.message }));
            } else {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: result.message, notification_id }));
            }
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
                  }).catch(() => {
                  });
                }
                setTimeout(() => {
                  try {
                    systemApi.requestHeartbeatNow?.({
                      reason: wakeReason,
                      sessionKey,
                      coalesceMs: 0
                    });
                  } catch (_e) {
                  }
                }, 500);
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
                      "Content-Length": Buffer.byteLength(postData)
                    },
                    timeout: 3e3
                  }, (wakeRes) => {
                    let data = "";
                    wakeRes.on("data", (chunk) => {
                      data += chunk;
                    });
                    wakeRes.on("end", () => {
                      console.info(`[notification-callback] /hooks/wake fallback response: ${wakeRes.statusCode} ${data}`);
                    });
                  });
                  wakeReq.on("error", (e) => {
                    console.warn(`[notification-callback] /hooks/wake fallback failed: ${e.message}`);
                  });
                  wakeReq.write(postData);
                  wakeReq.end();
                } catch (_wakeFallbackErr) {
                  console.warn(`[notification-callback] /hooks/wake fallback error: ${_wakeFallbackErr}`);
                }
              } catch (_wakeErr) {
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
      api.registerHttpRoute({
        method: "POST",
        path: "/environmental-event",
        auth: "gateway",
        match: "exact",
        replaceExisting: true,
        handler: async (req, res) => {
          let body = {};
          try {
            const chunks = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            }
            const raw = Buffer.concat(chunks).toString();
            body = JSON.parse(raw);
          } catch (_e) {
            console.info(`[environmental-event] Failed to parse body: ${_e}`);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return true;
          }
          console.info(`[environmental-event] Received: type=${body.type}, present=${body.present}, absent_duration=${body.absent_duration}`);
          const presenceTarget = api.pluginConfig?.presenceTarget || "main";
          const eventText = formatEnvironmentalEvent(body);
          const shouldWake = shouldWakeAgent(body.type);
          const now = Date.now();
          const dedupeOk = shouldWake && now - lastPresenceSettledAt > 5e3;
          if (shouldWake && dedupeOk) {
            lastPresenceSettledAt = now;
            const agentId = presenceTarget === "main" ? "main" : presenceTarget;
            const sessionKey = `agent:${agentId}:main`;
            console.info(`[environmental-event] Routing ${body.type} to agent '${agentId}' via in-process SDK (sessionKey=${sessionKey})`);
            res.statusCode = 200;
            res.end(JSON.stringify({ status: "received", routedTo: agentId }));
            const systemApi = api.runtime?.system;
            if (systemApi?.enqueueSystemEvent) {
              const enqueued = systemApi.enqueueSystemEvent(eventText, {
                sessionKey,
                trusted: false
              });
              console.info(`[environmental-event] enqueueSystemEvent result: ${enqueued} (sessionKey=${sessionKey})`);
            } else {
              console.warn(`[environmental-event] enqueueSystemEvent not available \u2014 event may not reach agent`);
            }
            if (systemApi?.runHeartbeatOnce) {
              setTimeout(() => {
                systemApi.runHeartbeatOnce({
                  agentId,
                  sessionKey,
                  reason: "hook",
                  heartbeat: { target: "last" }
                }).then((wakeResult) => {
                  console.info(`[environmental-event] runHeartbeatOnce result: ${JSON.stringify(wakeResult)} (agentId=${agentId})`);
                }).catch((wakeErr) => {
                  console.warn(`[environmental-event] runHeartbeatOnce failed: ${wakeErr instanceof Error ? wakeErr.message : String(wakeErr)}`);
                });
              }, 100);
            } else {
              console.warn(`[environmental-event] runHeartbeatOnce not available \u2014 agent may not wake immediately`);
            }
            return true;
          }
          console.info(`[environmental-event] Non-wake event ${body.type} acknowledged`);
          res.statusCode = 200;
          res.end(JSON.stringify({ status: "received" }));
          return true;
        }
      });
      console.info("[openclaw-interaction-bridge] Registered /environmental-event route");
    }
  }
});
export {
  index_default as default
};

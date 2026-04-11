// ~/.openclaw/extensions/openclaw-interaction-bridge/index.ts
// OpenClaw Interaction Bridge Plugin
// - Updates mission-control API with agent state (processing/speaking/idle)
// - Registers approval callback HTTP route for snarling button responses

import { requestUserApproval, resumeApprovalFlow, forceClearApprovalLock } from "./approval_tool.js";

const MISSION_CONTROL_URL = "http://localhost:3000/api/status";
let idleTimeout: ReturnType<typeof setTimeout> | null = null;
const IDLE_DELAY_MS = 30000;

// Track if HTTP route is registered (only register once)
let routeRegistered = false;

async function updateState(status: string, sessionId: string) {
  try {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
      idleTimeout = null;
    }

    void fetch(MISSION_CONTROL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, sessionId, timestamp: Date.now() })
    });

    // Set idle timeout for processing and speaking states
    if (status === "processing" || status === "speaking") {
      idleTimeout = setTimeout(() => {
        void fetch(MISSION_CONTROL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "idle", sessionId, timestamp: Date.now() })
        });
      }, IDLE_DELAY_MS);
    }
  } catch (_e) {
    // Silent fail - mission control is optional
  }
}

export default {
  id: "openclaw-interaction-bridge",
  name: "OpenClaw Interaction Bridge",

  register(api: any) {
    // State monitoring hooks - track when agent is processing or speaking
    api.on("before_tool_call", (event: any) => {
      if (event.ctx?.sessionKey) {
        updateState("processing", event.ctx.sessionKey);
      }
    });

    api.on("before_agent_reply", (event: any) => {
      if (event.ctx?.sessionKey) {
        updateState("speaking", event.ctx.sessionKey);
      }
    });

    // Register the approval tool
    // Uses api.registerTool with a plain object (not a factory function)
    // The execute function receives (toolCallId, params, ctx) where ctx has sessionKey
    api.registerTool({
      name: "request_user_approval",
      description: "Request user approval via snarling display. Creates a TaskFlow that waits for user response. Only one approval at a time.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "The action requiring approval (e.g., 'delete_file', 'send_email')"
          },
          message: {
            type: "string",
            description: "Human-readable message explaining what needs approval"
          }
        },
        required: ["action", "message"]
      },
      async execute(_toolCallId: string, params: any, ctx: any) {
        const { action, message } = params;

        // Get TaskFlow bound to this tool context
        // Try fromToolContext first, but it throws if ctx lacks sessionKey
        // Fall back to bindSession with default sessionKey
        let taskFlow: any = null;
        try {
          taskFlow = api.runtime?.taskFlow?.fromToolContext?.(ctx);
        } catch (e) {
          console.error(`[approval-tool] fromToolContext failed: ${e instanceof Error ? e.message : String(e)}, falling back to bindSession`);
        }

        if (!taskFlow) {
          const taskFlowApi = api.runtime?.taskFlow;
          if (taskFlowApi?.bindSession) {
            const sessionKey = ctx?.sessionKey || "agent:main:main";
            console.error(`[approval-tool] Using bindSession with sessionKey=${sessionKey}`);
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

        try {
          const result = await requestUserApproval({ action, message }, taskFlow);
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
    }, { optional: true });

    // Register HTTP route for approval callbacks from snarling
    // When user presses A/B on snarling, the approval_server forwards here
    if (api.registerHttpRoute && !routeRegistered) {
      routeRegistered = true;

      api.registerHttpRoute({
        method: "POST",
        path: "/approval-callback",
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
            console.error(`[approval-callback] Failed to parse body: ${_e}`);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return true;
          }

          const { request_id, approved } = body;

          if (!request_id) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing request_id" }));
            return true;
          }

          console.error(`[approval-callback] Received: request_id=${request_id}, approved=${approved}`);

          // Get sessionKey from query string
          const url = new URL(req.url || '/', 'http://localhost');
          const sessionKey = url.searchParams.get('sessionKey') || 'agent:main:main';

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
          if (!systemApi?.enqueueSystemEvent || !systemApi?.requestHeartbeatNow) {
            console.error(`[approval-callback] Warning: system API not available, agent may not wake up after approval`);
          }

          try {
            const result = await resumeApprovalFlow(
              request_id,
              approved === true,
              boundTaskFlow,
              systemApi ?? { enqueueSystemEvent: () => {}, requestHeartbeatNow: () => {} },
              sessionKey
            );

            // Safety net: always clear the lock after handling a callback,
            // even if resumeApprovalFlow had partial failures
            forceClearApprovalLock(request_id);

            if (result.success) {
              res.statusCode = 200;
              res.end(JSON.stringify({ status: "success", request_id, approved, message: result.message }));
            } else {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: result.message, request_id }));
            }
          } catch (error) {
            console.error(`[approval-callback] Error: ${error}`);
            // Even on exception, clear the lock so it doesn't get stuck
            forceClearApprovalLock(request_id);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Failed to resume TaskFlow", details: String(error), request_id }));
          }
          return true;
        }
      });

      console.error("[openclaw-interaction-bridge] Registered /approval-callback route");
    }
  }
};
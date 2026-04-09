// ~/.openclaw/extensions/openclaw-interaction-bridge/index.ts
// OpenClaw Interaction Bridge Plugin - Updates mission-control API with agent state
// Includes TaskFlow-based approval system

import approvalWorkflow from "./approval_workflow";
import { requestUserApproval, resumeApprovalFlow } from "./approval_tool";

const MISSION_CONTROL_URL = "http://localhost:3000/api/status";
let idleTimeout: ReturnType<typeof setTimeout> | null = null;
const IDLE_DELAY_MS = 30000;

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

    // Set idle timeout for both processing and speaking states
    if (status === "processing" || status === "speaking") {
      idleTimeout = setTimeout(() => {
        void fetch(MISSION_CONTROL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "idle", sessionId, timestamp: Date.now() })
        });
      }, IDLE_DELAY_MS);
    }
  } catch (e) {
    // Silent fail
  }
}

export default {
  id: "openclaw-interaction-bridge",
  name: "OpenClaw Interaction Bridge",

  tools: [
    {
      id: "request_user_approval",
      name: "Request User Approval",
      description: "Request user approval via snarling display. Creates a TaskFlow that waits for user response.",
      schema: {
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
      handler: async (params: any, ctx: any) => {
        const result = await requestUserApproval(params, ctx);
        return {
          content: [{ type: "text", text: result }]
        };
      }
    }
  ],

  register(api: any) {
    // State monitoring hooks
    api.on("before_tool_call", (event: any) => {
      updateState("processing", event.sessionKey);
    });

    api.on("before_agent_reply", (event: any) => {
      updateState("speaking", event.sessionKey);
    });

    // Register approval workflow with TaskFlow
    approvalWorkflow.register(api);

    // Register webhook endpoint for approval callbacks
    // This allows snarling to notify OpenClaw when buttons are pressed
    // and resumes the TaskFlow to continue agent execution
    if (api.registerWebhook) {
      api.registerWebhook("/approval-callback", async (req: any, res: any) => {
        const { request_id, approved, flow_id } = req.body || {};
        
        if (!request_id) {
          return res.status(400).json({ error: "Missing request_id" });
        }

        console.log(`[approval-webhook] Received approval callback: ${request_id} = ${approved ? "APPROVED" : "REJECTED"}`);

        // Get TaskFlow API from runtime
        const taskFlowApi = api.runtime?.tasks?.flow;
        if (!taskFlowApi) {
          return res.status(500).json({ 
            error: "TaskFlow API not available",
            request_id 
          });
        }

        try {
          // Resume the approval flow with the user's decision
          const result = await resumeApprovalFlow(request_id, approved === true, taskFlowApi);
          
          if (result.success) {
            return res.json({ 
              status: "success", 
              request_id,
              approved,
              message: result.message
            });
          } else {
            return res.status(404).json({ 
              error: result.message,
              request_id 
            });
          }
        } catch (error) {
          console.error(`[approval-webhook] Error resuming flow: ${error}`);
          return res.status(500).json({ 
            error: "Failed to resume TaskFlow",
            details: String(error),
            request_id 
          });
        }
      });

      console.log("[openclaw-interaction-bridge] Registered approval callback webhook at /approval-callback");
    }
  }
};

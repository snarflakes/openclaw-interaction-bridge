// approval_workflow.ts - TaskFlow-based approval system with durable waiting

const APPROVAL_SERVER_URL = "http://localhost:5001";

interface ApprovalRequest {
  request_id: string;
  message: string;
  callback_url: string;
  timeout_seconds?: number;
}

export default {
  id: "approval_workflow",
  name: "Approval Workflow",
  description: "TaskFlow-based approval system that durably waits for user button press",

  register(api: any) {
    // Store pending approvals for callback lookup
    const pendingApprovals = new Map<string, any>();

    api.registerTool(
      {
        name: "request_user_approval",
        description: "Requests user approval for sensitive actions and waits for button press (A=approve, B=reject). Uses TaskFlow for durable waiting up to 2 hours.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "Short identifier for the action (e.g., 'delete_file', 'send_email')"
            },
            message: {
              type: "string",
              description: "Single sentence description of what requires approval"
            }
          },
          required: ["action", "message"]
        },
        execute: async (_id: string, params: any, ctx: any) => {
          const { action, message } = params;
          const requestId = `approval-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          
          // Create TaskFlow for durable waiting
          const taskFlow = api.runtime?.tasks?.flow?.fromToolContext(ctx);
          
          if (!taskFlow) {
            return {
              content: [{
                type: "text",
                text: "Error: TaskFlow runtime not available"
              }]
            };
          }

          // Create managed flow
          const created = taskFlow.createManaged({
            controllerId: "openclaw-interaction-bridge/approval",
            goal: `Approval for: ${action}`,
            currentStep: "awaiting_user_response",
            stateJson: {
              action,
              message,
              requestId,
              approved: null,
              responded: false
            }
          });

          if (!created.flowId) {
            return {
              content: [{
                type: "text",
                text: `Error creating approval flow: ${created.reason || "unknown"}`
              }]
            };
          }

          // Build callback URL for approval server to resume this flow
          const callbackUrl = `${api.gateway?.url || "http://localhost:3000"}/api/plugins/openclaw-interaction-bridge/approval-callback?flowId=${created.flowId}`;

          // Send request to snarling approval server
          const request: ApprovalRequest = {
            request_id: requestId,
            message: `${action}: ${message}`,
            callback_url: callbackUrl,
            timeout_seconds: 7200 // 2 hours
          };

          try {
            const response = await fetch(`${APPROVAL_SERVER_URL}/approval/request`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(request)
            });

            if (!response.ok) {
              throw new Error(`Approval server error: ${response.status}`);
            }

            // Set flow to waiting state
            const waiting = taskFlow.setWaiting({
              flowId: created.flowId,
              expectedRevision: created.revision,
              currentStep: "awaiting_user_response",
              stateJson: {
                action,
                message,
                requestId,
                approved: null,
                responded: false
              },
              waitJson: {
                kind: "approval",
                channel: "snarling",
                display: "snarling-approval",
                requestId
              }
            });

            if (!waiting.applied) {
              throw new Error(`Failed to set waiting state: ${waiting.code}`);
            }

            // Store mapping for callback
            pendingApprovals.set(requestId, {
              flowId: created.flowId,
              revision: waiting.flow.revision
            });

            return {
              content: [{
                type: "text",
                text: `⏳ Approval requested on snarling display.\n\nAction: ${action}\nMessage: ${message}\n\nPress A to approve or B to reject.\nRequest ID: ${requestId}\n\nThe agent will wait up to 2 hours for your response.`
              }]
            };

          } catch (error) {
            // Clean up flow on error
            taskFlow.fail({
              flowId: created.flowId,
              expectedRevision: created.revision,
              reason: error instanceof Error ? error.message : "Unknown error"
            });

            return {
              content: [{
                type: "text",
                text: `Error requesting approval: ${error instanceof Error ? error.message : "Unknown error"}`
              }]
            };
          }
        }
      },
      { optional: true }
    );

    // Register callback endpoint for approval responses
    api.registerTool(
      {
        name: "approval_callback_handler",
        description: "Internal handler for approval responses from snarling display",
        parameters: {
          type: "object",
          properties: {
            request_id: { type: "string" },
            approved: { type: "boolean" },
            flow_id: { type: "string" }
          },
          required: ["request_id", "approved"]
        },
        execute: async (_id: string, params: any) => {
          const { request_id, approved, flow_id } = params;

          const taskFlow = api.runtime?.tasks?.flow;
          if (!taskFlow) {
            return { content: [{ type: "text", text: "TaskFlow not available" }] };
          }

          // Get pending approval info
          const pending = pendingApprovals.get(request_id);
          if (!pending && !flow_id) {
            return { content: [{ type: "text", text: "Unknown approval request" }] };
          }

          const targetFlowId = flow_id || pending.flowId;

          // Resume the flow with the approval decision
          const resumed = taskFlow.resume({
            flowId: targetFlowId,
            expectedRevision: pending?.revision || 0,
            status: "running",
            currentStep: "approval_received",
            stateJson: {
              approved,
              responded: true
            }
          });

          if (!resumed.applied) {
            return { content: [{ type: "text", text: `Failed to resume flow: ${resumed.code}` }] };
          }

          // Complete the flow
          taskFlow.finish({
            flowId: targetFlowId,
            expectedRevision: resumed.flow.revision,
            stateJson: {
              approved,
              responded: true
            }
          });

          // Clean up
          pendingApprovals.delete(request_id);

          return {
            content: [{
              type: "text",
              text: `Approval ${approved ? "APPROVED" : "REJECTED"} recorded for ${request_id}`
            }]
          };
        }
      },
      { optional: true }
    );
  }
};

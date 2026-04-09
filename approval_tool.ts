// approval_tool.ts - Request user approval via snarling approval server

const APPROVAL_SERVER_URL = "http://localhost:5001";

interface ApprovalRequest {
  request_id: string;
  message: string;
  callback_url: string;
  timeout_seconds?: number;
}

async function requestApproval(action: string, message: string, requestId: string, callbackUrl: string) {
  const request: ApprovalRequest = {
    request_id: requestId,
    message: `${action}: ${message}`,
    callback_url: callbackUrl,
    timeout_seconds: 300
  };

  const response = await fetch(`${APPROVAL_SERVER_URL}/approval/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`Approval server error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  return result;
}

export default {
  id: "request_user_approval",
  name: "Request User Approval",
  description: "Requests user approval for sensitive actions before proceeding. The user must press button A to approve or button B to reject on the snarling display.",

  register(api: any) {
    api.registerTool(
      {
        name: "request_user_approval",
        description: "Requests user approval for sensitive actions. Displays alert on snarling with button A to approve, button B to reject.",
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
            },
            request_id: {
              type: "string",
              description: "Unique request ID for tracking"
            },
            callback_url: {
              type: "string",
              description: "URL to POST approval response to"
            }
          },
          required: ["action", "message", "request_id", "callback_url"]
        },
        execute: async (_id: string, params: any) => {
          const { action, message, request_id, callback_url } = params;

          try {
            const result = await requestApproval(action, message, request_id, callback_url);

            return {
              content: [{
                type: "text",
                text: `Approval request sent to snarling display. Status: ${result.status}, Request ID: ${result.request_id}`
              }]
            };
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Error sending approval request: ${error instanceof Error ? error.message : "Unknown error"}`
              }]
            };
          }
        }
      },
      { optional: true }
    );
  }
};

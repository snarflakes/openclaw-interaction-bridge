// approval_tool.ts - TaskFlow-based approval tool for OpenClaw Interaction Bridge
// This tool creates a managed TaskFlow that waits for user approval via snarling display

import { z } from "zod";

// Store pending approvals (request_id -> flow_id mapping)
const pendingApprovals = new Map<string, string>();

// Track if an approval is currently in progress
let currentApprovalInProgress: string | null = null;

export const requestUserApprovalSchema = z.object({
  action: z.string().describe("The action requiring approval (e.g., 'delete_file', 'send_email')"),
  message: z.string().describe("Human-readable message explaining what needs approval"),
});

export type RequestUserApprovalInput = z.infer<typeof requestUserApprovalSchema>;

/**
 * Request user approval using TaskFlow
 * Creates a managed TaskFlow, sets it to waiting state, and returns flowId
 * The webhook will resume this flow when user responds via snarling
 * 
 * LIMITATION: Only 1 approval request allowed at a time
 */
export async function requestUserApproval(
  input: RequestUserApprovalInput,
  ctx: any
): Promise<string> {
  const { action, message } = input;

  // Check if an approval is already in progress
  if (currentApprovalInProgress) {
    const existingRequestId = currentApprovalInProgress;
    const existingFlowId = pendingApprovals.get(existingRequestId);
    
    if (existingFlowId) {
      return `⚠️ **Approval Request Blocked**

Another approval is already in progress:
- Request ID: ${existingRequestId}
- Status: Waiting for user response

Please respond to the existing request on your snarling display before requesting new approvals.

**Blocked Action:** ${action}`;
    } else {
      // Stale entry, clear it
      currentApprovalInProgress = null;
    }
  }

  const requestId = `approval-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // Get TaskFlow API from runtime
  const taskFlow = ctx.api?.runtime?.tasks?.flow;
  if (!taskFlow) {
    throw new Error("TaskFlow API not available - cannot create approval flow");
  }

  // Create a managed TaskFlow for this approval request
  const created = taskFlow.createManaged({
    controllerId: "openclaw-interaction-bridge/approval",
    goal: `Request approval for: ${action}`,
    currentStep: "awaiting_user_approval",
    stateJson: {
      requestId,
      action,
      message,
      approved: null, // Will be set by webhook
      respondedAt: null,
    },
  });

  if (!created.created) {
    throw new Error(`Failed to create approval TaskFlow: ${created.reason || "unknown error"}`);
  }

  const flowId = created.flowId;

  // Store the mapping for webhook lookup AND track global lock
  pendingApprovals.set(requestId, flowId);
  currentApprovalInProgress = requestId;

  // Set the flow to waiting state
  // This will cause the agent to pause and wait for the webhook to resume
  const waiting = taskFlow.setWaiting({
    flowId: flowId,
    expectedRevision: created.revision,
    currentStep: "awaiting_user_approval",
    stateJson: {
      requestId,
      action,
      message,
      approved: null,
      respondedAt: null,
    },
    waitJson: {
      kind: "user_approval",
      channel: "snarling",
      requestId,
      action,
      message,
    },
  });

  if (!waiting.applied) {
    // Clean up if waiting state failed
    pendingApprovals.delete(requestId);
    currentApprovalInProgress = null;
    throw new Error(`Failed to set approval flow to waiting: ${waiting.code || "unknown error"}`);
  }

  // Also notify snarling display via HTTP (if available)
  // This is separate from TaskFlow - it's just for visual feedback
  try {
    const snarlingUrl = "http://localhost:5000/approval/alert";
    await fetch(snarlingUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        message: message,
        flow_id: flowId,
      }),
    });
  } catch (e) {
    // Silent fail - snarling notification is optional
    console.log(`[approval-tool] Could not notify snarling: ${e}`);
  }

  // Return message to agent indicating we're waiting
  // The TaskFlow waiting state will cause the agent to pause
  return `⏳ Waiting for user approval via snarling display...\n\n**Action:** ${action}\n**Details:** ${message}\n\nRequest ID: ${requestId}`;
}

/**
 * Resume a waiting approval TaskFlow with the user's decision
 * Called by the webhook handler when user presses A/B on snarling
 */
export async function resumeApprovalFlow(
  requestId: string,
  approved: boolean,
  taskFlowApi: any
): Promise<{ success: boolean; message: string }> {
  const flowId = pendingApprovals.get(requestId);
  
  if (!flowId) {
    return {
      success: false,
      message: `No pending approval found for request: ${requestId}`,
    };
  }

  // Get current flow state
  const flow = await taskFlowApi.get(flowId);
  if (!flow) {
    pendingApprovals.delete(requestId);
    return {
      success: false,
      message: `TaskFlow not found: ${flowId}`,
    };
  }

  // Resume the flow with the approval decision
  const resumed = taskFlowApi.resume({
    flowId: flowId,
    expectedRevision: flow.revision,
    status: "running",
    currentStep: "approval_responded",
    stateJson: {
      ...flow.stateJson,
      approved,
      respondedAt: Date.now(),
    },
  });

  if (!resumed.applied) {
    return {
      success: false,
      message: `Failed to resume flow: ${resumed.code || "unknown error"}`,
    };
  }

  // Finish the flow with the result
  taskFlowApi.finish({
    flowId: flowId,
    expectedRevision: resumed.flow.revision,
    stateJson: {
      ...resumed.flow.stateJson,
      approved,
      respondedAt: Date.now(),
    },
  });

  // Clean up pending approval and clear global lock
  pendingApprovals.delete(requestId);
  currentApprovalInProgress = null;

  return {
    success: true,
    message: `Approval ${approved ? "APPROVED" : "REJECTED"} for ${requestId}`,
  };
}

/**
 * Get the flowId for a pending approval request
 * Used by webhook handler to verify requests
 */
export function getPendingApprovalFlowId(requestId: string): string | undefined {
  return pendingApprovals.get(requestId);
}

export default {
  requestUserApproval,
  resumeApprovalFlow,
  getPendingApprovalFlowId,
};
// approval_tool.ts - TaskFlow-based approval tool for OpenClaw Interaction Bridge
// Creates a managed TaskFlow that waits for user approval via snarling display

// Store pending approvals (request_id -> flow_id mapping)
const pendingApprovals = new Map<string, string>();

// Track if an approval is currently in progress (global lock)
let currentApprovalInProgress: string | null = null;

export interface RequestUserApprovalInput {
  action: string;
  message: string;
}

/**
 * Request user approval using TaskFlow.
 * Creates a managed TaskFlow, sets it to waiting state, and notifies snarling.
 * The webhook callback will resume this flow when user responds.
 *
 * LIMITATION: Only 1 approval request allowed at a time.
 */
export async function requestUserApproval(
  input: RequestUserApprovalInput,
  taskFlow: any
): Promise<string> {
  const { action, message } = input;

  // Global lock: only one approval at a time
  if (currentApprovalInProgress) {
    const existingFlowId = pendingApprovals.get(currentApprovalInProgress);
    if (existingFlowId) {
      return `⚠️ Approval request blocked — another approval is already in progress (ID: ${currentApprovalInProgress}). Respond to that one first.\n\nBlocked action: ${action}`;
    }
    // Stale entry, clear it
    currentApprovalInProgress = null;
  }

  const requestId = `approval-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  if (!taskFlow) {
    throw new Error("TaskFlow API not available - cannot create approval flow");
  }

  // Create a managed TaskFlow for this approval request
  const created = await taskFlow.createManaged({
    controllerId: "openclaw-interaction-bridge/approval",
    goal: `Request approval for: ${action}`,
    currentStep: "awaiting_user_approval",
    stateJson: {
      requestId,
      action,
      message,
      approved: null,
      respondedAt: null,
    },
  });

  if (!created || !created.flowId) {
    const detail = created ? JSON.stringify(created) : "null result";
    throw new Error(`Failed to create approval TaskFlow: ${detail}`);
  }

  const flowId = created.flowId;

  // Store mapping and set global lock
  pendingApprovals.set(requestId, flowId);
  currentApprovalInProgress = requestId;

  // Set the flow to waiting state (agent pauses here)
  const waiting = await taskFlow.setWaiting({
    flowId,
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

  if (!waiting || !waiting.applied) {
    // Clean up on failure
    pendingApprovals.delete(requestId);
    currentApprovalInProgress = null;
    const detail = waiting ? JSON.stringify(waiting) : "null result";
    throw new Error(`Failed to set approval flow to waiting: ${detail}`);
  }

  // setWaiting returns { applied: true, flow: FlowRecord } on success
  // The flow may have been updated with a new revision; capture it for later use
  const waitingFlowRevision = waiting.flow?.revision ?? created.revision;

  // Notify snarling display via approval_server (visual feedback)
  try {
    await fetch("http://localhost:5001/approval/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        message: `${action}: ${message}`,
        callback_url: `http://localhost:18789/approval-callback?sessionKey=agent:main:main`,
        timeout_seconds: 7200,
      }),
    });
  } catch (_e) {
    // Snarling notification is optional - don't block on it
    console.error(`[approval-tool] Could not notify approval_server: ${_e}`);
  }

  return `⏳ Waiting for user approval via snarling display...\n\n**Action:** ${action}\n**Details:** ${message}\n\nRequest ID: ${requestId}`;
}

/**
 * Resume a waiting approval TaskFlow with the user's decision.
 * Called by the webhook handler when user presses A/B on snarling.
 */
export async function resumeApprovalFlow(
  requestId: string,
  approved: boolean,
  taskFlowApi: any
): Promise<{ success: boolean; message: string }> {
  const flowId = pendingApprovals.get(requestId);

  if (!flowId) {
    return { success: false, message: `No pending approval found for request: ${requestId}` };
  }

  // Get current flow state
  // taskFlowApi.get may return a FlowRecord directly or { flow: FlowRecord }
  const getResult = await taskFlowApi.get(flowId);
  const flow = getResult?.flow ?? getResult;
  if (!flow || !flow.flowId) {
    pendingApprovals.delete(requestId);
    currentApprovalInProgress = null;
    return { success: false, message: `TaskFlow not found: ${flowId}` };
  }

  // Resume the flow with the approval decision
  const resumed = await taskFlowApi.resume({
    flowId,
    expectedRevision: flow.revision,
    status: "running",
    currentStep: "approval_responded",
    stateJson: {
      ...flow.stateJson,
      approved,
      respondedAt: Date.now(),
    },
  });

  // resume returns { applied: true, flow: FlowRecord } or { applied: false, reason: string }
  if (!resumed || !resumed.applied) {
    return { success: false, message: `Failed to resume flow: ${resumed?.reason || "unknown error"}` };
  }

  // Finish the flow — returns { applied: true, flow: FlowRecord } or { applied: false, reason: string }
  const finished = await taskFlowApi.finish({
    flowId,
    expectedRevision: resumed.flow.revision,
    stateJson: {
      ...resumed.flow.stateJson,
      approved,
      respondedAt: Date.now(),
    },
  });

  if (!finished || !finished.applied) {
    // Flow was resumed but couldn't be finished — still consider it a success
    // since the approval decision was recorded
    console.error(`[approval-tool] Warning: could not finish flow ${flowId}: ${finished?.reason || "unknown"}`);
  }

  // Clean up
  pendingApprovals.delete(requestId);
  currentApprovalInProgress = null;

  return { success: true, message: `Approval ${approved ? "APPROVED" : "REJECTED"} for ${requestId}` };
}

/**
 * Get the flowId for a pending approval request.
 */
export function getPendingApprovalFlowId(requestId: string): string | undefined {
  return pendingApprovals.get(requestId);
}
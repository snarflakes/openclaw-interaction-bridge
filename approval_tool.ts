// approval_tool.ts - TaskFlow-based approval tool for OpenClaw Interaction Bridge
// Creates a managed TaskFlow that waits for user approval via snarling display

// Store pending approvals (request_id -> { flowId, createdAt })
interface PendingEntry {
  flowId: string;
  createdAt: number;
}
const pendingApprovals = new Map<string, PendingEntry>();

// Track if an approval is currently in progress (global lock)
// Now includes timestamp for staleness detection
let currentApprovalInProgress: string | null = null;
let currentApprovalStartedAt: number | null = null;

// Maximum time an approval lock is valid before it's considered stale (30 minutes)
const APPROVAL_LOCK_TIMEOUT_MS = 30 * 60 * 1000;

export interface RequestUserApprovalInput {
  action: string;
  message: string;
}

/**
 * Check if the current approval lock is stale or orphaned, and clear it if so.
 * Returns true if the lock was cleared.
 */
function clearStaleLock(): boolean {
  if (!currentApprovalInProgress) return false;

  // Check 1: Is the lock entry missing from pendingApprovals? (orphaned)
  const entry = pendingApprovals.get(currentApprovalInProgress);
  if (!entry) {
    console.error(`[approval-tool] Clearing orphaned lock: ${currentApprovalInProgress} (no matching pending entry)`);
    currentApprovalInProgress = null;
    currentApprovalStartedAt = null;
    return true;
  }

  // Check 2: Has the lock been held too long? (stale/timeout)
  const elapsed = Date.now() - (currentApprovalStartedAt ?? entry.createdAt);
  if (elapsed > APPROVAL_LOCK_TIMEOUT_MS) {
    console.error(`[approval-tool] Clearing stale lock: ${currentApprovalInProgress} (held for ${Math.round(elapsed / 60000)}min, timeout=${APPROVAL_LOCK_TIMEOUT_MS / 60000}min)`);
    pendingApprovals.delete(currentApprovalInProgress);
    currentApprovalInProgress = null;
    currentApprovalStartedAt = null;
    return true;
  }

  return false;
}

/**
 * Force-clear the approval lock. Called by webhook handler after successful
 * flow resumption, or as a safety net.
 */
export function forceClearApprovalLock(requestId?: string): void {
  if (requestId && currentApprovalInProgress !== requestId) {
    // The lock belongs to a different request — only clear if stale
    clearStaleLock();
    return;
  }
  if (requestId) {
    pendingApprovals.delete(requestId);
  }
  currentApprovalInProgress = null;
  currentApprovalStartedAt = null;
}

/**
 * Request user approval using TaskFlow.
 * Creates a managed TaskFlow, sets it to waiting state, notifies snarling,
 * and POLLS until the user responds.
 *
 * If another approval is in progress, it checks for staleness before blocking.
 */
export async function requestUserApproval(
  input: RequestUserApprovalInput,
  taskFlow: any
): Promise<string> {
  const { action, message } = input;

  // Check and clear stale/orphaned locks before deciding to block
  clearStaleLock();

  // Global lock: only one approval at a time (with stale detection)
  if (currentApprovalInProgress) {
    const entry = pendingApprovals.get(currentApprovalInProgress);
    // Should still exist since clearStaleLock didn't clear it
    return `⚠️ Approval request blocked — another approval is already in progress (ID: ${currentApprovalInProgress}, started ${entry ? Math.round((Date.now() - entry.createdAt) / 60000) + 'min ago' : 'recently'}). Respond to that one first.\n\nBlocked action: ${action}`;
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
  const now = Date.now();

  // Store mapping and set global lock
  pendingApprovals.set(requestId, { flowId, createdAt: now });
  currentApprovalInProgress = requestId;
  currentApprovalStartedAt = now;

  // Set the flow to waiting state
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
    currentApprovalStartedAt = null;
    const detail = waiting ? JSON.stringify(waiting) : "null result";
    throw new Error(`Failed to set approval flow to waiting: ${detail}`);
  }

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

  // Poll the TaskFlow until it's resolved (no longer in "waiting" status)
  // The webhook callback will resume and finish the flow when user presses A/B
  const POLL_INTERVAL_MS = 2000;  // Check every 2 seconds
  const MAX_POLL_DURATION_MS = 30 * 60 * 1000;  // 30 minute timeout
  const pollStart = Date.now();

  console.error(`[approval-tool] Polling TaskFlow ${flowId} for resolution (request: ${requestId})`);

  while (Date.now() - pollStart < MAX_POLL_DURATION_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    // Check if the approval was resolved (via webhook callback)
    const entry = pendingApprovals.get(requestId);
    if (!entry) {
      // Entry was removed — approval was handled by webhook callback
      console.error(`[approval-tool] Approval ${requestId} resolved (entry removed from pending)`);
      // The webhook callback enqueues a system event with the result.
      // We can also try to check the flow state directly.
      try {
        const flowResult = await taskFlow.get(flowId);
        const flow = flowResult?.flow ?? flowResult;
        if (flow?.stateJson?.approved != null) {
          const approved = flow.stateJson.approved === true;
          const result = approved ? "✅ APPROVED" : "❌ REJECTED";
          return `${result}: User ${approved ? 'approved' : 'rejected'} the request.\n\nAction: ${action}\nDetails: ${message}\nRequest: ${requestId}`;
        }
      } catch (_e) {
        console.error(`[approval-tool] Could not get flow state after resolution: ${_e}`);
      }
      // Fallback: return generic resolved message
      return `Approval request resolved. (Request: ${requestId})\n\nAction: ${action}\nDetails: ${message}`;
    }

    // Check for staleness (lock held too long)
    if (currentApprovalInProgress === requestId && Date.now() - (currentApprovalStartedAt ?? entry.createdAt) > APPROVAL_LOCK_TIMEOUT_MS) {
      pendingApprovals.delete(requestId);
      forceClearApprovalLock(requestId);
      return `⏰ Approval request timed out after ${APPROVAL_LOCK_TIMEOUT_MS / 60000} minutes.\n\nAction: ${action}\nDetails: ${message}\nRequest: ${requestId}`;
    }
  }

  // Max poll duration reached
  pendingApprovals.delete(requestId);
  forceClearApprovalLock(requestId);
  return `⏰ Approval request timed out.\n\nAction: ${action}\nDetails: ${message}\nRequest: ${requestId}`;
}

/**
 * Resume a waiting approval TaskFlow with the user's decision.
 * Called by the webhook handler when user presses A/B on snarling.
 * After resuming the flow, wakes the agent session so it can continue.
 */
export async function resumeApprovalFlow(
  requestId: string,
  approved: boolean,
  taskFlowApi: any,
  systemApi: { enqueueSystemEvent: (text: string, opts: { sessionKey: string }) => void; requestHeartbeatNow: (opts: { reason: string; sessionKey: string }) => void },
  sessionKey: string
): Promise<{ success: boolean; message: string }> {
  const entry = pendingApprovals.get(requestId);

  if (!entry) {
    // No matching entry — but still try to clear the lock if it matches
    if (currentApprovalInProgress === requestId) {
      console.error(`[approval-tool] Clearing lock for missing entry: ${requestId}`);
      currentApprovalInProgress = null;
      currentApprovalStartedAt = null;
    }
    return { success: false, message: `No pending approval found for request: ${requestId}` };
  }

  const flowId = entry.flowId;

  try {
    // Get current flow state
    const getResult = await taskFlowApi.get(flowId);
    const flow = getResult?.flow ?? getResult;
    if (!flow || !flow.flowId) {
      pendingApprovals.delete(requestId);
      forceClearApprovalLock(requestId);
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

    if (!resumed || !resumed.applied) {
      // Resume failed — clean up the lock anyway since we got a response
      pendingApprovals.delete(requestId);
      forceClearApprovalLock(requestId);
      return { success: false, message: `Failed to resume flow: ${resumed?.reason || "unknown error"}` };
    }

    // Finish the flow
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
      // Flow was resumed but couldn't be finished — still a success
      // since the approval decision was recorded
      console.error(`[approval-tool] Warning: could not finish flow ${flowId}: ${finished?.reason || "unknown"}`);
    }

    // No need to enqueue system events or request heartbeat —
    // the polling tool will detect the flow resolution and return the result directly.
    // But as a fallback, still try to wake the agent session in case the polling
    // tool isn't active (e.g., if the tool call timed out).
    const approvalResult = approved ? "APPROVED" : "REJECTED";
    try {
      systemApi.enqueueSystemEvent(
        `User approval response: ${approvalResult}. ${approved ? "Proceeding with the action." : "Action cancelled by user."} (request: ${requestId})`,
        { sessionKey }
      );
      systemApi.requestHeartbeatNow({
        reason: "approval-callback",
        sessionKey
      });
      console.error(`[approval-tool] Enqueued system event and requested heartbeat for session ${sessionKey}`);
    } catch (wakeErr) {
      console.error(`[approval-tool] Warning: failed to wake agent session: ${wakeErr}`);
    }

    return { success: true, message: `Approval ${approved ? "APPROVED" : "REJECTED"} for ${requestId}` };
  } finally {
    // ALWAYS clean up, regardless of success or failure in individual steps
    pendingApprovals.delete(requestId);
    forceClearApprovalLock(requestId);
  }
}

/**
 * Get the flowId for a pending approval request.
 */
export function getPendingApprovalFlowId(requestId: string): string | undefined {
  return pendingApprovals.get(requestId)?.flowId;
}
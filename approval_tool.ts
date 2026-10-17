// approval_tool.ts — Notification bridge helpers for the OpenClaw Interaction
// Bridge.
//
// v1.8.0: the optional TaskFlow feedback path for send_notification has been
// removed — api.runtime.taskFlow no longer exists on OpenClaw 2026.10.2, so
// the TaskFlow attempts always failed and fell back to fire-and-forget.
// send_notification and /notification-callback keep their wire behavior
// (fire-and-forget POSTs to port 5000; /notification-callback acknowledges
// display-side feedback), and approval handling moved to the Gateway-native
// plugin approval flow (see native_approvals.ts).

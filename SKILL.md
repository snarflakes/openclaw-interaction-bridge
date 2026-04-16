---
name: openclaw_interaction_bridge
description: "Use the Snarling physical display and A/B button approval system connected to this agent. When loaded, Snarling is already working — state changes (processing, communicating, sleeping) appear on the display automatically. Use request_user_approval for yes/no decisions before destructive or external actions: deleting files, sending emails, publishing packages, deploying to production, transferring funds."
metadata:
  openclaw:
    emoji: "🟥"
---

# OpenClaw Interaction Bridge 🟥

> Agent state on a screen. Approvals on a button. No keyboard required.

This plugin bridges your OpenClaw agent to [Snarling](https://github.com/snarflakes/snarling) — a Raspberry Pi + DisplayHAT Mini companion that shows what the agent is doing and lets you approve or reject actions with physical A/B buttons.

## What It Does

### State Display

The plugin hooks into OpenClaw events and POSTs state updates to Snarling's display server:

| Agent Activity | Snarling Shows | Trigger |
|---|---|---|
| Using tools | `processing` | `before_tool_call` |
| Generating response | `communicating` | `before_agent_reply` |
| 30s idle | `sleeping` | Auto-timeout |

Duplicates are suppressed — only state *changes* are sent. After 30 seconds of no activity, the display automatically goes to sleep.

### Physical Approvals — `request_user_approval`

The plugin registers a `request_user_approval` tool that routes yes/no decisions to Snarling's physical A/B buttons. **Use this tool whenever you need a human decision before proceeding with an action.**

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | Yes | Short verb phrase, max **24 chars** (e.g., `delete_file`, `send_email`, `publish_skill`). Shown on the display header line. |
| `message` | string | Yes | Brief explanation, max **60 chars** ideal, **80 chars** hard limit. Shown as 2 lines of ~29 chars each on the physical display. Keep it concise — long text gets truncated. (e.g., `Delete /tmp/old-logs? Cannot undo.`) |

#### When to Use

- **Before destructive actions**: deleting files, dropping databases, overwriting configs
- **Before external actions**: sending emails, posting to social, making API calls that change state
- **Before irreversible operations**: publishing packages, deploying to production, transferring funds
- **When uncertain**: if you're not sure the user would want you to proceed, ask first

#### When NOT to Use

- Reading files, checking status, browsing — these are safe internal actions
- When the answer is obvious and the user explicitly asked you to do it
- In group chats or shared channels (the approval goes to a single physical device)

#### How It Works

1. You call `request_user_approval({ action, message })`
2. Plugin creates a TaskFlow and sets it to waiting
3. Snarling displays the request on screen with an A/B button prompt
4. Human presses **A** (approve) or **B** (reject)
5. Snarling forwards the decision to the plugin's `/approval-callback` route
6. Plugin resumes the TaskFlow and returns the result

The tool **blocks** until a response comes back. Only one approval at a time — if another is in progress, the call returns an error message instead of blocking.

#### Return Values

- `✅ APPROVED` — proceed with the action
- `❌ REJECTED` — do not proceed; respect the user's decision
- `⏰ Timed out` — no response within 30 minutes; treat as rejected
- `⚠️ Approval request blocked` — another approval is already waiting; finish that one first

#### Example

```
request_user_approval({
  action: "delete_file",
  message: "Delete old-config.yaml? 90d old, cannot undo."
})
```

**Bad example** (too long, gets truncated on display):
```
request_user_approval({
  action: "delete_important_configuration_file",  // too long for header
  message: "Delete /home/pi/old-config.yaml? This file has not been modified in 90 days and contains important settings."  // way too long
})
```

## Setup

### Prerequisites

- Raspberry Pi with DisplayHAT Mini
- [Snarling](https://github.com/snarflakes/snarling) running (state + approval server on port 5000)
- OpenClaw gateway >= 2026.3.24-beta.2

### Install

```bash
# Clone to your OpenClaw extensions directory
git clone https://github.com/snarflakes/openclaw-interaction-bridge.git \
  ~/.openclaw/extensions/openclaw-interaction-bridge

# Install dependencies
cd ~/.openclaw/extensions/openclaw-interaction-bridge
npm install

# Restart OpenClaw
openclaw gateway restart
```

### Custom Targets

To point at something other than the default Snarling ports (e.g., a Tauri app, mobile web view), edit the constants at the top of `index.ts`:

```typescript
const SNARLING_URL = "http://localhost:5000/state";              // → your state endpoint
const CALLBACK_BASE_URL = "http://localhost:18789";              // → your callback base URL
```

For the approval secret (used to authenticate callback requests), set the `OPENCLAW_APPROVAL_SECRET` environment variable. If not set, a random UUID secret is generated on each startup. The secret must be included in the JSON body of callback requests (not query params — the gateway strips those).

No config file needed yet — when there are multiple adapters, a config-driven system will make sense. For now, editing the source is simpler and more honest.

## Architecture

```
OpenClaw Agent
      ↓ (plugin hooks: before_tool_call, before_agent_reply, agent_end)
Interaction Bridge Plugin
      ↓ (POST localhost:5000/state)            ← state updates
      ↓ (POST localhost:5000/approval/alert)     ← approval requests (direct, no middleman)
      ↑ (POST localhost:18789/approval-callback) ← approval responses
Snarling Display (Python service on port 5000)
```

No approval_server middleman — the plugin talks directly to Snarling on port 5000. Snarling resolves the approval via its A/B buttons and POSTs the result back to the gateway's `/approval-callback` route. Wake uses WebSocket RPC (bypasses gateway's `requests-in-flight` check).

## Approval Tracker

The plugin tracks approval lifecycle counts in memory:

| Counter | When it increments |
|---|---|
| `requested` | Every time `request_user_approval` is called |
| `approved` | Callback resolved as approved |
| `rejected` | Callback resolved as rejected |
| `timedOut` | Stale lock cleared after 30min timeout |
| `errored` | Snarling notification POST failed |

Query the stats:
```bash
curl -s -X POST http://localhost:18789/approval-callback \
  -H "Authorization: Bearer <gateway-token>" \
  -H "Content-Type: application/json" \
  -d '{"action":"stats"}'
```

Returns: `{"stats":{"requested":0,"approved":0,"rejected":0,"timedOut":0,"errored":0}}`

Stats are in-memory only — they reset on gateway restart.

## Troubleshooting

- **Display not updating**: Check that Snarling is running on port 5000 (`curl -s http://localhost:5000/state`)
- **Approvals not working**: Verify Snarling is running and the callback route is accessible; check gateway logs for `[approval-callback]` entries
- **Stuck approval lock**: Wait 30 minutes for the stale timeout, or restart the gateway
- **Plugin not loading**: Check `openclaw gateway restart` logs for errors; verify `npm install` completed
- **Stats endpoint not found**: The gateway only allows one HTTP route per plugin — stats is accessed via the same `/approval-callback` route with `{"action":"stats"}` in the body

## Install from ClawHub

```bash
openclaw plugins install clawhub:@snarflakes/openclaw-interaction-bridge
```
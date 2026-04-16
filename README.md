# OpenClaw Interaction Bridge

A plugin that bridges OpenClaw agent activity to [Snarling](https://github.com/snarflakes/snarling) — a Raspberry Pi + DisplayHAT Mini companion that shows what the agent is doing and lets you approve or reject actions with physical A/B buttons.

## What It Does

- **State display**: Automatically sends agent state changes (processing, communicating, sleeping) to Snarling's display
- **Physical approvals**: Registers a `request_user_approval` tool that routes yes/no decisions to Snarling's A/B buttons
- **Approval tracking**: Counts approval lifecycle events (requested, approved, rejected, timed out, errored)

## Installation

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

### Prerequisites

- [Snarling](https://github.com/snarflakes/snarling) running on a Raspberry Pi with DisplayHAT Mini (state + approval server on port 5000)
- OpenClaw gateway >= 2026.3.24-beta.2

## Configuration

No config needed for the default Snarling setup. The plugin works out of the box.

### Custom Targets

To use a custom interaction surface (Tauri app, mobile web view, etc.), edit the constants at the top of `index.ts`:

```typescript
const SNARLING_URL = "http://localhost:5000/state";    // → your state endpoint
const CALLBACK_BASE_URL = "http://localhost:18789";    // → your callback base URL
```

The approval secret is set via `OPENCLAW_APPROVAL_SECRET` env var. If not set, a random UUID is generated on each startup. The secret must be included in the JSON body of callback requests (not query params — the gateway strips those).

No config file yet — when there are multiple adapters, a config-driven system will make sense. For now, editing the source is honest and simple.

## How It Works

### State Updates

The plugin hooks into OpenClaw events and POSTs state to Snarling:

| OpenClaw Event | Snarling State | Meaning |
|---|---|---|
| `before_tool_call` | `processing` | Agent is using tools |
| `before_agent_reply` | `communicating` | Agent is generating a response |
| `agent_end` | `sleeping` | Agent finished its turn |
| 10s idle timeout | `sleeping` | No recent activity |

Duplicates are suppressed — only state *changes* are sent.

### Approval Flow

When the agent calls `request_user_approval`:

1. Plugin creates a TaskFlow and sets it to waiting state
2. POSTs approval request directly to Snarling on port 5000 (`/approval/alert`) — no middleman
3. Snarling displays the request on screen with A/B button prompt
4. User presses A (approve) or B (reject)
5. Snarling forwards the decision to the plugin's `/approval-callback` HTTP route
6. Plugin resumes the TaskFlow and enqueues a system event to wake the agent
7. Snarling also sends a WebSocket RPC wake to bypass the gateway's `requests-in-flight` check

Only one approval at a time — subsequent requests are blocked until the current one is resolved (with a 30-minute stale timeout as a safety net).

### Approval Tracker

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

Returns: `{"stats":{"requested":2,"approved":1,"rejected":1,"timedOut":0,"errored":0}}`

Stats are in-memory only — they reset on gateway restart.

## Architecture

```
OpenClaw Agent
      ↓ (plugin hooks: before_tool_call, before_agent_reply, agent_end)
Interaction Bridge Plugin
      ↓ (POST localhost:5000/state)            ← state updates
      ↓ (POST localhost:5000/approval/alert)   ← approval requests (direct, no middleman)
      ↑ (POST localhost:18789/approval-callback) ← approval responses
Snarling Display (Python service on port 5000)
      ↓ (WebSocket RPC wake)                   ← bypasses gateway requests-in-flight
```

No approval_server middleman — the plugin talks directly to Snarling. Snarling resolves approvals via its A/B buttons and POSTs the result back to the gateway.

## Install from ClawHub

```bash
openclaw plugins install clawhub:@snarflakes/openclaw-interaction-bridge
```

## Development

```bash
git checkout development
# make changes
git add .
git commit -m "feat: description"
git push origin development
```

## Credits

Built by [Snar](https://github.com/snarflakes) for the OpenClaw ecosystem.
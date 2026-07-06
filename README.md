# OpenClaw Interaction Bridge

A plugin that bridges OpenClaw agent activity to any external program! [Snarling](https://github.com/snarflakes/snarling) for example — a Raspberry Pi + DisplayHAT Mini companion that shows what the agent is doing and lets you approve or reject actions with physical A/B buttons and lets agents send notifications with a feedback loop for attunement!

## ⚠️ Optional Config (OpenClaw 2026.4.26+)

For optional status update functionality, you must add `hooks.allowConversationAccess: true` to the plugin config entry. This is required due to permissions changes in version 2026.4.26. No conversation data is read, only state tracking for status updates.

```json
{
  "plugins": {
    "entries": {
      "openclaw-interaction-bridge": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

Without this setting, the `agent_end` hook is silently blocked and the display won't transition to sleeping. Approvals and notifications still work regardless.

## What It Does

- **State display**: Automatically sends agent state changes (processing, communicating, sleeping) to Snarling's display
- **Physical approvals**: Registers a `request_user_approval` tool that routes yes/no decisions to Snarling's A/B buttons
- **Notifications**: Registers a `send_notification` tool that sends alerts to the display with priority-based timeouts and full two-way feedback
- **Notification feedback**: Receives callback data from Snarling (revealed, dismissed, timed out) with timing metrics, enabling notification attunement
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

### Notification Flow

When the agent calls `send_notification`:

1. Plugin creates a TaskFlow and sets it to waiting state
2. POSTs notification to Snarling on port 5000 (`/approval/alert`) with `type: "notification"`
3. Snarling displays the notification on screen with priority-based face and banner behavior
4. User interacts: A press reveals text, B press dismisses, or low-priority auto-dismisses after timeout
5. Snarling forwards feedback (revealed/dismissed/timed out + timing) to the plugin's `/notification-callback` HTTP route
6. Plugin resumes the TaskFlow and enqueues a system event to wake the agent
7. Snarling also sends a WebSocket RPC wake to bypass the gateway's `requests-in-flight` check

If TaskFlow is unavailable, the notification degrades to fire-and-forget (no feedback).

Parameters:
- `message` (required) — the notification text
- `priority` (optional) — "low", "normal" (default), or "high"
- `duration` (optional) — seconds before auto-clear (default: 0, which means Snarling decides based on priority)

The notification payload sent to Snarling:
```json
{
  "type": "notification",
  "message": "Stove's been on 20 min",
  "priority": "high",
  "duration": 0,
  "notification_id": "notify-1234567890-abc",
  "callback_url": "http://localhost:18789/notification-callback",
  "session_key": "agent:main:main",
  "secret": "uuid"
}
```

The feedback payload received from Snarling:
```json
{
  "notification_id": "notify-1234567890-abc",
  "revealed": true,
  "time_to_reveal_sec": 42.5,
  "dismissed": false,
  "timed_out": false,
  "secret": "uuid",
  "sessionKey": "agent:main:main"
}
```

`time_to_reveal_sec` measures total time from when the notification was sent to when the user interacted with it — including any time spent queued behind other notifications.

#### Priority-Based Timeout Behavior

| Priority | Default Timeout | Behavior |
|----------|----------------|----------|
| **high** | None (0) | Stays until user interacts — never auto-dismisses |
| **normal** | None (0) | Stays until user interacts — never auto-dismisses |
| **low** | 28800s (8h) | Auto-dismisses after timeout, sends `timed_out` feedback |

The plugin sends `duration: 0` by default, letting Snarling decide based on priority. No urgent or moderate notification should ever just disappear.

#### Notification Attunement

The feedback loop enables **notification attunement** — the agent learning when and how to reach out effectively. Each notification generates a data point: was it revealed (and how quickly), dismissed without reading, or timed out? Over time, the agent adjusts notification behavior based on what works.

See [NOTIFICATION_POLICY.md](https://github.com/snarflakes/openclaw-interaction-bridge/blob/main/NOTIFICATION_POLICY.md) for the attunement framework details.

### Approval Tracker

The plugin tracks approval and notification lifecycle counts in memory:

| Counter | When it increments |
|---|---|
| `requested` | Every time `request_user_approval` is called |
| `approved` | Callback resolved as approved |
| `rejected` | Callback resolved as rejected |
| `timedOut` | Stale lock cleared after 30min timeout |
| `errored` | Snarling notification POST failed |

Notification stats:

| Counter | When it increments |
|---|---|
| `sent` | Every time `send_notification` is called |
| `revealed` | User pressed A to reveal notification text |
| `dismissed` | User pressed B to dismiss without reading |
| `timedOut` | Low-priority notification auto-dismissed |
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
      ↓ (POST localhost:5000/state)               ← state updates
      ↓ (POST localhost:5000/approval/alert)      ← approval requests
      ↓ (POST localhost:5000/approval/alert)       ← notification requests (type: "notification")
      ↑ (POST localhost:18789/approval-callback)   ← approval responses
      ↑ (POST localhost:18789/notification-callback) ← notification feedback (revealed/dismissed/timed out)
      ↑ (POST localhost:18789/environmental-event)  ← thermal/presence events from snarling
Snarling Display (Python service on port 5000)
      ↓ (WebSocket RPC wake)                        ← bypasses gateway requests-in-flight
```

No approval_server middleman — the plugin talks directly to Snarling. Snarling resolves approvals and notifications via its A/B buttons and POSTs the result back to the gateway.

### Environmental Events (V2 Protocol)

The plugin receives presence and observation data from Snarling's thermal/environmental system via a `POST /environmental-event` route. This replaces the old V1 event types (`presence_change`, `presence_settled`) with a unified `observation_report` type.

**V2 event format:**
```json
{
  "type": "observation_report",
  "trigger_reason": "presence_settled" | "scheduled" | "startup",
  "present": true,
  "absent_duration": "2h 15m",
  "world_state": { "source_count": 3 },
  "changes_since_last": {
    "appeared": { "sensor_1": { ... } },
    "disappeared": { ... },
    "changed": { ... }
  }
}
```

**Trigger reasons:**
- `presence_settled` — thermal sensor confirmed someone arrived/stayed (was V1's `presence_settled` event)
- `scheduled` — 30-minute periodic observation tick
- `startup` — first observation after service start

**V1 backwards compatibility:** The plugin still handles V1 events for transition:
- `presence_change` → formatted as a simple presence update (doesn't wake agent)
- `presence_settled` (without `trigger_reason`) → treated as `observation_report` with `trigger_reason: "presence_settled"`

**Wake behavior:** Only `observation_report` and V1 `presence_settled` wake the agent. `presence_change` is acknowledged but doesn't wake. A 5-second dedup window prevents double-wakes from V1/V2 overlap.

**Event delivery:** Wake events are delivered via `subagent.run`, which creates a real agent turn in the target session. This ensures events actually reach the agent even when its session is idle or recently completed. If `subagent.run` is unavailable, the plugin falls back to `enqueueSystemEvent` + a 300ms-delayed `runHeartbeatOnce` (note: this fallback is lossy — events can be silently dropped when the target session is `done`).

**Configuration:** Set `presenceTarget` in plugin config to route events to a specific agent (default: `main`). The session key is constructed as `agent:{presenceTarget}:main`.

**Migration note:** Once Snarling is fully on V2, the V1 compat paths can be removed. During transition, both `observation_report` (V2) and `presence_settled` (V1) will wake the agent for the same semantic event — the dedup window prevents double-waking.

### Environmental Event Flow

Snarling POSTs thermal/presence events to the plugin's `/environmental-event` HTTP route. The plugin formats them into system events and routes them to the **configured target agent** (default: `main`, configurable via `presenceTarget` plugin config).

**Event routing:** The bridge reads `presenceTarget` from plugin config. If set to `environmental`, events route to `agent:environmental:main` — the dedicated environmental agent session. If unset or `main`, events route to the main agent session.

```json
// Plugin config example
{ "presenceTarget": "environmental" }
```

This is how environmental events reach the environmental agent instead of the main agent — no hardcoded routing, just a config value.

**Event types (V2, current):**

| Event Type | When | Wake Agent? | Delivery Method | Payload |
|---|---|---|---|---|
| `observation_report` | Presence settled, periodic check, or startup | Yes | `subagent.run` (fallback: `enqueueSystemEvent`) | `trigger_reason`, `world_state`, `changes_since_last` |
| `presence_change` | Human arrived or left | No | `enqueueSystemEvent` only | `present`, `absent_duration` |

Only `observation_report` events wake the agent via `subagent.run` — this covers both arrivals (`presence_settled`) and periodic check-ins (`scheduled`). `presence_change` events (raw presence flips) are too frequent to warrant waking the agent and are enqueued for the next heartbeat instead.

**Why `subagent.run` instead of `enqueueSystemEvent`:** The old `enqueueSystemEvent` + `runHeartbeatOnce` delivery path silently drops events when the target agent session is in `done` state. `subagent.run` creates a real agent turn that executes regardless of session state, ensuring events are always delivered. This is the same fix applied to the voice bridge for the same bug (#86090).

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
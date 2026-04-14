# OpenClaw Interaction Bridge

A plugin that bridges OpenClaw agent activity to an endpoint of your choice — demo with [Snarling](https://github.com/snarflakes/snarling), a physical status and request approval companion with a DisplayHAT Mini screen and buttons.

## What It Does

- **State tracking**: Automatically sends agent state changes (processing, communicating, sleeping) to a configured endpoint
- **Physical approvals**: Registers a `request_user_approval` tool that routes approval requests to a configured endpoint — demo with Snarling's A/B buttons

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

- [Snarling](https://github.com/snarflakes/snarling) running on a Raspberry Pi with DisplayHAT Mini (state server on port 5000, approval server on port 5001)
- OpenClaw gateway >= 2026.3.24-beta.2

## Configuration

No config needed for the default Snarling setup. The plugin works out of the box with Snarling's default ports.

### Custom URLs Without Config (Simple Approach)

Right now, there's no setup wizard, no config UI, and `openclaw.json` doesn't have special handling for plugin-specific fields. Editing `openclaw.json` by hand to add adapter config is the same amount of work as editing the URL constants directly in the plugin code.

**To use a custom target (Tauri, mobile web, phone, etc.) right now, just edit the constants at the top of `index.ts`:**

```typescript
// Change these to point to your own interaction surface
const SNARLING_URL = "http://localhost:5000/state"; // → your state endpoint
const APPROVAL_URL = "http://localhost:5001/approval/request"; // → your approval endpoint
const CALLBACK_URL = "http://localhost:18789/approval-callback"; // → your callback endpoint
```

The adapter architecture (config-driven selection, `openclaw.json` entries, setup wizard) will be worth building when there are actually multiple adapters to choose from. Until then, editing the source is honest and simple — same effort as editing a config file, but no indirection.

## How It Works

### State Updates

The plugin hooks into OpenClaw events and POSTs state to Snarling:

| OpenClaw Event | Snarling State | Meaning |
|----------------|----------------|---------|
| `before_tool_call` | `processing` | Agent is using tools |
| `before_agent_reply` | `communicating` | Agent is generating a response |
| 30s idle timeout | `sleeping` | No recent activity |

Each update includes:
- `state`: processing, communicating, or sleeping
- `timestamp`: Unix timestamp (ms)

### Approval Flow

When the agent calls `request_user_approval`:

1. Plugin creates a TaskFlow and sets it to waiting state
2. POSTs approval request to Snarling's approval server (port 5001)
3. Snarling displays the request on screen with A/B button prompt
4. User presses A (approve) or B (reject)
5. Snarling forwards the decision to the plugin's `/approval-callback` HTTP route
6. Plugin resumes the TaskFlow and returns the result to the agent

Only one approval at a time — subsequent requests are blocked until the current one is resolved (with a 30-minute stale timeout as a safety net).

## Architecture

```
OpenClaw Agent
      ↓ (plugin hooks: before_tool_call, before_agent_reply)
Interaction Bridge Plugin
      ↓ (POST localhost:5000/state)           ← state updates
      ↓ (POST localhost:5001/approval/request) ← approval requests
      ↑ (POST localhost:18789/approval-callback) ← approval responses
Snarling Display (Python services on ports 5000/5001)
```

## Install from ClawHub

```bash
openclaw plugins install clawhub:@snarflakes/openclaw-interaction-bridge
```

## Development

```bash
git checkout development
# make changes
git add .
git commit -m "feature: description"
git push origin development
```

## Credits

Built by [Snar](https://github.com/snarflakes) for the OpenClaw ecosystem.
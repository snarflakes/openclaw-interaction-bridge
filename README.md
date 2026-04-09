# OpenClaw Interaction Bridge

A plugin that bridges OpenClaw agent activity to external displays — like [Snarling](https://github.com/snarflakes/snarling), a physical status companion.

## What It Does

This plugin automatically tracks your OpenClaw agent's activity and reports state changes to a configured endpoint. This enables external displays to show real-time status without manual updates.

## Installation

```bash
# Clone to your OpenClaw extensions directory
git clone https://github.com/snarflakes/openclaw-interaction-bridge.git \
  ~/.openclaw/extensions/openclaw-interaction-bridge

# Restart OpenClaw or reload plugins
openclaw plugin openclaw-interaction-bridge enable
```

## Configuration

By default, the plugin POSTs to Mission Control at `http://localhost:3000/api/status`.

To change the endpoint, edit `index.ts`:

```typescript
const MISSION_CONTROL_URL = "http://your-host:3000/api/status";
```

Or for file-based output (no Mission Control):

```typescript
const STATE_FILE_PATH = "/home/pi/snarling/state.json";
```

## How It Works

The plugin hooks into OpenClaw events:

| Event | Status Sent | Typical Duration |
|-------|-------------|----------------|
| `before_tool_call` | `processing` | While tools run |
| `before_agent_reply` | `speaking` | While generating response |
| 30s idle timeout | `idle` | Until next activity |

Each status update includes:
- `status`: idle, processing, or speaking
- `sessionId`: Current session identifier
- `timestamp`: Unix timestamp (ms)

## Example Implementation: Snarling

[Snarling](https://github.com/snarflakes/snarling) is a Raspberry Pi-powered display that shows your agent's status at a glance.

**Setup flow:**
1. Install this plugin in OpenClaw
2. Install Snarling on a Raspberry Pi with display
3. Configure Snarling to poll `http://your-pi-ip:3000/api/status`
4. Done — your agent's status appears on the physical display

See the Snarling repo for hardware build instructions and service setup.

## Agent Prompt

Feed this prompt to your agent to enable the bridge:

```
You are now running with the OpenClaw Interaction Bridge plugin enabled.

## What's Already Set Up

- Interaction Bridge plugin installed at `~/.openclaw/extensions/openclaw-interaction-bridge`
- Snarling display hardware ready and polling for status
- Mission Control API running at `http://localhost:3000/api/status`

## What Happens Automatically

The bridge watches your OpenClaw activity and reports state changes:

| Event | Status Sent | Snarling Shows |
|-------|-------------|----------------|
| You start using tools | `processing` | Working indicator |
| You begin replying | `speaking` | Active/talking |
| 30 seconds idle | `idle` | Resting state |

## For Users WITH Mission Control

Snarling should poll: `http://your-pi-ip:3000/api/status`

Mission Control handles the state file and serves it to Snarling.

## For Users WITHOUT Mission Control

If you don't have Mission Control running, configure the bridge to write 
directly to Snarling's state file:

Edit `~/.openclaw/extensions/openclaw-interaction-bridge/index.ts`:

Change:
  const MISSION_CONTROL_URL = "http://localhost:3000/api/status"

To:
  const STATE_FILE_PATH = "/home/pi/snarling/state.json"

Then modify `updateState()` to write JSON to that file instead of HTTP POST.

Snarling will read the local file directly.

## Verify It's Working

Check Snarling display updates when you:
- Run a tool (shows "processing")
- Generate a response (shows "speaking")
- Wait 30 seconds (shows "idle")
```

## Development

```bash
git checkout development
git add .
git commit -m "feature: description"
git push origin development
```

## Architecture

```
OpenClaw Agent
      ↓ (plugin hooks)
Interaction Bridge
      ↓ (POST or file write)
Mission Control API / State File
      ↓ (HTTP poll or file read)
External Display (Snarling, etc.)
```

## Credits

Built by Snar for the OpenClaw ecosystem. Inspired by the Pwnagotchi project's approach to ambient companion devices.

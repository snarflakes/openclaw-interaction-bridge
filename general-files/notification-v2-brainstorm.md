# Notification V2 Brainstorm

> Future implementation notes for two-layer notification feedback in the OpenClaw Interaction Bridge + Snarling.

## Problem with V1

Current feedback is binary and ambiguous:

| Feedback | Current Meaning | Problem |
|---|---|---|
| `revealed` (A press) | User read the notification | Positive signal — but no opinion on the *content* |
| `dismissed` (B press, no read) | User dismissed without reading | Weak negative, but ambiguous — could be "don't care" or "too busy" or "wrong priority" |
| `timed_out` | Auto-dismissed after timeout | **Not a strong negative** — user might have just been too busy to reveal, not uninterested |

The key insight: **the second press already exists**. Snarling already requires A or B to clear a revealed notification (stop the text from scrolling). That second press just isn't semantically used yet — it's purely "dismiss display" with no feedback meaning.

## V2: Two-Layer Feedback

Assign meaning to the second press that's already happening:

### Flow

1. **B first** → immediate dismiss (no read) → send `dismissed` — weak negative, "didn't care to read"
2. **A first** → reveal text → user reads it
3. **A again** (after reading) → clear notification + send `acknowledged: true` — "read it, fine/useful"
4. **B after reveal** → clear notification + send `acknowledged: false` — "read it, waste of time"

### State Machine

```
queued → revealed → {acknowledged | rejected}
queued → dismissed (no read)
queued → timed_out (low priority auto-dismiss)
```

V1 state machine was: `queued → revealed ✓` (callback on reveal, done).

V2 delays the callback until the **second press** (the clear press), which includes an `acknowledged` boolean.

### Feedback Payload (V2)

```json
{
  "notification_id": "notify-1234567890-abc",
  "revealed": true,
  "acknowledged": true,
  "time_to_reveal_sec": 12.5,
  "time_to_acknowledge_sec": 45.0,
  "dismissed": false,
  "timed_out": false,
  "present": true
}
```

| Field | Type | Meaning |
|---|---|---|
| `revealed` | boolean | Did the user press A to read the text? |
| `acknowledged` | boolean \| null | After reading, was the notification useful? `true` = A again (fine), `false` = B (waste of time), `null` = not applicable (dismissed/timed out) |
| `time_to_reveal_sec` | float | Seconds from send to first A press |
| `time_to_acknowledge_sec` | float \| null | Seconds from reveal to second press (clear). Null if not revealed. |
| `dismissed` | boolean | Did user B-press without reading? |
| `timed_out` | boolean | Did the notification auto-dismiss? Not a strong negative — user may have been too busy. |

### Feedback Interpretation

| Outcome | Signal | Attunement Meaning |
|---|---|---|
| A → A (acknowledged) | Strong positive | This type of notification is useful, keep sending |
| A → B (rejected) | Strong negative | Read it, but waste of time — adjust type/priority/content |
| B (dismissed, no read) | Weak negative | Didn't care to read — ambiguous, could be busy |
| timed out | Ambiguous neutral | User may have been busy, not necessarily uninterested |

## Implementation Changes

### Snarling (Python)

- **Delay callback until second press** — currently sends callback on first A press (reveal). V2 sends callback on second press (clear).
- First A press still reveals the text. Second press determines `acknowledged` value and sends the callback.
- B press without A still sends `dismissed` callback immediately (no change from V1).
- Timeout still sends `timed_out` callback (no change from V1).
- Add `time_to_acknowledge_sec` to the callback payload.
- Add `acknowledged` field to the callback payload.

### Interaction Bridge Plugin (TypeScript)

- Update `notification-callback` handler to parse `acknowledged` and `time_to_acknowledge_sec` fields.
- Update `resumeNotificationFlow` to pass new fields through to the agent.
- Update feedback system event to include `acknowledged` and `time_to_acknowledge_sec`.

### Notification Stats

Add counters:

| Counter | When it increments |
|---|---|
| `acknowledged` | User pressed A after reading (useful notification) |
| `rejected` | User pressed B after reading (waste of time) |

## Open Questions

- Should `time_to_acknowledge_sec` include queue time or just time from reveal to second press? (Currently thinking: just reveal → second press, since queue time is already captured in `time_to_reveal_sec`)
- Should we track "time reading" separately (reveal → clear) as a proxy for how carefully someone read it?
- How should attunement weight `acknowledged: true` vs `acknowledged: false` for adjusting future notification behavior?
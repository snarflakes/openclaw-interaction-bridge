// ~/.openclaw/extensions/openclaw-interaction-bridge/index.ts
// OpenClaw Interaction Bridge Plugin - Updates mission-control API with agent state

const MISSION_CONTROL_URL = "http://localhost:3000/api/status";
let idleTimeout: ReturnType<typeof setTimeout> | null = null;
const IDLE_DELAY_MS = 30000;

async function updateState(status: string, sessionId: string) {
  try {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
      idleTimeout = null;
    }

    void fetch(MISSION_CONTROL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, sessionId, timestamp: Date.now() })
    });

    // Set idle timeout for both processing and speaking states
    if (status === "processing" || status === "speaking") {
      idleTimeout = setTimeout(() => {
        void fetch(MISSION_CONTROL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "idle", sessionId, timestamp: Date.now() })
        });
      }, IDLE_DELAY_MS);
    }
  } catch (e) {
    // Silent fail
  }
}

export default {
  id: "openclaw-interaction-bridge",
  name: "OpenClaw Interaction Bridge",

  register(api: any) {
    api.on("before_tool_call", (event: any) => {
      updateState("processing", event.sessionKey);
    });

    api.on("before_agent_reply", (event: any) => {
      updateState("speaking", event.sessionKey);
    });
  }
};

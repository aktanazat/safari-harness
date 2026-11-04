export default function (pi) {
  const disableTools = () => pi.setActiveTools([]);
  pi.on("session_start", disableTools);
  pi.on("before_agent_start", disableTools);
  pi.on("tool_call", () => ({ block: true, reason: "Safari authoring actions must pass through the harness" }));
}

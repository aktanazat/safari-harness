// Tools that run in the calling process (the MCP server or the CLI), not in
// the daemon. The daemon runs under launchd without the terminal's
// permissions; the caller inherits them: Full Disk Access for Messages and
// Safari history, Accessibility for real mouse and keyboard input.

import type { Tool } from "./tools.ts";
import { IMESSAGE_TOOLS } from "./imessage.ts";

// Each group's label prefixes its tools' descriptions: "[Messages] ...".
export const CALLER_GROUPS: { label: string; tools: Record<string, Tool> }[] = [
  { label: "Messages", tools: IMESSAGE_TOOLS },
];

export const CALLER_TOOLS: Record<string, Tool> = Object.fromEntries(CALLER_GROUPS.flatMap((g) => Object.entries(g.tools)));

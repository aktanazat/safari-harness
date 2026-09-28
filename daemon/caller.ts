// Tools that run in the calling process (the MCP server or the CLI), not in
// the daemon. The daemon runs under launchd without the terminal's
// permissions; the caller inherits them: Full Disk Access for Messages,
// Contacts, and Safari history, Accessibility for real mouse and keyboard
// input, and the environment a Bitwarden vault is unlocked in. handoff's
// caller half and ask run here too.

import type { Tool } from "./tools.ts";
import { IMESSAGE_TOOLS } from "./imessage.ts";
import { HISTORY_TOOLS } from "./safari-history.ts";
import { INPUT_TOOLS } from "./input.ts";
import { FILL_TOOLS } from "./fill.ts";
import { HANDOFF_TOOLS } from "./handoff.ts";
import { ASK_TOOLS } from "./ask.ts";

// Each group's label prefixes its tools' descriptions: "[Messages] ...".
export const CALLER_GROUPS: { label: string; tools: Record<string, Tool> }[] = [
  { label: "Messages", tools: IMESSAGE_TOOLS },
  { label: "Safari", tools: HISTORY_TOOLS },
  { label: "Safari", tools: INPUT_TOOLS },
  { label: "Safari", tools: FILL_TOOLS },
  { label: "Safari", tools: HANDOFF_TOOLS },
  { label: "Safari", tools: ASK_TOOLS },
];

export const CALLER_TOOLS: Record<string, Tool> = Object.fromEntries(CALLER_GROUPS.flatMap((g) => Object.entries(g.tools)));

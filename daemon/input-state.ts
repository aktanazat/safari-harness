import { bridge } from "./bridge.ts";
import { HarnessError } from "./failures.ts";
import type { Tool } from "./tools.ts";

export type InputState = { marks: number; focus: boolean };
type ReadInputState = (tab: number, frame: number, options: { focus: boolean; after: number; ms: number }) => Promise<unknown>;
const isolatedState: ReadInputState = (tab, frame, options) => bridge.tab(tab, "inputState", [options], options.ms + 1000, frame);
const FIELDS: Record<string, true> = { tab: true, frame: true, focus: true, after: true, ms: true };

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HarnessError("invalid_argument", `${name} must be an integer from ${minimum} to ${maximum}`, { effect: "none" });
  }
  return value;
}

export function inputStateTool(read: ReadInputState = isolatedState): Tool {
  return {
    desc: "Read only trusted native-input completion count and page focus.",
    hidden: true,
    params: {
      tab: { type: "number", description: "resolved tab id" },
      frame: { type: "number", description: "frame id, default zero" },
      focus: { type: "boolean", description: "wait for keyboard focus too" },
      after: { type: "number", description: "completion count to exceed, or minus one" },
      ms: { type: "number", description: "maximum wait, zero to 3000 ms" },
    },
    required: ["tab", "focus", "after", "ms"],
    run: async (args) => {
      for (const name of Object.keys(args)) {
        if (!Object.hasOwn(FIELDS, name)) throw new HarnessError("invalid_argument", `input_state does not accept ${name}`, { effect: "none" });
      }
      const tab = integer(args.tab, "tab", 0, Number.MAX_SAFE_INTEGER);
      const frame = integer(args.frame ?? 0, "frame", 0, Number.MAX_SAFE_INTEGER);
      const after = integer(args.after, "after", -1, Number.MAX_SAFE_INTEGER);
      const ms = integer(args.ms, "ms", 0, 3000);
      if (typeof args.focus !== "boolean") throw new HarnessError("invalid_argument", "focus must be a boolean", { effect: "none" });
      const raw = await read(tab, frame, { focus: args.focus, after, ms });
      if (!raw || typeof raw !== "object"
        || !("marks" in raw) || typeof raw.marks !== "number" || !Number.isSafeInteger(raw.marks) || raw.marks < 0
        || !("focus" in raw) || typeof raw.focus !== "boolean") {
        throw new HarnessError("unavailable", "the page did not report its native input state", { effect: "none" });
      }
      return { marks: raw.marks, focus: raw.focus };
    },
  };
}

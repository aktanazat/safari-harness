// ask: an agent's question to the user. Away from the Mac (as handoff
// measures it), it goes to his phone on Telegram, where he reads it but
// cannot answer: his replies there reach the Hermes bot, not the agent. He
// answers in the agent's own chat once he is back. At the Mac nothing is
// sent: the agent asks in its own chat, where he is.

import { alert, isAway } from "./phone.ts";
import type { Tool } from "./tools.ts";

type Asked = { sent: true; hint: string } | { atMac: true; hint: string };

async function ask(question: string): Promise<Asked> {
  if (!(await isAway())) return { atMac: true, hint: "the user is at the Mac: ask in your own chat; nothing was sent" };
  await alert(`${process.env.SAFARI_HARNESS_AWAY === "1" ? "test of the question alert: " : ""}an agent asks: ${question} answer it in the agent's chat on your mac.`);
  return { sent: true, hint: "the question is on his phone, where he cannot answer it: ask it in your own chat too, and he answers there once he is back at the Mac" };
}

export const ASK_TOOLS: Record<string, Tool> = {
  ask: {
    desc: "Ask the user a question only he can answer. Away from the Mac, it goes to his phone, where he reads it but cannot answer: ask in your chat too, where he answers once back. At the Mac, sends nothing (atMac): ask in your chat.",
    params: { question: { type: "string", description: "one short line" } },
    required: ["question"],
    run: async (a) => {
      if (typeof a.question !== "string" || !a.question.trim()) throw new Error("question must be a line of text");
      return ask(a.question.trim());
    },
  },
};

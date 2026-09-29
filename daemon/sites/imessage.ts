// The REPL's imessage global: the helper's own Messages tools under the
// names the other site globals use. Reading needs the calling terminal's
// Full Disk Access; send returns a draft until the owner approves it.

import type { SiteKit } from "./kit.ts";

export function imessage(kit: SiteKit) {
  const call = (tool: string, args: Record<string, unknown>) => kit.invoke(tool, args);
  return {
    listChats: (opts: { limit?: number } = {}) => call("imessage_chats", { limit: opts.limit }),
    getHistory: (chat: string, opts: { limit?: number; since?: number } = {}) => call("imessage_history", { chat, limit: opts.limit, since: opts.since }),
    search: (text?: string, opts: { from?: string; days?: number; limit?: number } = {}) => call("imessage_search", { text, from: opts.from, days: opts.days, limit: opts.limit }),
    contacts: (name: string) => call("contacts", { name }),
    waitForCode: (opts: { seconds?: number; since?: number } = {}) => call("imessage_wait_code", { seconds: opts.seconds, since: opts.since }),
    send: (to: string, text: string, opts: { files?: string[]; approved?: boolean } = {}) => call("imessage_send", { to, text, files: opts.files, approved: opts.approved === true }),
  };
}

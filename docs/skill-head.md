---
name: browser
description: Browser work needing JavaScript, the owner's logins, clicks, forms, scraping or multi-step flows; his logged-in sites (Gmail, Slack, Notion, Google Docs, X, LinkedIn, YouTube, cloud consoles); engram or browser history context; iMessage reads, texts and sign-in codes; scheduled browser routines.
---

This skill is the card `browser guide` prints: do not run bare `browser guide`, and do not reread it after a compaction. A brief for another agent says "read skill://browser".

Page work goes through the browser MCP tools (`open`, `snapshot`, `map`, `repl`, ...). Code with quotes or several lines goes in a file written in the same message: `repl {file}` and `eval {tab, file}` take its absolute path, never code escaped into JSON. The `browser` CLI is for `guide`, `doctor`, `--help`, `routine`, `do`, and programs that cannot call the tools (`browser eval --file path --tab N`, `browser repl --file path`). Missing `browser`: `bun ~/.local/share/browser-harness/current/cli/browser.ts`; diagnose from that release's source, not a checkout.


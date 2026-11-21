---
name: safari
description: Browser work needing JavaScript, the owner's logins, clicks, forms, scraping or multi-step flows; his logged-in sites (Gmail, Slack, Notion, Google Docs, X, LinkedIn, YouTube, cloud consoles); engram or Safari history context; iMessage reads, texts and sign-in codes; scheduled browser routines.
---

This skill is the card `safari guide` prints: do not run bare `safari guide`, and do not reread it after a compaction. A brief for another agent says "read skill://safari".

Page work goes through the safari MCP tools (`open`, `snapshot`, `map`, `repl`, ...). Code with quotes or several lines goes in a file written in the same message: `repl {file}` and `eval {tab, file}` take its absolute path, never code escaped into JSON. The `safari` CLI is for `guide`, `doctor`, `--help`, `routine`, `do`, and programs that cannot call the tools (`safari eval --file path --tab N`, `safari repl --file path`). Missing `safari`: `bun ~/.local/share/safari-harness/current/cli/safari.ts`; diagnose from that release's source, not a checkout.


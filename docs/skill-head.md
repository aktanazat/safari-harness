---
name: safari
description: Read for any browser work that needs javascript, the owner's login state, clicks, forms, scraping, or multi-step flows; for his logged-in sites (Gmail, Slack, Notion, Google Docs and Sheets, X, LinkedIn, YouTube, cloud consoles); for personal context from his engram memory or Safari browsing history; for iMessage reads, texts, and sign-in codes sent by text; and for scheduled browser automations (routines) that run in Safari.
---

This skill is the card `safari guide` prints: you have it, so do not run
bare `safari guide`. A brief for another agent says "read skill://safari".

Page work goes through the safari MCP tools (`open`, `snapshot`, `map`,
`repl`, ...). Code with quotes or several lines goes in a file, written in
the same message: `repl {file}` and `eval {tab, file}` take its absolute
path, never code escaped into JSON. The `safari` CLI is for `guide`,
`doctor`, `--help`, `routine`, `do`, and for programs that cannot call the
tools (`safari eval --file path --tab N`, `safari repl --file path`). If
`safari` is not found, it is `bun ~/.local/share/safari-harness/current/cli/safari.ts`.
`~/.local/share/safari-harness/current` is the release that runs: read
its source, not a checkout, when you diagnose.


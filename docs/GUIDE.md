# Safari Harness

Safari Harness drives the user's real Safari: his logins, cookies, and open
windows. A Safari extension talks to a local daemon; every tool below goes
through that daemon.

Three ways in:

- **omp tools (recommended).** In omp the tools appear as `safari` MCP tools
  (`tabs`, `open`, `snapshot`, `click`, ...). The omp model does the thinking.
- **CLI.** `safari <command>` runs one tool and prints JSON. Good for scripts and
  quick checks. `safari --help` lists every command.
- **Routines.** A saved task plus a schedule, run unattended by headless omp
  with the same tools. See "Routines" below.

Check health first: `safari status` must show `"extension"` as an object, not
`null`. If it is `null`, see "Troubleshooting".

## Tabs: work in your own tab

Safari is the user's everyday browser, so treat his tabs as his.

- Start with `open <url>`. It returns the new tab's `id`. Pass that `tab` to
  every later call. A call without `tab` acts on the front tab, which is
  usually the user's.
- Close your tab with `close` when the task ends, on success or failure.
- Use `tabs` when the user refers to a page he already has open. Read that tab,
  but do not navigate it, type into it, or close it unless he asked.
- `open` with `background: true` keeps his current tab in front.

## Reading a page

Always read with `snapshot` first.

- `snapshot` returns a compact accessibility outline. Each element you can act
  on carries a ref like `[12]`.
- Refs belong to one snapshot. After any click, typing, or navigation, take a
  new snapshot before using refs again. Never guess a ref.
- `root` (a CSS selector) narrows the snapshot to one region, such as a dialog.

Escalate in this order:

1. `snapshot`
2. `extract` for the readable text of a long page (`selector` to narrow it)
3. `shot` for visual proof. It returns a PNG path of the Safari window. It
   brings your tab to the front for a moment, then puts the user's tab back.
4. `eval` only when you know the exact expression you need

## Acting

- `click` a ref, `type` text into a ref (`append: true` keeps existing text),
  `press` a key (`Enter`, `Tab`, `Escape`, ...), `goto` a URL in your tab.
- `clickat` with x/y only when a ref cannot reach the target.
- `scroll` is rarely needed: snapshots include off-screen elements, and
  clicks scroll to their target.
- Treat an action as unconfirmed until a fresh snapshot shows the result.

## Waiting

Wait for the page, not the clock.

- `wait` with `text` or `selector` polls until it appears. `ms` is the
  timeout (default 10000, max 30000). The result says `found: true|false`.
- `open` and `goto` wait for the page to load. `click` returns as soon as the
  click lands, so after clicking a link, `wait` for text on the next page.
- `wait` with only `ms` is a plain sleep. Use it only when nothing on the page
  signals the change.

## Network and console

`net_start` then `net_read` returns the fetch/XHR requests the page made after
capture started (URL, method, status, time). `console_start` then
`console_read` does the same for console messages. Neither sees request bodies
or requests made before capture started.

## Logged-in sites and secrets

The tabs carry the user's real sessions. Never print passwords, one-time codes,
session cookies, or tokens. The `cookies` tool returns cookie values: use it
only when the task needs one, and never put the values in a reply or a file.

## Confirm before anything irreversible

Before sending a message, posting, buying, submitting a form that commits
something, or deleting anything, show the user what will happen (a snapshot or
screenshot of the filled form) and get a yes. A routine never does these
things unless its saved task explicitly says to.

## Routines

A routine is a saved task plus a schedule. launchd runs it through headless omp,
using the user's default omp model, with these same tools.

```bash
safari routine add morning-inbox --at 08:00 "Open mail.google.com, list unread emails from today with sender and subject."
safari routine add price-watch --every 60 "Check the price on https://example.com/item and say if it dropped below $50."
safari routine list
safari routine run morning-inbox      # run it now, in the foreground
safari routine remove price-watch
```

- `--at HH:MM` runs daily. `--every MIN` repeats, at least every 5 minutes.
  `--model` picks an omp model.
- The saved prompt lives in `~/.local/share/safari-harness/routines/<name>.md`.
  It is plain text you can edit. It starts with a fixed preamble: own tab,
  close it after, no irreversible actions, end with a summary.
- Each run writes its full output to
  `~/Library/Logs/safari-harness/routines/<name>-<time>.log`. `routine list`
  shows the latest run and its exit code.
- A daily routine missed while the Mac slept runs when it wakes.
- Routines need the daemon always on: `safari daemon install`.

## Limits compared to Chrome

- No `chrome.debugger`: no CPU profiling, request interception or blocking,
  or request bodies.
- Screenshots cover the whole Safari window, not a single element, and need
  Safari's window on screen (not minimized).
- No reach inside closed shadow DOM.
- One extension connection. The daemon owns it, and every client shares it.

## Troubleshooting

- `daemon not reachable`: run `safari daemon install`. Its log is at
  `~/Library/Logs/safari-harness/daemon.log`.
- `extension` is `null`: in Safari Settings, go to Extensions and turn
  "Safari Harness Bridge" off and on. It should connect within seconds.
- `extension disconnected` on every call: two copies of the app are
  registered and knock each other offline. Keep only
  `/Applications/Safari Harness.app`.
- A ref no longer works: the page changed. Take a new snapshot.

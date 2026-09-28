# safari-harness

Drive Safari from the terminal, an agent, or any Chrome-DevTools-Protocol
client — without WebKit's remote-inspection toggle.

Safari web extensions cannot use `chrome.debugger` (it does not exist there),
so this harness is built the way Safari allows: a signed Safari Web Extension
whose background page keeps a WebSocket to a local daemon. The daemon exposes
the same tool surface Aside's daemon does, plus a CDP shim and an MCP server.

## Pieces

```
extension/          Safari MV3 web extension (background page + content script)
  background.js     ws client to the daemon; tab/window/cookie ops; relays DOM
                    ops to the content script (executeScript fallback included)
  content.js        aria snapshot with [ref]s; click/type/press/select/hover/
                    upload/scroll/history on a ref, CSS selector, or visible
                    text; extract, eval, fetch/XHR/console capture, login fill
daemon/
  main.ts           ws :37333 (extension + CDP shim), http :37334 (/rpc /health)
  bridge.ts         request/response plumbing to the extension socket
  dialogs.js        page-world script: answers alerts, confirms, and prompts
                    so they never block, and catches downloads the page makes
  tools.ts          the Safari tools, each with its own input schema: run
                    (several tools in one call) tabs open close goto activate
                    snapshot click type press select hover upload history
                    scroll eval fetch download dialog extract info wait handoff net
                    console cookies shot pdf window passwords. Actions report
                    `navigated`, `newTab`, and any `dialogs`; snapshots take
                    in embedded frames
  caller.ts         tools that run in the calling process, which holds the
                    terminal's permissions (Messages, browsing history, the
                    real mouse and keyboard); a `run` with one of them runs
                    its steps from the caller too
  handoff.ts        handoff's caller half: texts the user's own phone, with a
                    picture of the page, when a step needs him and he is away
                    from the Mac; the daemon raises the tab and notifies
  pdf.ts            save a page as PDF and read PDFs, through scripts/pdfkit
  safari-history.ts browsing_history over Safari's History.db (read-only)
  challenge.ts      names a bot check (CAPTCHA or wall) from what each frame
                    shows, for challenge in results and for handoff
  input.ts          real_input: the real mouse and keyboard through
                    scripts/input, for pages that ignore scripted events
  passwords.ts      Apple Passwords: pairs with Apple's helper by the code the
                    Mac shows (SRP), then asks it for logins and verification
                    codes over AES-GCM. The helper runs only under a real
                    browser, so a hidden Helium with passwords-bridge/ relays
                    the encrypted messages. Helium and the pairing outlive a
                    daemon restart. The caller pairs with one Touch ID and
                    reads the code off the Mac's window (fill.ts)
  cdp.ts            Chrome DevTools Protocol shim (Target/Page/Runtime/Input/
                    Network/Log; unsupported methods return explicit errors)
  mcp.ts            MCP stdio server (thin client over /rpc; runs the Messages
                    tools itself)
  imessage.ts       Messages: chats, history, search, sign-in codes, contacts,
                    and draft-then-approve sending (chat.db read-only,
                    AddressBook, osascript)
  finder.ts         upload's find: Spotlight over iCloud Drive, Documents,
                    Desktop, and Downloads, returning paths, never contents
  downloads.ts      the files Safari saves to ~/Downloads while an agent's
                    click, press, or download runs
  agent.ts          tool-calling loop for `safari do` (OpenAI-compatible API;
                    gets the Messages read tools, not send)
cli/safari.ts       the `safari` command
passwords-bridge/   extension for the hidden Helium: relays between Apple's
                    helper and the daemon's /passwords socket
cli/launchd.ts      always-on daemon and scheduled routines (launchd + headless omp)
cli/doctor.ts       `safari doctor`: checks each part the harness needs on
                    this Mac and prints the fix for each that fails
docs/GUIDE.md       the short card of rules (`safari guide`)
docs/REFERENCE.md   every tool in full (`safari guide reference`)
docs/sites/         one note per site (`safari guide <site>`)
scripts/
  pdfkit.swift      helper: renders HTML to paginated PDF (WebKit) and
                    reads PDF text (PDFKit); `bun run helpers` builds it
  input.swift       helper: posts real clicks and keys (CGEvent) into
                    Safari's page area; needs Accessibility permission
  pairing.swift     helper: the Touch ID prompt, and the pairing code read
                    off Apple's window; needs Accessibility permission
  dev-install.sh    deploy a commit: make it a release, switch to it, and
                    restart only what changed (see Deploys)
  fake-extension.ts test double that speaks the extension protocol
  check-live.ts     live checks against real Safari in its own background
                    tabs (`bun run check`); includes a snapshot-size guard
  check-pairing.ts  live check that the Apple Passwords pairing survives two
                    daemon restarts (restarts the daemon; take the live lock)
Safari Harness/     Xcode project generated by safari-web-extension-converter
```

## Ports

| Port  | What |
|-------|------|
| 37333 | WebSocket: `/` extension socket, `/passwords` Apple Passwords bridge, `/devtools/browser`, `/devtools/page/<tabId>` CDP shim |
| 37334 | HTTP: `POST /rpc {tool,args}`, `GET /health`, `POST /shutdown` |

Both ports refuse any request that carries a web page's `Origin` header (403),
because a web page can send requests to localhost too. Local clients such as
the CLI, the MCP server and CDP tools send no `Origin`. Only the extension's
`safari-web-extension://` origin may take the `/` extension socket, and only
the bridge's extension origin may take `/passwords`.

Override with `SAFARI_HARNESS_WS` / `SAFARI_HARNESS_HTTP_PORT` (daemon),
`SAFARI_HARNESS_HTTP` (CLI/MCP). The extension reads `daemonPort` from
`chrome.storage.local` if you need to move it.

## Setup

1. In the checked-in Xcode project (`Safari Harness/`, generated by
   `xcrun safari-web-extension-converter`), set the development team to
   your own, and keep the bundle ids as they are, since the converter's
   default casing breaks embedding.
2. Run `scripts/dev-install.sh`. It deploys HEAD (see Deploys): it builds
   the Swift helpers and the app, installs the app over `/Applications`,
   and starts the daemon as a launchd agent that stays on (`safari serve`
   runs one in the foreground instead). Safari loads every registered copy
   of the app; two copies each open the extension socket and keep replacing
   each other, so every call fails with `extension disconnected`. The
   script leaves only the one in `/Applications` registered.
3. Launch "Safari Harness.app" once, then in Safari:
   Settings ▸ Extensions ▸ enable **Safari Harness**.
   That GUI toggle is the only manual step; no Develop-menu or
   "Allow remote automation" toggle is needed for this path (that one is
   for Apple's own `safaridriver --mcp`; see "Two lanes" in
   docs/REFERENCE.md).
4. Run `safari doctor`. It checks every part, the extension connection
   and Accessibility and Full Disk Access for your terminal included, and
   prints the fix for each that fails.

## Deploys

The harness in use runs from a release, never from this checkout.
`scripts/dev-install.sh [COMMIT]` (default HEAD) copies the commit, not the
working tree, into `~/.local/share/safari-harness/releases/<sha>` with its
built helpers, and switches `~/.local/share/safari-harness/current` to it
in one step. The daemon's launchd job, `~/.bun/bin/safari`, and omp's
safari MCP server (`mcpServers.safari.args` in `~/.omp/agent/mcp.json`) all
run from `current`, so an edit in the checkout reaches no one until it is
committed and deployed.

A deploy restarts only what changed. When the daemon's code differs from
the running daemon's (`code` in `safari status --json`), the daemon stops
taking calls, finishes the ones in flight, and exits; launchd starts the
new one, and calls made meanwhile wait for it. If the new one does not
come up, the previous release is put back. When the extension or the app
changed, the app is installed over `/Applications` and Safari reloads the
extension, which gives every tab a new id; the extension maps the ids
agents hold to the new ones. An agent session keeps its MCP server's code
until it restarts.

`scripts/dev-install.sh --rollback` goes back to the release before;
`~/.local/share/safari-harness/deploys.log` lists every deploy. The five
latest releases stay, and any that was in use in the past week.

## Use

`safari guide` is the short card of rules: tabs, sign-in, bot checks, and
waiting. `safari guide reference` covers every tool in full. The omp skill
`safari` points agents at both.

```
safari open https://example.com --bg   # prints the new tab's id, say 7
safari snapshot --tab 7                # [ref]s for click/type
safari snapshot --query price --tab 7  # only the lines that mention "price"
safari click 2 --snapshot --tab 7      # click, then print the page it led to
safari select 5 "US 8" --tab 7         # dropdown option by label
safari upload ~/photo.jpg --tab 7      # the page's file input
safari back --tab 7
safari wait --text "Welcome" --tab 7   # returns the moment it is on the page
safari extract --tab 7
safari eval "JSON.stringify(performance.timing)" --tab 7
safari net read --tab 7                # the page's requests since it loaded, with the start of each body
safari shot --out page.png --tab 7     # what the tab shows; --ref R, --annotate, --full
safari download "Export CSV" --tab 7   # the file that button makes, into ~/Downloads
safari pdf --out page.pdf --tab 7      # the page as PDF; safari pdf read file.pdf
safari fetch /api/me --tab 7           # a request with the page's cookies
safari dialog accept --tab 7           # answer confirms with OK from now on
safari window 390 844 --tab 7          # a phone-width window for your tab
safari close 7                         # else it closes once the program that opened it exits
safari open https://example.com --bg --keep  # a tab left open for the user
safari info --tab front                # the page the user has in front, when he asks
safari history-search invoice          # Safari browsing history
safari call snapshot '{"tab":7,"diff":true}'  # any tool with its MCP arguments
safari passwords --do logins --tab 7   # the same, with each argument as a flag
safari click --help                    # a command's arguments and what they take
safari do "find the price of X on example.com"
safari session list                    # agent runs; resume, steer, queue, stop, delete
safari repl "const p = await openTab('https://example.com'); console.log((await snapshot(p)).tree)"
safari repl --session work "console.log(await gmail.search(0, 'from:bank', {limit: 5}))"
safari fill address --tab 7            # name, address, email, phone from your Contacts card
safari fill login --bitwarden --tab 7  # a Bitwarden login, never printed
safari --host studio tabs              # another Mac's Safari, through ssh
safari host use studio                 # make it the default; `host use local` goes back
safari guide gusto                     # one site's note: sign-in, paths, what to confirm
safari guide repl                      # the REPL's API and recovery steps
safari imessage chats                  # recent conversations
safari imessage code                   # wait for a sign-in code by text
safari imessage send "+1…" "hi"        # prints a draft; add --approved to send
```

`safari do` defaults to local Ollama (`http://127.0.0.1:11434/v1`,
`gemma4:12b-mlx`); point it anywhere with `SAFARI_MODEL_BASE`,
`SAFARI_MODEL`, `SAFARI_MODEL_KEY`. Each run is a session kept in
`~/.local/share/safari-harness/sessions/`: `safari session steer <id>`
talks to it while it runs, `resume` goes on after it answers. Its agent can
search engram memory and read the site guides. From omp, use the MCP tools
instead.

### safari repl

A Playwright-style JavaScript session over the same tools: `openTab`,
`snapshot`, locators, downloads, `page.pdf()`, cookie-bearing `fetch`, plus
site globals that read signed-in sites through their own APIs (`slack`,
`gmail`, `googleAccounts`, `notion`, `googleDocs`, `googleSheets`,
`googleSearch`, `youtube`, `x`/`twitter`, `linkedin`, `imessage`). A named session
(`--session`) runs in its own process, reachable from any terminal or agent
through a user-only unix socket, and ends after 30 minutes unused. The MCP
server exposes it as the `repl` tool. `docs/REPL.md` is the reference.

### Another Mac

`--host <ssh-host>` (or `safari host use`) forwards a local port over ssh
to that Mac's daemon, so the daemon still listens on 127.0.0.1 only. Tools
that need Full Disk Access run on that Mac through its own CLI over ssh.

### Routines

```
safari routine add morning-inbox --at 08:00 "List today's unread Gmail senders and subjects."
safari routine list
safari routine run morning-inbox
safari routine remove morning-inbox
```

A routine is a prompt file in `~/.local/share/safari-harness/routines/` plus a
launchd agent `at.aktan.safari-harness.routine.<name>` that runs
`omp -p --auto-approve` with it. Output goes to
`~/Library/Logs/safari-harness/routines/`.

### MCP

Add to an MCP client config. `timeout` (milliseconds, where the client reads
one) lets a long call finish: `repl` runs for up to 120 s, and omp otherwise
ends every call at 30 s.

```json
{ "mcpServers": { "safari": { "command": "bun", "args": ["/path/to/safari-harness/daemon/mcp.ts"], "timeout": 130000 } } }
```

### CDP clients

Attach to `ws://127.0.0.1:37333/devtools/browser` (or a page id like
`/devtools/page/101`). A command acts on the tab its page socket or attached
session names; a browser-level command with neither is an error, never a
read of the tab the user has in front. Implemented: `Target.*`, `Page.navigate/reload/
captureScreenshot/getFrameTree/getNavigationHistory`, `Runtime.evaluate/
`Network.enable` + `Log.enable` (polled from the content-script capture, so
requests are those the page actually made after enabling; no request bodies,
no interception). Common setup calls (`DOM/CSS/Debugger/Profiler/
Performance.enable`, `Emulation.setDeviceMetricsOverride`, …) get empty
acks so clients can attach; the methods behind them, and anything else
unlisted, answer `-32000 not supported` — never a fake result.

## Known Safari limits (vs Chrome/Aside)

- no `chrome.debugger`: no CPU profiling, no request interception/blocking,
  no `postData`
- no `downloads` API: files are caught in the page (links, page-built
  files) and fetched with its cookies; a server-only download goes to
  ~/Downloads through Safari itself, where `safari repl` watches for it
- no `bookmarks`, `topSites`, or `tabGroups` APIs in Safari web extensions,
  so there are no tools for them
- screenshots use `tabs.captureVisibleTab`, so a background tab comes to the
  front of its window for the capture
- content scripts don't pierce closed shadow DOM
- the extension socket is single-client: one daemon owns Safari; CDP clients
  share it through the shim
- the background is a non-persistent MV3 page, not a service worker: as a
  service worker Safari starts it but it never opens its socket, and its
  console cannot be inspected. The page held its socket through a full test
  session; if Safari unloads it, the `alarms` keepalive reconnects it
- Apple Passwords needs a hidden Helium: macOS kills its browser helper
  (`SIGKILL (Code Signature Invalid)`) unless an allow-listed browser starts
  it. Helium must be installed in /Applications. Every agent session shares
  the one pairing, which survives a daemon restart and ends five minutes
  after the last session using it calls `passwords {do: "done"}` or exits;
  `passwords {do: "status"}` says how many hold it and why it is locked
- Messages and browsing history need Full Disk Access, and real input
  needs Accessibility; the launchd daemon has neither, so those tools run in
  the calling process (terminal or MCP server)

## Tests

`bun scripts/fake-extension.ts` (with the daemon up) exercises CLI, CDP shim,
MCP, and the agent loop without Safari; with `SAFARI_HARNESS_WS` set it joins
a second daemon on other ports and leaves the real one alone. `bun test`
covers sign-in code detection, the Apple Passwords pairing, fill, and
hand-over across a daemon restart against a fake helper, the pairing code
read off a stand-in window,
which tab a call acts on, and keeps the MCP tool list under
its size ceiling; `bun run check`
runs the live checks in real Safari.

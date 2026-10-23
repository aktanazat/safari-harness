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
                    (several tools in one call) tabs open close keep goto
                    activate snapshot click type press select hover upload
                    history scroll eval fetch download dialog extract map
                    info wait handoff net console cookies shot pdf window
                    passwords.
                    Actions report `navigated`, `newTab`, and any `dialogs`;
                    snapshots take in embedded frames
  caller.ts         tools that run in the calling process, which holds the
                    terminal's permissions (Messages, browsing history, the
                    real mouse and keyboard); a `run` with one of them runs
                    its steps from the caller too
  spaces.ts         each agent's own Safari window, opened behind the user's,
                    one per task (`open --group`), on a page titled with it
  place.ts          moves an agent's window where no other window covers it:
                    a new one, and one whose shot did not paint
  groups.ts         makes a window its task's Safari tab group, and deletes
                    the group after, only while the user is away from the keys
  keeper.ts         runs groups.ts from the agent's terminal, which has the
                    Accessibility permission the daemon lacks; call.ts starts
                    it after an open
  handoff.ts        handoff's caller half: alerts the user's phone, with a
                    picture of the page, when a step needs him and he is away
                    from the Mac; the daemon raises the tab and notifies
  ask.ts            ask: an agent's question put on the user's phone when he
                    is away, for him to answer back at the Mac
  phone.ts          every alert to the user's phone: at most 6 an hour
  passkey.ts        the card approval page the user's iPhone opens over
                    tailscale serve, and the daemon's check of each Face ID
                    answer: a passkey's signature on a single-use challenge
  phone-cards.ts    card fills he approves on his iPhone while away: each
                    card set up for it is kept sealed under a key only its
                    passkey gives after Face ID; one approval covers that
                    card on that site for 30 minutes
  telegram.ts       sends an alert, and its picture, to his Telegram through
                    ~/.local/bin/tell-aktan
  watch.ts          watch routines: one value read off a page on a schedule,
                    alerted when it changes, with no model
  recordings.ts     teach mode's recordings, saved for the user alone (0600),
                    each typed secret kept only as its kind
  replay.ts         a recording done again in a background tab, each step's
                    target found by its fingerprint
  playbooks.ts      opt-in agent runs stored as verified, parameterized
                    recordings; Jev chooses, replay checks live targets and
                    stops before any approval or sign-in boundary
  save.ts           save on extract, snapshot, eval, and fetch: the whole
                    output goes to a file, and the reply is its path, size,
                    and first 500 characters
  map.ts            map: one read of each of up to 20 pages, a few at a time,
                    each in a background tab that closes after
  mission.ts        live task controls and bounded private history; a fresh
                    view is required after the user gives control back
  mission-history.ts private restart-safe history and optional action pictures
  evidence.ts       private image bundles, source receipts and SHA256 verification
  research.ts       answer-first Markdown/HTML reports with image-backed findings,
                    numeric comparisons and unchecked-source accounting
  failures.ts       structured failures that preserve uncertain action outcomes
  page-state.ts     content, access walls, loading and unread-page classification
  pdf.ts            save a page as PDF and read PDFs, through scripts/pdfkit
  safari-history.ts browsing_history over Safari's History.db (read-only),
                    without the visits agents made
  loads.ts          the pages agents' tabs load, noted for browsing_history
  challenge.ts      names a bot check (CAPTCHA or wall) from what each frame
                    shows, for challenge in results and for handoff
  input.ts          real_input: the real mouse and keyboard through
                    scripts/input, for pages that ignore scripted events; a
                    single click on a tab behind, and text typed at a field,
                    go through Safari's accessibility tree, and nothing
                    comes forward; one call types, sends, and waits for a
                    chat's reply
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
                    tools itself); lasts the agent's session across deploys
  mcp-tools.ts      the tools one release offers over MCP; after a deploy the
                    server loads the daemon's release's copy (fresh.ts)
  imessage.ts       Messages: chats, history, search, sign-in codes, contacts,
                    attachment retrieval, and draft-then-approve sending
                    (chat.db read-only, AddressBook, osascript)
  finder.ts         upload's find: Spotlight over iCloud Drive, Documents,
                    Desktop, and Downloads, returning paths, never contents
  downloads.ts      the files Safari saves to ~/Downloads while an agent's
                    click, press, or download runs
  agent.ts          tool-calling loop for `safari do` (OpenAI-compatible API;
                    gets the Messages read tools, not send)
  notes.ts          site facts and readers with optional sanitized sources,
                    bounded edit history and safe undo; rejects secrets and
                    instructions addressed to an agent
  site-guides.ts    the bundled guides in docs/sites/ and the hosts each
                    covers; an agent's first page on a covered host names
                    its guide
cli/safari.ts       the `safari` command
passwords-bridge/   extension for the hidden Helium: relays between Apple's
                    helper and the daemon's /passwords socket
cli/launchd.ts      always-on daemon and scheduled routines (launchd + headless
                    omp, or a watch with no model)
cli/doctor.ts       `safari doctor`: checks each part the harness needs on
                    this Mac and prints the fix for each that fails
docs/GUIDE.md       the short card of rules (`safari guide`)
docs/skill-head.md  the safari skill's head: a deploy writes it and the card
                    to ~/.agents/skills/safari/SKILL.md
docs/REFERENCE.md   every tool in full, one section each (`safari guide <tool>`)
docs/sites/         one note per site (`safari guide <site>`)
bench/              the WebKit bench's rows for content.js, one page per
                    behavior in fixtures/ (see Tests)
omp/index.ts        omp extension: releases disposable pages only through
                    the owning runtime's current task/job/input authority
scripts/
  pdfkit.swift      helper: renders HTML to paginated PDF (WebKit) and
                    reads PDF text (PDFKit); `bun run helpers` builds it
  input.swift       helper: posts real clicks and keys (CGEvent) into
                    Safari's page area, and presses an element through
                    Safari's accessibility tree; needs Accessibility
                    permission. `input windows` lists the windows on screen
                    for place.ts and needs none
  pairing.swift     helper: the pairing code read off Apple's window, and
                    its Save Password button; needs Accessibility permission
  spaces.swift      helper: works an agent window's tab group sidebar through
                    Accessibility, Safari left in the background; needs
                    Accessibility permission
  bench.swift       test bench: content.js and dialogs.js in a WebKit view
                    no window shows, sent what background.js sends
  dev-install.sh    deploy a commit: make it a release, switch to it, and
                    restart only what changed (see Deploys)
  fake-extension.ts test double that speaks the extension protocol
  check-live.ts     live checks against real Safari in its own background
                    tabs (`bun run check`); includes a snapshot-size guard
  check-research.ts live Safari proof for protected images, receipts, overlapping
                    pieces, takeover safety, page states and local reports
  check-pairing.ts  live check that the Apple Passwords pairing survives two
                    daemon restarts (restarts the daemon; take the live lock)
Safari Harness/     Xcode project generated by safari-web-extension-converter
```

Handoff alerts can include a private screen-sharing link. Put the viewer's
HTTPS URL, as a JSON string, in
`~/.local/share/safari-harness/screen-viewer.json`. The caller reads it for
each alert; no daemon restart is needed to change the URL. Use a tailnet-only
viewer with its own authentication. The link does not approve a prompt or
carry a password.

## Ports

| Port  | What |
|-------|------|
| 37333 | WebSocket: `/` extension socket, `/passwords` Apple Passwords bridge, `/devtools/browser`, `/devtools/page/<tabId>` CDP shim |
| 37334 | HTTP: `POST /rpc {tool,args}`, `GET /health`, `POST /turn-end/prepare {owner}`, `POST /turn-end {owner,prepared}`, `POST /shutdown` |
| 37335 | HTTP on 127.0.0.1, from the first card approval: the page his iPhone opens to approve a card fill, through `tailscale serve` |

local clients on 37333 and 37334 must use `127.0.0.1` or `localhost`,
without a page's `Origin` or cross-site fetch metadata. task pages use
their own origin under the same loopback check. only the extension's
`safari-web-extension://` origin may take the `/` extension socket, and only
the bridge's extension origin may take `/passwords`. 37335 serves only the
approval page: an answer must come from that page's own origin and carry
the card's passkey signature over that request's challenge.

`turn-end/prepare` drains the owner's active calls and returns exact owned
tab IDs with a call-generation token; it never closes a page. `turn-end`
then releases that preparation; an intervening owner call invalidates it,
and a request without one is rejected. omp's main session sends both at
its final `agent_end` (`omp/index.ts`); subagents share its process id and
send nothing. An admitted completed turn or the owning process's exit
immediately closes disposable agent tabs and their empty windows. This
includes clicked pages, filled fields, site-global tabs and an agent page
in front. Pages explicitly kept for the user and pending handoffs stay
protected; the user's own tabs are never part of this cleanup. Active
calls finish before cleanup.

Ordinary idle cleanup is unchanged: unused pages close after 20 minutes,
with the existing form, front-page, kept-page and handoff protections.
Those form and front-page protections do not keep disposable agent tabs
open after completion or owner exit.

For five minutes after a recoverable tab closes, its safe address is
available through Recently closed on `/agents` or the original agent tab
id. Then the recovery metadata expires, even with no harness window open.
Recovery loads a fresh page with Safari's normal site session. It does
not save form contents or exact in-page state, or promise to restore a
draft. Website cookies, logins and session credentials are untouched.

`/agents#windows` lists every durably registered window that remains,
including windows holding pages left for the user after a task ends.
Close window confirms before closing that window's tabs, including kept
pages. A copied or unknown window page grants no close authority.
Restarts restore only proven ownership and preserve the protections
appropriate to idle cleanup or completed-task cleanup.

When a task has positively ended, its disposable tabs and status page close
automatically. A living process without a restored task record remains unknown;
its forms and front pages keep idle-cleanup protection. Kept pages, handoffs and
personal tabs remain protected. After a restart, status pages whose window record is
missing close without claiming ownership of any other tabs in that window.
Copied or reopened status pages also close when they cannot be tracked.
Their addresses never grant permission to close other tabs in the window.
These are task-owned tabs, including unkept `safari open` tabs; use
`--keep` for a page that should outlive its task. Status-page closes use
the same bounded retry limits as other agent-window cleanup.

Override with `SAFARI_HARNESS_WS` / `SAFARI_HARNESS_HTTP_PORT` /
`SAFARI_HARNESS_PHONE_PORT` (daemon),
`SAFARI_HARNESS_HTTP` (CLI/MCP). The extension reads `daemonPort` from
`chrome.storage.local` if you need to move it.

## Setup

1. In the checked-in Xcode project (`Safari Harness/`, generated by
   `xcrun safari-web-extension-converter`), set the development team to
   your own, and keep the bundle ids as they are, since the converter's
   default casing breaks embedding. The app is signed by the account in
   Xcode's settings, or by an App Store Connect API key (App Manager) when
   `~/.appstoreconnect/safari-harness-signing` holds its key id and the
   team's issuer id on one line, with the key at
   `~/.appstoreconnect/private_keys/AuthKey_<id>.p8`. A Mac whose
   `xcode-select` still points at the Command Line Tools builds with
   `/Applications/Xcode.app`, and the installer runs Xcode's first launch
   itself (`xcodebuild -runFirstLaunch` needs no admin password).
2. Run `scripts/dev-install.sh`. It deploys HEAD (see Deploys): it builds
   the Swift helpers and the app, installs the app over `/Applications`,
   and starts the daemon as a launchd agent that stays on (`safari serve`
   runs one in the foreground instead). Safari loads every registered copy
   of the app, and each opens the extension socket; the daemon keeps the
   one that connected first, which may be a stale build. The script leaves
   only the one in `/Applications` registered.
3. Launch "Safari Harness.app" once, then in Safari:
   Settings ▸ Extensions ▸ enable **Safari Harness**.
   That GUI toggle is the only manual step; no Develop-menu or
   "Allow remote automation" toggle is needed for this path (that one is
   for Apple's own `safaridriver --mcp`; see "Two lanes" in
   docs/REFERENCE.md).
4. Run `safari doctor`. It checks every part, the extension connection
   and Accessibility and Full Disk Access for your terminal included, and
   prints the fix for each that fails.
5. For card fills the user approves with Face ID on his iPhone (iOS 18 or
   later, on the same tailnet) while away from the Mac, give the approval
   page an HTTPS address on the tailnet once:
   `tailscale serve --bg --https=8447 http://127.0.0.1:37335`. Never a
   Funnel: the daemon refuses a page open to the internet. Then, at the
   Mac with the phone, `safari passwords card-phone --card <label>` sets
   up one card: Touch ID on the Mac, then the link that reaches Telegram,
   opened in Safari on the phone, "Set up with Face ID", and "Confirm
   with Face ID".

## Deploys

The harness in use runs from a release, never from this checkout.
`scripts/dev-install.sh [COMMIT]` (default HEAD) copies the commit, not the
working tree, into `~/.local/share/safari-harness/releases/<sha>` with its
built helpers, and switches `~/.local/share/safari-harness/current` to it
in one step. The daemon's launchd job, `~/.bun/bin/safari`, omp's safari
MCP server (`mcpServers.safari.args` in `~/.omp/agent/mcp.json`), and its
extension (`~/.omp/agent/extensions/safari-harness`, linked by the deploy)
all run from `current`, so an edit in the checkout reaches no one until it
is committed and deployed.

A deploy restarts only what changed. When the daemon's code differs from
the running daemon's (`code` in `safari status --json`), the daemon stops
taking calls, finishes the ones in flight, and exits; launchd starts the
new one, and calls made meanwhile wait for it. If the new one does not
come up, checkpoint compatibility gates the fallback below. When the
extension or the app changed, the app is installed over `/Applications`
and Safari reloads the
extension, which gives every tab a new id; the extension maps the ids
agents hold to the new ones and tells the daemon, so each agent keeps its
tabs. An agent session keeps its MCP server's code, and omp's extension,
until it restarts.

Normal deployments must contain both the selected release and the running
release in their Git history. Unknown or unrelated history is refused
before a release is built or selected. Use the current installer; an old
script without this check cannot enforce it.

`scripts/dev-install.sh --rollback` selects the previous release only when
its reader supports the current writer's checkpoint and browser-memory
formats. Version-2 checkpoints preserve dirty, held, foreign and resume
metadata. Browser-memory format 2 distinguishes research from personal
browsing. Older readers cannot preserve those boundaries, so an incompatible
downgrade is refused before changing the app, release link or daemon.
Do not invoke an older release's unguarded installer to bypass this boundary.

Before switching releases the installer snapshots the two existing
checkpoints for its HTTP port, byte-for-byte, in a private temporary backup.
On failed startup it stops the sole managed daemon before restoring or
switching anything. A compatible fallback retains the newest state. A
legacy fallback is allowed only if both checkpoints are unchanged since
the snapshot; it restores those exact bytes and permissions before starting
the old release. New files or changed metadata block fallback, retain the
backup and current state, and leave the current release selected. No
automatic downgrade or stale-state overwrite is attempted. Failed
installations print the retained backup path; successful ones delete it.

`~/.local/share/safari-harness/deploys.log` lists every deploy. The five
latest releases stay, and any that was in use in the past week.

## Use

`safari guide` is the short card of rules: tabs, sign-in, bot checks, and
waiting. `safari guide <tool>` prints one tool's section of the reference,
`safari guide reference` lists its sections. The omp skill `safari` points
agents at both.

```
safari open https://example.com --bg   # prints the new tab's id, say 7
safari snapshot --tab 7                # [ref]s for click/type
safari snapshot --query price --tab 7  # only the lines that mention "price"
safari click 2 --snapshot --tab 7      # click, then print the page it led to
safari click 2 --snapshot=Total --tab 7  # only the lines of that page with "Total"
safari select 5 "US 8" --tab 7         # dropdown option by label
safari upload ~/photo.jpg --tab 7      # the page's file input
safari back --tab 7
safari wait --text "Welcome" --tab 7   # returns the moment it is on the page
safari extract --tab 7
safari extract --save --tab 7          # the whole text to a file; prints its path, size, and start
safari extract --as table --tab 7      # tables and product lists as rows of JSON
safari map https://a.example https://b.example   # up to 20 pages at once
safari eval "JSON.stringify(performance.timing)" --tab 7
safari net read --tab 7                # the page's requests since it loaded, with the start of each body
safari net read --body -1 --tab 7      # the latest request's whole body; or --body <part of its url>
safari shot --out page.png --tab 7     # protected pixels and an immutable evidence receipt
safari shot --full --tiles --tab 7     # readable overlapping pieces; original retained
safari download "Export CSV" --tab 7   # the file that button makes, into ~/Downloads
safari pdf --out page.pdf --tab 7      # the page as PDF; safari pdf read file.pdf
safari fetch /api/me --tab 7           # a request with the page's cookies
safari dialog accept --tab 7           # answer confirms with OK from now on
safari window 390 844 --tab 7          # a phone-width window for your tab
safari close 7                         # else it closes when omp's turn ends, or the program that opened it exits
safari keep 7                          # leave it open for the user: a form waiting on his answer
safari open https://example.com --keep  # the same, from the start
safari info --tab front                # the page the user has in front, when he asks
safari history-search invoice          # Safari browsing history
safari call snapshot '{"tab":7,"diff":true}'  # any tool with its MCP arguments
safari passwords --do logins --tab 7   # the same, with each argument as a flag
safari click --help                    # a command's arguments and what they take
safari do "find the price of X on example.com"
safari session list                    # agent runs; resume, steer, queue, stop, delete
safari repl "const p = await openTab('https://example.com'); console.log((await snapshot(p)).tree)"
safari repl --session work "console.log((await gmail.search(0, 'from:bank', {limit: 5})).results)"
safari fill address --tab 7            # name, address, email, phone from your Contacts card
safari fill login --bitwarden --tab 7  # a Bitwarden login, never printed
safari --host studio tabs              # another Mac's Safari, through ssh
safari host use studio                 # make it the default; `host use local` goes back
safari guide gusto                     # one site's note: sign-in, paths, what to confirm
safari learn cvs.com "Insurance card: Pharmacy > Insurance > Add card"   # a fact for later agents
safari guide repl                      # the REPL's API and recovery steps
safari imessage chats                  # recent conversations
safari imessage history "<chat>" --json # messages with attachment ids in files
safari imessage search --from "<contact>" --days 7 --json # find messages and their files
safari imessage files <id>... --out /absolute/folder --clipboard # save originals and copy file URLs
safari imessage code                   # wait for a sign-in code by text
safari imessage send "+1…" "hi"        # prints a draft; add --approved to send
safari imessage send "+1…" --file ~/Pictures/a.jpg   # a photo; succeeds only once it uploaded
```

`safari guide report` documents local evidence-backed reports.
`safari agents` and the local `/agents` page include retained task history;
archived tasks cannot control a new process. Action pictures are opt-in
and use the same screenshot protection as CLI, MCP and REPL captures.
The user can choose Inspect only for a task: reads of its current pages
continue, while navigation, input, arbitrary scripts and session requests
refuse until the user allows actions again.
Automatic recovery cannot reopen a closed page or reload an unresponsive page
for an inspect-only task. Dropdown listing is refused too, because a custom
dropdown may need a click to reveal its choices.
A failed or uncertain action is not permission to retry it blindly.

Get attachment ids from history/search messages' `files` array, then use
`imessage files`. Missing local files are fetched from iCloud through
Messages; this can open the conversation and mark it read. Copies keep
their original formats, and `--out` never overwrites an existing file.
`--clipboard` waits until every file is verified, then writes and reads back
their file URLs. Success does not mean every destination app accepts paste.

`safari do` defaults to local Ollama (`http://127.0.0.1:11434/v1`,
`gemma4:12b-mlx`); point it anywhere with `SAFARI_MODEL_BASE`,
`SAFARI_MODEL`, `SAFARI_MODEL_KEY`. Each run is a session kept in
`~/.local/share/safari-harness/sessions/`: `safari session steer <id>`
talks to it while it runs, `resume` goes on after it answers. Its agent can
search engram memory and read the site guides. From omp, use the MCP tools
instead.
### Browser inspection and native editing

Snapshots can return recoverable revisions with `--updates` and
`--since <revision>`. Protected screenshots can use `--ifChanged`: unchanged
pixels return the prior verified receipt, with its original time, not a new
image. Replaced or removed output files are republished instead of returning
an inconsistent image path. Clicks refuse covered, hidden, disabled or uncertain
replacement targets, including readable containing frames. Viewport-fixed
controls remain clickable when body scrolling is locked; real containing-block
clips still apply, including scaled containers.

Optional tools are available on demand through `run`, CLI and REPL:
`audit` runs actual axe checks; `react` inspects real component/state
structure on explicitly enabled development hosts; `site_actions` adds
optional experimental WebMCP compatibility for cooperating sites.
React and site-action startup hooks are off by default and require explicit
host-wide consent because Safari match patterns cover every port.
Permission changes from different tabs are applied in order without losing
another tab's settings. React component ids are numbers: use the returned id
with `safari react --do inspect --tab N --id <number>` to select that component.
Cached back/forward navigation preserves registered site actions, but requires a
fresh selection. Work interrupted by caching stays uncertain and is not retried.
`video` observes selected decoded moments with protected image receipts and
guarded playback restoration. See `safari guide <tool>` for each contract.

`real_input` supports atomic drag-and-drop and formatted paste with plain
text, HTML and TSV representations. Targets must be visible and uncovered.
Paste restores the old clipboard only if the user has not copied something
else. If an existing clipboard representation cannot be preserved, it sends no
paste and leaves the clipboard unchanged. It refuses password, code, card and
previously marked secret fields, and reports delivery, not editor acceptance.
Safari's [post-drag pointer-event defect](https://bugs.webkit.org/show_bug.cgi?id=202287)
can omit the next `pointerdown` after an HTML drag-and-drop. Native input
does not send an extra click or invent a successful page result to hide it.


Routines support durable pause/resume, cross-process overlap prevention and
`--session <id>` continuation of saved Safari work. They never silently
replace missing or changed saved work with a fresh conversation. Pausing blocks
future runs while admitted work finishes. Resuming refuses until that work ends.


### safari repl

A Playwright-style JavaScript session over the same tools: `openTab`,
`snapshot`, locators, downloads, `page.pdf()`, cookie-bearing `fetch`, plus
site globals that read signed-in sites through their own APIs (`slack`,
`gmail`, `googleAccounts`, `notion`, `googleDocs`, `googleSheets`,
`googleSearch`, `youtube`, `x`/`twitter`, `linkedin`, `imessage`). Each
session runs in its own process behind a user-only unix socket and ends
after 30 minutes unused. Without `--session`, a call runs in its agent's own
session, which also ends when that agent exits, so what one call binds the
next reads; a named session (`--session`) is reachable from any terminal or
agent. The MCP server exposes it as the `repl` tool. `docs/REPL.md` is the
reference.

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
safari routine add stock --every 30 --watch https://example.com/item --selector ".stock"
safari routine add sell --on 2026-10-07 --at 06:36 --script sale.js
safari routine run sell --dry
```

A routine is a prompt file in `~/.local/share/safari-harness/routines/` plus a
launchd agent `at.aktan.safari-harness.routine.<name>` that runs
`omp -p --auto-approve` with it. A watch (`--watch <url>` with `--selector`,
`--text`, `--eval`, or `--replay`) runs no model: each run reads one value off
the page and alerts the user's phone when it changes. A script (`--script
<file.js>`) runs no model either: each run is one `safari repl` call, and
what it prints goes to the user's phone; `run --dry` gives it `DRY = true`
and sends nothing. `--on YYYY-MM-DD` runs any routine once, on that day.
Output goes to `~/Library/Logs/safari-harness/routines/`.

### Opt-in browser memory

`http://127.0.0.1:37334/memory` provides separate opt-in controls for personal
browsing and agent research, plus search, source links, corrected summaries,
notes, retention and deletion. Both permissions start off.

Personal capture requires exact selected hosts and only observes the
foreground non-private user page. Agent tabs and filled editors are excluded.
This does not record the desktop or unsent drafts.

With research saving enabled, an agent selects useful public sources through
`save_source`, using short-lived receipts from actual safe page reads.
Receipts survive tab closure and retain the original text, URL, read time
and partial-read status. Arbitrary agent-supplied source text is not accepted.
Research reads must match anonymous public HTML at an HTTPS URL without a
query string. Signed links and query-dependent pages are skipped rather than
replaying an access grant. Receipts are short-lived bearer capabilities;
local process ids limit cleanup and accidental sharing, not authorization.
Private/project research is refused without trusted permission context.
Research is labelled separately from personal browsing and cannot overwrite
it simply because both use the same URL.

Page text and search stay local. Optional AI summaries send selected text
to OMP; relevant saved text can also accompany AI tasks. Every observation
keeps its source and visit time and is never treated as a confirmed action.
Engram federates browser recall read-only without copying it into records.

`safari memory search "oxygen spectrometer"` searches saved text;
`safari guide memory` explains configuration, provider consent and deletion.
Pausing keeps saved pages. Removing a personal browsing site erases its
personal observations; excluding a site erases both kinds. Expiry or confirmed
forget removes local text, summaries and notes. Forget invalidates unfinished
saves and summaries. Prior chats, provider copies and OS backups are outside
that local deletion boundary.

### Verified agent playbooks

An agent can opt in before a task on its own background tab. It declares a
generic goal, parameter names and a start check. Only successful supported
actions become steps. An observed end check is required before storage.

```
safari playbooks learn --tab N --goal "Search the catalog" --params '["q"]' --before '{"selector":"#search"}'
# Do the authorized task with type/click/select/press/goto.
safari playbooks save --tab N --selector '#results[data-ready="yes"]'
safari playbooks list
safari playbooks run --url https://example.com/ --goal "Search the catalog" --vars '{"q":"shoes"}'
```

The existing recordings folder holds these playbooks. Input values, page
titles, surrounding page text and URL query/fragment values are not kept.
Use only generic control labels, public paths and structural checks.
Private or secret-bearing tasks are not suitable for learning.

Fixed validation filters candidates by the exact page and parameter names.
The installed `jev` client chooses one or abstains. Parameter values never
go to Jev. A choice is not approval: replay checks the start and end, finds
each control again, and stops on drift, ambiguity, changed fields, bot
checks and send/spend/delete/stop/account/sign-in boundaries. It leaves a
stopped tab open for manual review. There is no approval flag bypass.

When the task already names a learned playbook, use
`safari replay <name> --vars '{"q":"shoes"}' --json`. This skips Jev's
selection, not the recording validation, live checks, end check or approval
gates. Check `ok: true` and `verified: true` before calling the learned task
complete. An ordinary toolbar recording does not have that learned end check.

Fewer outer tool requests are not proof of faster completion, lower cost or
lower memory use. Include selection, replay, final checks and cleanup when
comparing workflows.

`safari playbooks cancel --tab N` discards an unfinished learn session.
Learning expires after 30 minutes. Arbitrary JS, real input, frames, shadow
controls, append typing and helpers that hide their actions cannot be
learned. Use the normal agent when the tool abstains or stops. No browser
listener, automatic retry, routine or background learning is installed.


### MCP

Add to an MCP client config. `timeout` (milliseconds, where the client reads
one) lets a long call finish: `repl` runs for up to 120 s, and omp otherwise
ends every call at 30 s.

the tool list keeps the repl help short. full examples stay in
`safari guide repl` and the site guides.

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

keep tests for observable behavior, data integrity, privacy, public contracts and measured resource limits. remove tests that only pin wording, code layout, private bookkeeping or an answer supplied by the test itself. a meaningful failing test stays.

`bun scripts/fake-extension.ts` (with the daemon up) exercises CLI, CDP shim,
MCP, and the agent loop without Safari; with `SAFARI_HARNESS_WS` set it joins
a second daemon on other ports and leaves the real one alone. Run each
`.test.ts` file in a fresh Bun process, for example
`bun test daemon/lifecycle.test.ts`, to isolate process-global browser mocks
and session state. The suites cover sign-in code detection, pairing and fill
against synthetic helpers, tab ownership and cleanup, and the actual MCP
tool-list byte ceiling. Native conditional cases are unverified when skipped.

The native transport fixture runs its stand-in with Node, so it exercises
Bun's child-process pipes without using Bun's readline implementation at
both ends. The production helper remains Swift.

`bun run check` runs live checks in real Safari; it is separate from isolated
suite verification and may restart the installed service.

`bun run check:research` exercises the research features against real Safari
with local synthetic pages and fictional secrets. It verifies protected pixels
with on-device OCR, immutable receipts after output reuse, lossless overlapping
pieces, a fresh view after takeover, access-wall classification and a report
that preserves a numeric disagreement and an unread source. It closes its own
tabs and server and prints the retained proof files.

The upgrade smoke commands use only their own local fixture pages:
`bun scripts/check-agent-upgrades.ts`,
`bun scripts/check-native-interactions.ts`, and
`bun scripts/check-video-observation.ts`. They exercise real Safari click
occlusion, snapshot recovery, conditional protected captures, actual axe and
React, optional WebMCP, native drag/paste and protected video moments.
They restore the prior front tab, close owned pages and remove their
temporary capture bundles. CLI delivery does not prove editor acceptance;
the native smoke reads the actual editor after delivery.

passwords, card numbers and sign-in codes in capture titles and addresses are
hidden, including values you typed yourself.

the privacy fixes now cover disguised addresses and secret text drawn outside its field. saved picture limits now count both stored copies.

captures stop if another tab appears mid-capture. field labels hide sign-in codes. changing how an action waits does not let an uncertain action run again.

password changes need a fresh page read after you give control back.

after you give control back, each task tab needs its own fresh read before another action.

automatic hiding cannot catch private text inside every image or part of a page. check saved pictures before sharing them.

if a tool dies before confirming a click or typing, do not repeat it. stop the agent and make sure its input has stopped before starting a new task.

the bounded local attack scenarios use disposable homes and synthetic data:
`bun qa/attacks/identity.ts`, `bun qa/attacks/limits.ts`, and
`bun qa/attacks/outside-input.ts`. add `--browser` to the last command after
installation to check hostile reports in real Safari. it opens and closes
only its own locally served test pages.

`bun test` also runs content.js in Safari's WebKit without Safari:
`bench/*.test.ts` build `scripts/bench.swift` into `.build/` (rebuilt only
when it changes), open each page in `bench/fixtures` in a web view no window
shows, with dialogs.js in the page's world and content.js in its own, and
send the requests background.js sends. A row is one behavior: a page, the
requests, and the answers they must get (`bench/bench.ts` has the fields),
so a new behavior takes one page and one row. `scripts/bench extension`,
built by `bun run helpers`, takes the same requests one JSON line at a time
(its header lists them), for trying a page by hand. On a Mac without
Apple's command line tools the rows are skipped, and the run prints why.
The bench cannot show Safari's own messaging, frame stitching, a background
tab's timers and painting, or real focus; those need Safari itself.

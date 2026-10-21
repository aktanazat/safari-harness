# safari repl

A JavaScript session over Safari, shaped like Playwright. Use it when a task
takes more than a few clicks: a loop over pages, a download, a PDF, reading
a signed-in site through its own API. Each call runs one script; top-level
`await` works, and top-level bindings stay for the next call in the same
session. A declaration starts its name over, as in a new script: `let
cursor;` is undefined whatever the last call left in it. The script's last
expression prints, or what it `return`s; a script with both a top-level
`return` and `await` runs as one function, so its declarations end with it.
An error names the script line it came from when the stack shows one.

```sh
safari repl "const p = await openTab('https://example.com')"
safari repl "console.log(await p.title())"   # your next call still has p
safari repl --session work "const p = await openTab('https://example.com')"
safari repl --session work "console.log((await snapshot(p)).tree)"
echo "console.log((await gmail.search(0, 'from:bank', {limit: 5})).results)" | safari repl --session work
safari repl --session work --file /tmp/work.js   # in the message that writes it
safari repl --list                  # sessions still running
safari repl --close work            # end one; its tabs close
```

Without `--session`, a call runs in your agent's own session, `agent-<pid>`:
the omp, claude or codex above your shell, else the first program above it
that is not a shell. What one plain call binds (`globalThis.x = …`, a
top-level `const`), your next plain call reads, and its tabs stay yours as
any session's do. It ends when that agent exits or after 30 minutes unused.
Subagents of one harness share it and take turns, so parallel work wants a
`--session` name each. A call with only shells above it (launchd) runs in a
session of its own, whose bindings and tabs end with it.
A named session runs in the background, keeps its bindings between
calls from any terminal or agent, and ends after 30 minutes unused. The tabs
its code opens are the calling agent's: they open in its window and close
when its turn ends or after 20 minutes unused. Starting a session prints a
`hint:` naming the other sessions your agent runs, with their sites: go on
in one of those rather than start another.
The MCP server has the same thing as the `repl` tool (`session` names one
shared with the CLI; without it, the connection gets its own). A call stops
waiting after 120 seconds; its code may still run on in the session. MCP
clients may cut a call at 60 s: split long waits across calls. Scripts run
outside the page: read `document`, `window` and the rest through
`page.evaluate(() => ...)`.

## Tabs

- `openTab(url)` opens a background tab and returns a `Page`; it becomes
  `page`. `const page = await openTab(url)` works too, and keeps `page`
  for later calls. Tabs a session opens close with it, but one kept for the user
  (`keep`) stays. Using `page` before any tab is open or attached throws.
  In a later call of the session, `openTab` of an address it opened before
  loads that tab again, unless it is kept, in front, or an action changed
  its page; `openTab(url, {new: true})` opens another.
  When your agent already has a tab on that site, it prints a `hint:`
  naming it: next time `goto` there instead (`getTabByTargetId(id)`, or
  `attachBrowserTab(id)` for a tab opened outside this session).
  `openTab`, `page.goto` and `snapshot` print the site's saved notes the
  first time a session reaches that site.
- `listBrowserTabs()` lists every Safari tab; `attachBrowserTab(id)` and
  `attachActiveBrowserTab()` hand you one the user already has. Only read
  those; never close or move them.
- `tabs` (the pages this session holds), `getTabs()`, `getTabByTargetId(id)`
  (a page this session holds, else null: attach any other tab with
  `attachBrowserTab(id)`), `closeTab(page)`.

## Reading a page

- `snapshot(page, {interactive, showHidden, ref, selector, maxNodes})`
  returns `{tree, diff}`: the outline with `[ref]`s (600 lines unless
  `maxNodes`; past that it says where it was cut), and what changed since
  this session's last snapshot of the same view.
- `page.content()`, `page.title()`, `page.url()`, `page.evaluate(fn, arg)`
  (runs in the page; falls back to the extension's world when the page
  forbids scripts).
- `page.url()` makes no call: it is the address the page's latest answer
  gave (an action that moved it, `snapshot`, `extract`, `goto`, and the
  end of `waitForTimeout`, `waitForSelector`, or `locator.waitFor`, which
  each read the address once more). A move after that shows with the next
  call; a bare `sleep(ms)` makes none.
- `page.extract(selector?)`, or `page.extract({selector, query})`, returns
  `{url, title, text, truncated}`: the words are in `.text`.
- `page.capture({path, fullPage, ref, annotate, tiles, tileHeight})` returns
  `{path, evidence, screens?, cut?}`. `evidence.path` names the immutable
  receipt with sanitized source details and image SHA256; tiles keep the
  original and use original raster coordinates.
- `page.screenshot({path, fullPage})` and `page.shot()` still return PNG
  bytes. `annotatedScreenshot(page, {path})` returns the capture result,
  with snapshot refs drawn on the protected image. All use the same
  privacy gate; none is an unprotected capture option.
- `page.pdf({path})` saves a PDF, not a screenshot receipt.

## Acting

After the user gives a tab back, read a fresh whole-page snapshot or
extract before acting. A queued action, a read started before takeover,
or a narrowed read does not establish the current page. An uncertain
action result is not safe to repeat until a fresh read shows what happened.

- `page.locator(target)`: target is a ref (`12`, `[12]`, `e12`, frame refs
  like `f1e3`), a CSS selector, or visible text (`text=15` for text of
  digits, which alone name a ref). Also `getByText`, `getByLabel`,
  `getByRole(role, {name})`, `getByPlaceholder`; their text never reads as
  a ref.
- `fill(text, opts)` and `type(text, opts)` take where a `{{code}}` in text
  comes from, as the type tool does: `{secret: "page", from: <mail tab id>}`
  for an emailed code, `{secret: "passwords"}` for an authenticator code.
  A value from the owner's vault is typed from the shell instead:
  `mem-secret run VAR -- safari type <ref> '{{code}}' --tab N --secret env
  --env VAR` (only a CLI call's own environment is read).
- Locator: `click fill type press hover selectOption setInputFiles check
  uncheck textContent innerText innerHTML inputValue getAttribute isVisible
  isChecked count boundingBox first nth last all allTextContents
  allInnerTexts screenshot waitFor`. `nth(i)` counts a selector's matches
  in page order, shown or not, and a text's among the shown controls of
  that name; `last()` is `nth(-1)`, and `all()` one locator per match.
  `click({noWaitAfter: true})`, `press(key, {noWaitAfter: true})` and
  `selectOption(choice, {noWaitAfter: true})` answer once the action ran
  instead of watching the page settle (300 ms at least, 2 s when nothing
  reacts): for a loop of actions whose effects the script reads itself.
  Each still waits for a load or a tab it starts itself (a link, a form,
  a window.open in its handler), and Enter 400 ms in case its script
  moves the page, but not for one the page starts later, and none reports
  its effect. `fill(text, {noWaitAfter: true})` and `type` likewise answer
  once the field holds the text instead of 300 ms after, so a reformat or
  a complaint the page makes later is not seen.
- Page: `goto goBack goForward reload waitForSelector waitForChange
  waitForTimeout waitForLoadState waitForURL waitForFunction keyboard.press
  keyboard.type mouse.click setViewportSize bringToFront close`, and Playwright's
  shorthands `page.click(target, opts)`, `page.fill(target, text, opts)`,
  `page.type(target, text, opts)`. `waitForChange({timeout})` ends once the page
  shows lines it did not have at the last look (results after a click,
  more of a feed after a scroll) and returns them; it throws when none
  come within the timeout (10 s). `waitForTimeout(ms)` ends as soon as the
  page is quiet, ms at most; past a minute of such waits in 10 minutes,
  the output says once to wait on the page (`waitForSelector`,
  `waitForChange`) instead. `waitForURL` takes a function, a
  RegExp, or Playwright's url glob (`**` any text, `*` any text but `/`,
  `{a,b}` either, `?` itself; it covers the whole url); text with no `*` or
  `{` matches any url containing it. `waitForFunction(fn, arg, {timeout})`
  runs fn in the page every quarter second until it returns something
  truthy (30 s at most), and returns that.
- Downloads: `const [d] = await Promise.all([page.waitForEvent('download'),
  page.locator('Export').click()]); await d.saveAs('report.csv')`.
- New windows: start `page.waitForEvent('popup')` before the click that
  opens one.
- `fetch(url, init)` sends the request from a session tab on that site, with
  its cookies, and returns a real `Response` (binary bodies included).

## Site globals

Each reads the user's signed-in site through tabs of its own, and says "not
signed in to <site> in Safari" when it is not. Methods that send or change
anything return a draft until called with `approved: true`.

`slack`, `gmail`, `googleAccounts`, `notion`, `googleDocs`, `googleSheets`,
`googleSearch`, `youtube`, `x` (also `twitter`), `linkedin`. `safari guide <site>`
lists each one's methods under "In safari repl". A list comes with its
paging: `gmail.search` answers `{results, hasMore, total, nextOffset}`.

### Messages

The `imessage` global uses Messages on this Mac, not a browser tab.
`imessage.getHistory(chat, {limit, since})` and
`imessage.search(text, {from, chat, days, limit})` return messages with a `files`
array. Each file has `{id, name, mime, bytes, downloaded, path?}`; `mime` can
be null, and `path` appears only when the file is present locally.

Use `await imessage.files(ids, {out, clipboard})` with ids from that array.
The options are optional. Missing local files are fetched from iCloud through
Messages; a download can open the conversation and mark it read. This is not
a read-only call. `out` is an absolute folder for copies, which keep their
original formats and get a suffix rather than overwriting existing files.

The result is `{files: [{id, name, mime, bytes, path, downloaded: true}],
clipboard?: true}`. Any missing file fails the call. With `clipboard: true`,
the clipboard stays unchanged until every file is verified, then receives
their file URLs. Success means those URLs were read back; it does not mean
every destination app accepts paste.

## Files and helpers

`fs` (node:fs/promises) and `path` start relative paths in the session's
own folder, `pwd`. Also `Buffer`, `sleep(ms)`, `display(...)` (same as
`console.log`), the timers, `URL`, `URLSearchParams`, `TextEncoder`,
`TextDecoder`, `AbortController`, `Blob`, `Response`, `Headers`,
`FormData`, `atob`, `btoa`, `crypto`, `performance` and `structuredClone`.
There is no `process`. Of `Bun` there is only `Bun.write(path, data)`,
which writes a file, making its folders, and returns the bytes written.

## When a run goes wrong

- One script per call, one session per goal: the same `--session` name in
  every call of a task. Keep what you learn in bindings, not in re-reads.
- "that tab is gone" (closed at a turn's end or after 20 minutes unused):
  `openTab` again in the same session. A new session name starts over
  without your bindings, and leaves the old one running.
- A click that should open a window: begin `waitForEvent('popup')` first,
  then click. A form that ignores `click` on its button: call
  `requestSubmit()` on the form through `page.evaluate`.
- If a call timed out or its outcome is unknown after a submit, stop. Read
  the durable state (the order page, the sent folder, the saved record)
  before trying again; a second try can send twice.
- A ref outlasts the page redrawing its element, and the tab loading the
  same address again (the answer says `healed`). A stale ref means its
  element left or the tab loaded another address: take a new `snapshot`
  and use the new refs.
- Large results go to a file (`fs.writeFile('rows.json', ...)`); print a
  count and the path, not the whole thing. Output past 10,000 characters
  is saved whole to `~/.local/share/safari-harness/saved/page-<time>.txt`,
  and the answer is its first 2,000 characters and that path.
- Reading a script bundle or a page's source: write it to a file
  (`fs.writeFile`) or let the output spill to one, then grep the file for
  the API path or name you want, instead of printing slices of it.
- Sleeps: wait on the page instead (`waitForSelector`, `locator.waitFor`,
  or `waitForChange` when you cannot name what comes). Past a minute of
  `waitForTimeout` in 10 minutes, one `hint:` line says so, and again only
  when the total has doubled.
- When another model judges a page, give it field names and labels, never
  the values the user typed or the site showed.
- `safari repl --close <name>` and start again under the same name when
  bindings are in a bad state; the session's files stay in its folder.

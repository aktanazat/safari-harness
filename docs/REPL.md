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

omp identifies each call by its session and agent, not just its process.
When a helper finishes, only its disposable pages are released. A sibling
or the main session keeps its pages. Main completion releases all remaining
pages owned by that process, including abandoned helper pages. Kept pages,
pending handoffs and personal pages remain protected.

This identity follows every REPL run, including a named session reused by
another helper. Reusing bindings does not reuse the previous caller's page
ownership. The omp extension adds the reserved `__safariTask` MCP argument;
the MCP boundary removes it before Safari validates the tool arguments.
CLI calls receive the same identity through a command-scoped
`SAFARI_HARNESS_TASK` environment variable. A shared REPL process never uses
its launch environment as the identity of a later run. Clients without a
task identity retain process-wide ownership.

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

- `snapshot(page, {interactive, showHidden, ref, selector, maxNodes})`, or
  `page.snapshot({...})`, returns `{tree, diff}`: the outline with `[ref]`s
  (600 lines unless `maxNodes`; past that it says where it was cut), and
  what changed since this session's last snapshot of the same view.
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
- With agent research saving enabled, eligible `snapshot` and `extract`
  results also contain `memoryReceipt`. Select useful sources with
  `await saveSource(read.memoryReceipt.id, "why this source matters")`.
  This works after `closeTab(page)`, until the receipt expires or its
  caller ends. Only the original safe read is saved; arbitrary evaluated
  text is not accepted. Research stays separate from personal browsing.
  See `safari guide memory` for permissions and public-source limits.
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
- Locator: `click dragTo paste fill type press hover selectOption setInputFiles check
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
- `source.dragTo(destination)` sends one real mouse drag between locators in
  the same page. Both endpoints must already be visible and uncovered in the
  same viewport. It does not scroll either endpoint into view. The page,
  endpoints, frame covers, and Safari window are checked again before input.
  A failed or interrupted drag releases the mouse button. Read the result
  before another drag; a delivered gesture does not prove the page kept it.
- `locator.paste(text, {html?, tsv?})` pastes at that editable target's current
  selection. `page.keyboard.paste(text, {html?, tsv?})` uses the page's actual
  focused editable target. Plain `text` is required as a fallback; HTML and
  tab-separated values are optional clipboard representations, not extra
  keystrokes. Paste does not clear the editor or press Return for trailing
  line breaks. Password, hidden, covered, disabled, and read-only fields are
  refused. Use the existing secret-filling tools for passwords and codes.
  Clipboard bytes stay in the native helper. Its previous items and formats
  are restored after the page acknowledges the input, but only if the
  clipboard still belongs to that paste. A user's later copy is left alone.
  A missing acknowledgment reports an unknown outcome, not a retry.
  Delivery does not prove the editor accepted rich content; inspect the
  editor's resulting text or table.

  ```js
  await page.locator('#card').dragTo(page.locator('#drop'));
  await page.locator('#editor').paste('name\tamount\nada\t42', {
    html: '<table><tr><th>name</th><th>amount</th></tr><tr><td>ada</td><td>42</td></tr></table>',
    tsv: 'name\tamount\nada\t42'
  });
  ```
- Page: `goto goBack goForward reload waitForSelector waitForChange
  waitForTimeout waitForLoadState waitForURL waitForFunction keyboard.press
  keyboard.type keyboard.paste mouse.click setViewportSize bringToFront close`, and Playwright's
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
There is no `process`. Of `Bun` there are only `Bun.write(path, data)`,
which writes a file, making its folders, and returns the bytes written,
and `Bun.file(path)`, whose `text()`, `json()` and `bytes()` read one back
and whose `exists()` says whether it is there.

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
  and the answer is its first 2,000 characters and that path. A run that
  fails keeps 8 lines of its output, and 8 of its error, the rest saved
  the same way.
- A name the script got wrong comes back with its nearest (`getTab is not
  defined` → `hint: did you mean getTabs?`); a page method called on
  something that is not a page (a `listBrowserTabs()` row) says so.
- The MCP `repl` tool's own session (no `session`) starts over when the
  harness is updated mid-task: its first answer begins `this repl session
  started fresh at <time>`, with the pages to `attachBrowserTab(id)` again.
  A named session keeps its bindings.
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

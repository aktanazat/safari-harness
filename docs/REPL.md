# safari repl

A JavaScript session over Safari, shaped like Playwright. Use it when a task
takes more than a few clicks: a loop over pages, a download, a PDF, reading
a signed-in site through its own API. Each call runs one script; top-level
`await` works, and top-level bindings stay for the next call in the same
session. The script's last expression prints, or what it `return`s; a script
with both a top-level `return` and `await` runs as one function, so its
declarations end with it. An error names the script line it came from when
the stack shows one.

```sh
safari repl "const p = await openTab('https://example.com'); console.log(await p.title())"
safari repl --session work "const p = await openTab('https://example.com')"
safari repl --session work "console.log((await snapshot(p)).tree)"
echo "console.log(await gmail.search(0, 'from:bank', {limit: 5}))" | safari repl --session work
safari repl --list                  # named sessions still running
safari repl --close work            # end one; its tabs close
```

Without `--session`, a call is a session of its own: its tabs close when it
ends. A named session runs in the background, keeps its bindings between
calls from any terminal or agent, and ends after 30 minutes unused. The tabs
its code opens are the calling agent's: they open in its window and close
when its turn ends or after 20 minutes unused.
The MCP server has the same thing as the `repl` tool (`session` names one
shared with the CLI; without it, the connection gets its own). A call stops
waiting after 120 seconds; its code may still run on in the session. MCP
clients may cut a call at 60 s: split long waits across calls. Scripts run
outside the page: read `document`, `window` and the rest through
`page.evaluate(() => ...)`.

## Tabs

- `openTab(url)` opens a background tab and returns a `Page`; it becomes
  `page`. Tabs a session opens close with it, but one kept for the user
  (`keep`) stays. Using `page` before any tab is open or attached throws.
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
- `page.extract(selector?)`, or `page.extract({selector, query})`, returns
  `{url, title, text, truncated}`: the words are in `.text`.
- `page.screenshot({path, fullPage})`, `annotatedScreenshot(page, {path})`
  (ref numbers drawn on the picture), `page.pdf({path})`.

## Acting

- `page.locator(target)`: target is a ref (`12`, `[12]`, `e12`, frame refs
  like `f1e3`), a CSS selector, or visible text (`text=15` for text of
  digits, which alone name a ref). Also `getByText`, `getByLabel`,
  `getByRole(role, {name})`, `getByPlaceholder`; their text never reads as
  a ref.
- `fill(text, opts)` and `type(text, opts)` take where a `{{code}}` in text
  comes from, as the type tool does: `{secret: "page", from: <mail tab id>}`
  for an emailed code, `{secret: "passwords"}` for an authenticator code.
- Locator: `click fill type press hover selectOption setInputFiles check
  uncheck textContent innerText innerHTML inputValue getAttribute isVisible
  isChecked count boundingBox first screenshot waitFor`.
- Page: `goto goBack goForward reload waitForSelector waitForTimeout
  waitForLoadState waitForURL keyboard.press keyboard.type mouse.click
  setViewportSize bringToFront close`, and Playwright's shorthands
  `page.click(target)`, `page.fill(target, text)`, `page.type(target, text)`.
  `waitForTimeout(ms)` ends as soon as the page is quiet, ms at most; past
  a minute of such waits in 10 minutes, the output says to wait on text or
  a selector (`waitForSelector`) instead. `waitForURL` takes a function, a
  RegExp, or Playwright's url glob (`**` any text, `*` any text but `/`,
  `{a,b}` either, `?` itself; it covers the whole url); text with no `*` or
  `{` matches any url containing it.
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
lists each one's methods under "In safari repl".

### Messages

The `imessage` global uses Messages on this Mac, not a browser tab.
`imessage.getHistory(chat, {limit, since})` and
`imessage.search(text, {from, days, limit})` return messages with a `files`
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
There is no `process` or `Bun`.

## When a run goes wrong

- One script per call, one session per goal. Keep what you learn in
  bindings, not in re-reads.
- A click that should open a window: begin `waitForEvent('popup')` first,
  then click. A form that ignores `click` on its button: call
  `requestSubmit()` on the form through `page.evaluate`.
- If a call timed out or its outcome is unknown after a submit, stop. Read
  the durable state (the order page, the sent folder, the saved record)
  before trying again; a second try can send twice.
- A ref outlasts the page redrawing its element (the answer says
  `healed`). A stale ref means its element left or the page loaded anew:
  take a new `snapshot` and use the new refs.
- Large results go to a file (`fs.writeFile('rows.json', ...)`); print a
  count and the path, not the whole thing.
- When another model judges a page, give it field names and labels, never
  the values the user typed or the site showed.
- `safari repl --close <name>` and start again when bindings are in a bad
  state; the session's files stay in its folder.

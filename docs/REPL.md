# safari repl

A JavaScript session over Safari, shaped like Playwright. Use it when a task
takes more than a few clicks: a loop over pages, a download, a PDF, reading
a signed-in site through its own API. Each call runs one script; top-level
`await` works, and top-level bindings stay for the next call in the same
session.

```sh
safari repl "const p = await openTab('https://example.com'); console.log(await p.title())"
safari repl --session work "const p = await openTab('https://example.com')"
safari repl --session work "console.log((await snapshot(p)).tree)"
echo "console.log(await gmail.search(0, 'from:bank', {limit: 5}))" | safari repl --session work
safari repl --list                  # named sessions still running
safari repl --close work            # end one; its tabs close
```

Without `--session`, a call is a session of its own: its tabs close when it
ends. A named session runs in the background, keeps its bindings and tabs
between calls from any terminal or agent, and ends after 30 minutes unused.
The MCP server has the same thing as the `repl` tool (`session` names one
shared with the CLI; without it, the connection gets its own). A call stops
waiting after 120 seconds.

## Tabs

- `openTab(url)` opens a background tab and returns a `Page`; it becomes
  `page`. Tabs a session opens close with it.
- `listBrowserTabs()` lists every Safari tab; `attachBrowserTab(id)` and
  `attachActiveBrowserTab()` hand you one the user already has. Only read
  those; never close or move them.
- `tabs` (the pages this session holds), `getTabs()`, `getTabByTargetId(id)`,
  `closeTab(page)`.

## Reading a page

- `snapshot(page, {interactive, showHidden, ref, selector})` returns
  `{tree, diff}`: the outline with `[ref]`s, and what changed since this
  session's last snapshot of the same view.
- `page.content()`, `page.extract(selector?)`, `page.title()`, `page.url()`,
  `page.evaluate(fn, arg)` (runs in the page; falls back to the extension's
  world when the page forbids scripts).
- `page.screenshot({path, fullPage})`, `annotatedScreenshot(page, {path})`
  (ref numbers drawn on the picture), `page.pdf({path})`.

## Acting

- `page.locator(target)`: target is a ref (`12`, `[12]`, `e12`, frame refs
  like `f1e3`), a CSS selector, or visible text. Also `getByText`,
  `getByLabel`, `getByRole(role, {name})`, `getByPlaceholder`.
- Locator: `click fill type press hover selectOption setInputFiles check
  uncheck textContent innerText innerHTML inputValue getAttribute isVisible
  isChecked count boundingBox first screenshot waitFor`.
- Page: `goto goBack goForward reload waitForSelector waitForTimeout
  waitForLoadState waitForURL keyboard.press keyboard.type mouse.click
  setViewportSize bringToFront close`.
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
`googleSearch`, `youtube`, `x` (also `twitter`), `imessage`. `safari guide
<site>` lists each one's methods under "In safari repl".

## Files and helpers

`fs` (node:fs/promises) and `path` start relative paths in the session's
own folder, `pwd`. Also `Buffer`, `sleep(ms)`, `display(...)` (same as
`console.log`).

## When a run goes wrong

- One script per call, one session per goal. Keep what you learn in
  bindings, not in re-reads.
- A click that should open a window: begin `waitForEvent('popup')` first,
  then click. A form that ignores `click` on its button: call
  `requestSubmit()` on the form through `page.evaluate`.
- If a call timed out or its outcome is unknown after a submit, stop. Read
  the durable state (the order page, the sent folder, the saved record)
  before trying again; a second try can send twice.
- A stale ref means the page changed: take a new `snapshot` and use the new
  refs.
- Large results go to a file (`fs.writeFile('rows.json', ...)`); print a
  count and the path, not the whole thing.
- When another model judges a page, give it field names and labels, never
  the values the user typed or the site showed.
- `safari repl --close <name>` and start again when bindings are in a bad
  state; the session's files stay in its folder.

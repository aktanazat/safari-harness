---
name: Google Sheets
hosts: docs.google.com/spreadsheets
---
# Google Sheets

Spreadsheets are read through their export links, so the editor never opens and nothing changes in the sheet.

## In safari repl

The `googleSheets` global reads a spreadsheet through its export endpoints with the signed-in Safari session; the grid is never opened in the editor.

- `getSpreadsheetInfo(idOrUrl, {account})`: `{id, title, sheets: [{name, gid}]}`.
- `readSheet(idOrUrl, {sheet | gid, range, account})`: one sheet's cells as rows of strings, the values as shown (formatted, not formulas); the first sheet unless `sheet` (its name) or `gid` says which; `range` like `"A1:C20"` narrows it. Trailing empty cells and rows are dropped.
- `readAllSheets(idOrUrl, {account})`: every sheet as `{name, gid, rows}`.

```js
const info = await googleSheets.getSpreadsheetInfo("https://docs.google.com/spreadsheets/d/<id>/edit#gid=0");
const rows = await googleSheets.readSheet(info.id, { sheet: info.sheets[0].name, range: "A1:F50" });
console.table(rows.slice(0, 10));
```

A spreadsheet the account cannot open comes back as an HTTP 404 error. Reading every sheet of a large spreadsheet is one request per sheet.

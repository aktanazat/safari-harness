---
name: Google Docs
hosts: docs.google.com/document
---
# Google Docs

## In safari repl

The `googleDocs` global reads a document through its export endpoints with the signed-in Safari session; nothing is opened in the editor.

- `parseUrl(url)`: `{id, kind, account?}` from a Docs, Sheets, Slides, Forms, or Drive link (`kind` is document, spreadsheet, presentation, form, or file; `account` is the `/u/<n>/` index when the link has one).
- `getDocumentText(idOrUrl, {account})`: the document as plain text.
- `getDocumentHTML(idOrUrl, {account})`: the document as HTML, with its styles and images.

```js
const { id } = googleDocs.parseUrl("https://docs.google.com/document/d/<docId>/edit");
const text = await googleDocs.getDocumentText(id);
console.log(text.split("\n").slice(0, 5));
```

A document the account cannot open comes back as an HTTP 404 error; a link with `/u/<n>/` (or `account`) picks which signed-in account asks.

---
name: Ashby
hosts: jobs.ashbyhq.com
---
# Ashby

Application forms at `jobs.ashbyhq.com/<company>/<job id>/application`.

## Answers are saved as you go, and Submit checks the saved copy
- Every field saves itself to Ashby's server in its own request (`ApiSetFormValue`; the resume goes up through `ApiSetFormValueToFile`). A text field saves 500 ms after its last change or when it loses focus; a Yes/No button or an upload saves at once.
- Submit checks those saved answers, not the page. A form can show every answer and still fail with "Your form needs corrections / Missing entry for required field: …".
- Saves that overlap lose answers. Filling a whole form back to back in one `safari run` (type, type, upload, type, click, click) left 1 to 5 required answers unsaved in each of 3 runs, though every request returned 200 and the page showed every answer. The same form filled one field at a time, waiting for each save, lost none in 3 runs (about 7 s a form).

## Filling
- One field at a time. After `type`, leave the field (`safari eval --tab N --expression 'document.activeElement.blur()'`) so it saves now, then wait for the save before the next field. Wait the same way after each Yes/No click and after the upload, which takes a few seconds.
- Yes/No buttons (`[data-field-path="<id>"] button[data-option="yes"]`) toggle: clicking the chosen answer again clears it. Check what is saved before clicking.
- Typing the text a field already shows sends nothing, since the page sees no change. To save a field that shows text but is unsaved, focus it and leave it (`el.focus(); el.blur()`).
- An upload can fail with "<file> failed to upload"; upload again and check.

## Checking what is saved
The page's policy forbids `eval --page`, so this reads the saved answers from a script tag carrying the page's own nonce. It returns the required questions with nothing saved; a form is ready only when it returns `[]`.

```js
(() => {
  const s = document.createElement("script");
  s.nonce = [...document.scripts].map((x) => x.nonce).find(Boolean);
  s.textContent = `document.documentElement.dataset.unsaved = JSON.stringify(
    [...document.querySelectorAll("[data-field-path]")].flatMap((c) => {
      let f = c[Object.keys(c).find((k) => k.startsWith("__reactFiber$"))];
      while (f && !f.memoizedProps?.fieldEntry) f = f.return;
      const e = f?.memoizedProps.fieldEntry, v = e?.fieldValue;
      const empty = !v || (v.__typename !== "File" && (v.value == null || v.value === "" || (Array.isArray(v.value) && !v.value.length)));
      return e?.isRequired && empty ? [e.field.title] : [];
    }))`;
  document.documentElement.append(s);
  s.remove();
  const out = document.documentElement.dataset.unsaved;
  delete document.documentElement.dataset.unsaved;
  return JSON.parse(out);
})()
```

Each entry's `fieldEntry.fieldValue` is the saved answer: `{ __typename: "JSONBox", value }`, or `{ __typename: "File", id }` for the resume, or null.

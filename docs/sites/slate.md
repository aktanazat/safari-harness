---
name: Slate
hosts: gradapp.berkeley.edu, applygrad.stanford.edu, apply.knight-hennessy.stanford.edu
---
# Slate application portals

Technolutions Slate runs the Berkeley graduate application (`gradapp.berkeley.edu`), the Stanford graduate application (`applygrad.stanford.edu`), and Knight-Hennessy (`apply.knight-hennessy.stanford.edu`). Their pages and controls are the same; the learned notes below hold what differs. Never sign `/apply/certify`, submit, or pay without the user's yes.

## Pages
- `/apply/` lists "Your Applications". Signed-in pages show a "Logout" link. After the session lapses, `/apply/` shows the public landing page instead; sign in at `/account/login`.
- Each section is `/apply/frm?<id>`. Continue saves the section and loads the next one; there is no other save.
- `/apply/review` is a table, "Section | Required Field or Error", of what is still missing. `/apply/certify` is the signature.

## Opening an application
- Clicking the application's name on `/apply/` opens an "Application Details" dialog, not the application; `snapshot --root dialog` reads it. Its "Open Application" button loads the first section. Waits for a section's words after clicking the name timed out, at 10 and at 15 seconds.

## Rows in a popup
- Schools, jobs, research, activities, and addresses are rows. A row, or its "Add ..." link (`a.widget_add`), opens a popup with Save and Cancel, plus Delete on a saved row. The click's answer names the popup.
- `snapshot --root dialog` reads the open popup, a `div` with `role=dialog` rather than a `<dialog>`, and `extract --selector dialog` gives its text. With a second dialog over it, the name the click's answer gave reads the popup: `--root 'dialog "<name>"'`.
- Save closes the popup and lists the row; `wait --gone "<popup title>"` tells when. A refused Save leaves the popup open, with a second dialog ("1 required field was not completed.") or only a red block and the browser's "Fill out this field". The inputs' `validationMessage` names the empty one.
- Delete in a popup asks "Are you sure that you want to delete this record?".
- Institution fields search as you type. Type a unique part of the name or city (Berkeley's popup says not to paste the full name), then click the suggestion, which a snapshot shows as `option "<name> <city>, <state>"`.

## Documents
- An uploaded file lists as "MM/DD/YYYY - <file>.pdf - N page(s)" with Preview and Delete.
- Delete is a replace. Its confirm reads "Are you sure that you want to replace this document?", so run `dialog accept` first, click Delete, `upload` the new file on `#material_<field>`, then Continue, or Save in a popup. Saves that carried only the Delete kept the old file.
- Preview opens an image viewer, so the stored file's text cannot be read back; check the local file before uploading it.

## Text answers
- `type` works. A script that sets `value` must also fire input, keyup, and change for the word counter to update.

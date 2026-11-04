---
name: Paul & Daisy Soros Fellowships
hosts: pdsoros-fellowships.smapply.io
---
# Paul & Daisy Soros Fellowships

The application runs on SurveyMonkey Apply at `pdsoros-fellowships.smapply.io`. Never submit it without the user's yes.

## Signing in
- Signed out, `/prog/` redirects to `/acc/l/?next=/prog/`. Google sign-in there, through Google's account chooser, signs in.

## Tasks
- Each part of the application is a task. The task view is read-only and shows the saved text in `div.answer`.
- The task menu's Edit link is hidden; a DOM click on the `a` whose text is "Edit" opens the editor at `.../e/`.
- "Save & Continue Editing" is an `input[type=submit]`, not a `button`: a script that searched `button` elements for it found nothing. Search `button, input[type=submit]` by text or value.
- The page has two "Mark as complete" buttons and one is hidden; click the visible one.
- An essay box shows a live count, such as "Words entered: N. Min: 10 Max: 1000".

## Uploads
- An upload task holds one file. "ATTACH FILE" stays disabled until the old file is removed through "Perform action on uploaded file", and "Mark as complete" stays disabled until the new file is attached.

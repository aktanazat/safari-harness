---
name: GitHub
hosts: github.com
---
# GitHub

Use the `gh` CLI for everything it can do: repos, issues, pull requests, and reads through `gh api`. Safari is for the few profile settings `gh` cannot reach. Verify through the API, not the page.

## Bio
- `gh api -X PATCH user -f bio=...` fails with "This API operation needs the "user" scope", and adding the scope needs the user's browser approval.
- In Safari: `https://github.com/settings/profile`, the "Bio" textbox, then `Update profile`. Check with `gh api users/<login>`.

## Pinned repositories
- There is no API to set pins. On `https://github.com/<login>`, `Customize your pins` opens a dialog of checkboxes, "N remaining", and `Save pins`.
- Checked by script or by the harness `click`, the boxes turned on but the dialog still said "6 remaining" and `Save pins` stayed disabled; dispatching `input` and `change` events did not help.
- What worked: in one `eval`, check the boxes by their labels, then call `submit()` on the dialog's form, whose action is `/users/<login>/set_pinned_items`.
- Check with GraphQL: `gh api graphql -f query='{ user(login: "<login>") { pinnedItems(first: 6) { nodes { ... on Repository { name } } } } }'`.

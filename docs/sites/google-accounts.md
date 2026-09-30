---
name: Google Accounts
hosts: accounts.google.com
---
# Google Accounts

This guide covers which Google accounts Safari is signed in to. Gmail, Docs, and Sheets pick an account by its `/u/<n>/` index or its email.

## In safari repl

The `googleAccounts` global names the accounts Safari is signed in to, from the account menu Google apps show.

- `list()`: every signed-in account as `{index, email, name}`; `index` is the `/u/<n>/` (authuser) number the `gmail`, `googleDocs`, and `googleSheets` globals take as `account`.

```js
const accounts = await googleAccounts.list();
const work = accounts.find((a) => a.email.endsWith("@example.com"));
await gmail.getInbox(work.index, { limit: 10 });
```

An account that is signed in to Google but has no Gmail (or whose session Gmail wants refreshed) still shows up here; Gmail then reports it as not signed in.

## Recovering an account
- Signing in to a second account from an agent tab goes to /v3/signin/challenge/recaptcha, which the harness reports as a challenge. Hand it to the owner with `handoff`; no code option appears before he clears it.
- "Try another way" from there ends at /v3/signin/rejected, "Couldn't sign you in".
- ServiceLogin addresses redirect to the account already signed in, not to a sign-in form.

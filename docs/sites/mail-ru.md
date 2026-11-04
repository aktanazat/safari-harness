---
name: Mail.ru
hosts: mail.ru
---
# Mail.ru

The owner's Russian mailbox, at e.mail.ru, in Russian.

## Searching mail
- Search by address: e.mail.ru/search/?q_query=<words>, or ?q_from=<sender>.
- A search page can snapshot as a single node; read results with `eval` on `document.body.innerText`.
- "Ничего не нашлось" ("nothing found") means the search has no results; stop waiting.

## Account
- Adding a phone on id.mail.ru/contacts starts with a flash call (enter the caller's last 6 digits), and those calls do not reach this Mac. The SMS fallback's 8-minute countdown runs only while the tab is visible.

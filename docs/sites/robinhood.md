---
name: Robinhood
hosts: robinhood.com
---
# Robinhood

Robinhood blocks page scripts on its support pages, so `repl` evaluate fails there; `eval` through `run` worked. Gold Card transactions and statements are in the app only, and app.robinhood.com does not answer.

## Pages
- "Page not found": /us/en/credit-card/, /account/credit-card, /us/en/account/, /us/en/credit-card/manage/, /account/rewards, /spending, /help, /portfolio/, /us/en/home/.
- History: robinhood.com/account/history?type=transfers lists Robinhood transfers.

## Holdings
- From a robinhood.com tab, `fetch` https://api.robinhood.com/accounts/ and /positions/?account_number=<n>&non_default_account=<n>: once the page has called the API itself (it does as it loads), `fetch` carries its `Authorization: Bearer` header, which cookies alone lack (401). The header stays in the page. Where the page has not called the API yet, `eval` (without `page: true`, which the page's policy refuses) can send `Authorization: Bearer` with `JSON.parse(localStorage['web:auth_state']).access_token`; return the data, never the token.
- The credit_card and gold_card API paths do not answer.

## Support chat
- Past chats: robinhood.com/account/help > Your support chats. A chat reopens directly at robinhood.com/chat-support/<id>. /us/en/support/contact/ has no chat.
- Ask the bot for an agent, then click "Chat with an agent"; "<name> is reviewing your case" means a person joined. "Get a call back" works 7 AM-9 PM ET only. A closed chat disables its message box.
- Each sent message shows a failed POST .../messages/ in net, yet it is delivered.
- To wait on the agent's reply, call `wait {changed: true, ms: 25000}` and read `added`; call it again until `found`. Never wait on the clock or made-up words.

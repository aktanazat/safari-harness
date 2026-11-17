---
name: Bank of America
hosts: bankofamerica.com
code-senders: 73981
---
# Bank of America

Deep links redirect to the www.bankofamerica.com sign-in when signed out. After the password, the bank asks the owner to approve the sign-in on his iPhone: use `handoff`, then press Enter once he approves.

An authorization code it texts comes from 73981 and does not name the bank. `type {text: "{{code}}"}` takes it from that number without `sender`, as `code-senders` above lists it.

## Activity
- Account activity is at secure.bankofamerica.com/deposit-details/activity/. The rows are table rows; read them with `eval` over `tr`.

---
name: Amazon
hosts: amazon.com
---
# Amazon

There are several saved logins for www.amazon.com; pass username aktanaazat@gmail.com to `passwords fill` for the shopping account.

## Prime
- www.amazon.com/gp/primecentral: extract returns only the account name. Read `document.body.innerText` with `eval` to get the plan, price, renewal date, and Cancel.
- /mm/pipeline/cancellation shows nothing to snapshot; start from primecentral.

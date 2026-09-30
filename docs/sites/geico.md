---
name: GEICO
hosts: geico.com
---
# GEICO

Sign-in and policy pages live on ecams, edgecustomer, and portfolio.geico.com. Public www pages refuse `read` with HTTP 403, so use `map` extract for them. Choose email for the security code; it arrives in Gmail.

## Policy changes
- Coverage Updates > Edit opens coverage/edit. Click Recalculate with `real_input`; a scripted click can leave the premium at "$---.--".
- Save only saves a quote. Saved quotes wait at /quote/review under Select Quote, and a change is done only at "Your policy updates are complete!".
- For a replaced car, Continue then Apply Changes is the final commit.

## Documents and billing
- ID cards: edgecustomer.geico.com/documents/poi-selection > ID Cards and/or Other Documents > Continue > View and Print. The PDF opens in a new tab. Reload the page if it is blank after going back.
- /billing opens blank; use billing/pay-plan and billing/stored-account.
- The card number field is in a payment frame. Type it one character per `real_input` call on its ref; scripted typing leaves Save disabled.

## Session
- After about 16 idle minutes the session ends at login?msgid=MSG150_8. Links then land on /no-permission or /error; sign in again from ecams.geico.com.

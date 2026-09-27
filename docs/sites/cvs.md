---
name: CVS
hosts: cvs.com, www.cvs.com
---
# CVS

This is the user's pharmacy account: prescriptions, stores, and payment. Show the user the drug, the store, and the estimated price before `Place order`, and place it only after they say yes.

## Signed in or not
- Load `https://www.cvs.com/pharmacy/rx/prescriptions`. Signed in, it lists the prescriptions; signed out, the page sends the tab to `https://www.cvs.com/`.
- Signed in, the sign-in page (`/account-login/look-up`) also sends the tab to the home page. In a background tab that redirect waits until the tab comes to the front, so a sign-in form that sat still in the background and vanished on `activate` or `real_input` means the account is already signed in. Check the prescriptions page before signing in.
- "Keep me signed in" does not hold for long: on 2026-09-27 the account was signed out a few hours after an order. Entering the email and `Continue` then showed a "Passkey not recognized" dialog; `Sign in another way` led to the one-time-code page, which went to the home page once the tab came to the front, and the prescription list loaded. No code came by text, but that session ended within 10 minutes, and the same email step 10 minutes later brought Akamai's challenge and "It looks like you're having problems connecting". Do not sign in from an unattended routine; a sign-in the user completes himself (passkey or texted code) held for days in September.

## Signing in
- Email first, then a one-time code or a passkey; there is no password step. The code comes by text from 63641 ("Your CVS account verification code is ..."): read it with `imessage_wait_code` and never repeat it. A passkey prompt is the user's to approve.
- A scripted `press Enter` on the sign-in form once brought up Akamai's "Processing your request" page (an iframe titled "Challenge Content") before the tab went to the home page. Let it finish, then check the prescriptions page before trying again.

## Refilling
- Each prescription card has a refill button labeled "Refill Options for <DRUG>". It opens `Refill now` and `Add to cart`. `Add to cart`, then `Continue to cart (1)`, goes to `https://www.cvs.com/pharmacy/-/cart` and orders nothing.
- The cart shows how the order is fulfilled, the store, and the estimated price. `Change pickup location` lists nearby stores that have the prescription in stock; type the user's address in its search field. `Confirm` moves the prescription to that store with its remaining refills, and the old store's entry then reads "Transferred".
- `Check out` shows the review. `Place order` places the order and lands on the orders page with "Thanks for your order"; the order reads "Order received" at the chosen store.
- For a store refill the cart and checkout offered only pickup (September 2026). The "Ship to me" choice sits in an "Avoid Delays" box that CVS shows for an item the store cannot fill.

## Page behavior
- In a background tab the pages finish their own work slowly: the prescription list took about 7 s to appear. `wait` for the text you expect ("Place order", the drug name) rather than sleeping.
- The page keeps many closed, empty dialogs in the DOM ("Loading modal", "Prior authorization modal"); snapshots list them, and they can be ignored.

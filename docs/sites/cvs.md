---
name: CVS
hosts: cvs.com, www.cvs.com
---
# CVS

This is the user's pharmacy account: prescriptions, stores, and payment. Show the user the drug, the store, and the estimated price before `Place order`, and place it only after they say yes.

## Signed in or not
- Load `https://www.cvs.com/pharmacy/rx/prescriptions`. Signed in, it lists the prescriptions; signed out, the page sends the tab to `https://www.cvs.com/`.
- Signed in, the sign-in page (`/account-login/look-up`) also sends the tab to the home page, even in a background tab (about 10 s after loading `/account-login/one-time-passcode`, which goes through the look-up page), so a sign-in form that goes away by itself means the account is already signed in. Check the prescriptions page before signing in.
- The sign-in token lasts 15 minutes. Loading a page renews it from the "Keep me signed in" cookie, which lasts 30 days, even in a background tab two minutes after the token ran out. Not always: three times on 2026-09-27, once only minutes after a sign-in, the prescriptions page went to the home page instead, and the sign-in below was needed.

## Signing in
- Email first, then a one-time code or a passkey; there is no password step. `goto` `https://www.cvs.com/account-login/look-up`, click the email field, type the email, and click `Continue`. A "Passkey not recognized" dialog follows; `Sign in another way` goes to `/account-login/one-time-passcode`.
- That page shows its form, or with the "Keep me signed in" cookie goes to the home page by itself within about 10 s, with no code, and the prescription list loads.
- If it stays on "Choose how to get your code", pick `Email` and `Send code`. The code comes from info@alerts.cvs.com ("Your requested verification code from CVS"); by text it comes from 63641, read with `imessage_wait_code`. Never repeat it. A passkey prompt is the user's to approve.
- Try the sign-in once. The email step repeated 10 minutes after a failed try once brought Akamai's "Processing your request" page (an iframe titled "Challenge Content") and "It looks like you're having problems connecting". Let that page finish, then check the prescriptions page before trying again.

## Refilling
- Each prescription card has a refill button labeled "Refill Options for <DRUG>". It opens `Refill now` and `Add to cart`. `Add to cart`, then `Continue to cart (1)`, goes to `https://www.cvs.com/pharmacy/-/cart` and orders nothing.
- The cart shows how the order is fulfilled, the store, and the estimated price. `Change pickup location` lists nearby stores that have the prescription in stock; type the user's address in its search field. `Confirm` moves the prescription to that store with its remaining refills, and the old store's entry then reads "Transferred".
- `Check out` shows the review. `Place order` places the order and lands on the orders page with "Thanks for your order"; the order reads "Order received" at the chosen store.
- For a store refill the cart and checkout offered only pickup (September 2026). The "Ship to me" choice sits in an "Avoid Delays" box that CVS shows for an item the store cannot fill.

## Insurance
- `https://www.cvs.com/account/profile/insurance` lists the card types on file ("Insurance card on file for: Prescriptions", a date) but not the plan or member ID. After an order is rejected as "Pharmacy not in network", this page does not say which plan was billed.
- `Add insurance` goes to `/account/profile/insurance/add`, which asks for pictures of the card's front and back. The three file inputs sit inside the shadow roots of `cvs-file-upload` elements; `snapshot` shows them, and `upload` takes the ref of each one (the page has three, so a call without a ref refuses). `wait` for "Front of card image is uploaded".
- `Next` sends the pictures to CVS, which reads them. The next page, `/insurance/review`, comes back filled in: relationship "Self", plan name, member ID. For a California Medi-Cal card it read "California Medicaid (Medi-Cal)" and the right ID. Its submit button has no name in the snapshot (an icon-only `button`).
- On 2026-09-27 that submit failed nine times across two sessions with "Please try that again / Something went wrong on our end", and nothing was saved. The save call, a POST to `/mcapi/client/experience/v2/load/<id>`, returned HTTP 500 with CVS's generic error page, sent twice per click. It failed after a fresh sign-in, a clean upload, a `real_input` click, and with the plan name changed to "Medi-Cal Rx". `net` misses this call because the page kept its own copy of `fetch`; wrapping `Response.prototype.text` and `.json` from `eval --page` sees it.
- The other route is the order itself: a "Not filled" order has `Message the Pharmacy`, a dialog with the phone on file, a "Yes, I'd like a call back" box, a 490-character message, and `Send Message`. The store says it usually answers within an hour while open.
- The prescription number is not on the prescriptions page or the order page. On the order's details page, the drug's `Options` menu has `Prescription details` (`/pharmacy/rx/drug-information`), which shows strength, refills left, and directions. Its "Prescriber details" and "Prescription history" sections are collapsed buttons; clicking them shows the prescriber's phone and one "Rx <number>" per store, with earlier stores marked "Transferred".

## Page behavior
- The pages finish their own work a few seconds after loading: the prescription list took about 7 s to appear. `wait` for the text you expect ("Place order", the drug name) rather than sleeping.
- The page keeps many closed, empty dialogs in the DOM ("Loading modal", "Prior authorization modal"); snapshots list them, and they can be ignored.

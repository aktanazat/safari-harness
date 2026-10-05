---
name: Mercor
hosts: mercor.com, c-mercor.okta.com
---
# Mercor

Wait for the next page's words, not `quiet`: Mercor keeps a long-poll open (coil.mercor.com notifications), so a goto and a quiet wait took about 40 s on 10-04.

## Sign in
- work.mercor.com/login can stay blank (0 nodes, no requests) even after a reload. Open work.mercor.com/explore, click "Sign in", then "Google".
- Google opens in a popup tab (the click reports newTab); choose the account there, then go on in the first tab.

## Onboarding
- Phone number: type leaves the field at "+1 ". Use real_input: click the field, Cmd+A, type the digits, then press Tab so Continue enables.
- Date of birth: the calendar's year and month are selects (.rdp-years_dropdown, .rdp-months_dropdown) in the dialog. Set each with the native value setter and a bubbling change event, one eval per select.
- Country: clicking the combobox re-renders it under a new ref; snapshot before typing in it.

## Okta setup
- "Provision access" opens a c-mercor.okta.com reset-password tab. With an old Okta session in Safari it lands on /login/signout and shows "400 Bad Request" every time; run cookies clear on https://c-mercor.okta.com, then click Provision access again.
- The login is new to Apple Passwords: run passwords change with site c-mercor.okta.com and the account's email as username, then click Reset Password.
- "Set up security methods" is required next. "Security Key or Biometric Authenticator" makes a Touch ID passkey: click it, then hand off for Set up (only the user can approve). Done lands on /app/UserHome.
- The Okta step turns done only when Provision access is clicked again after the account is active: Mercor then reads the Okta user as active and moves to Payment setup.

## Tax form and payments
- The W-9 does not keep what was typed once the tab closes. Fill it in a tab the user will finish (keep), leave the SSN to him, and let him press "Agree and sign".
- Background check: "Start verification" with United States emails a Certn invite (no-reply@certn.co, "Background Screening Request From Mercor"); its apply link opens the Certn form.
- Payments: pick United States, then Stripe, then "Continue to Stripe". Stripe's email step needs real_input on Continue and may show an hCaptcha that clears itself, then texts a code (type with {{code}}). Stripe's form sits in a frame: click its buttons with real_input. A user with a Stripe Link account gets "Continue with Link", which pre-fills identity and payout bank; check the address there, it can be old. Stripe then asks for the full SSN, and "Agree and submit" warns that verification is still running; Submit anyway, and Mercor reads "Payments connected".
- ID verification is Persona: "Start verification" shows a QR code for the phone camera (App Clip, ID photo and selfie). Only the user can do it.
- The interview step ("Brief Introduction", about 4 minutes, camera and mic) can render blank on first load; reload it. Its page runs camera and mic checks before "Start interview". Only the user can record it, and the step can show not done again after it was done; the job's `interviewSatisfied` (below) says which.
- The sidebar counts "N of 13 steps done".

## Reading the account through Mercor's API
The page's own client calls Mercor's API with the user's session; get it in the page's world (`eval` with `page: true`) and call it from there:

```js
let req; self.webpackChunk_N_E.push([[Math.random()], {}, (r) => { req = r; }]);
const api = await req(24434).jT(); // base https://aws.api.mercor.com/work; the module number changes with Mercor's builds
const job = (await api.get("/jobs/<job id>")).data;
```

If the module number no longer gives a client, find the current one with `sh.scripts("aws.api.mercor.com")` (outside `page: true`) or read the requests the page makes with `net --url aws.api.mercor.com`. Do this once in a named `repl` session, not anew in every call.

- GET `/jobs/<job>`: the offer and its steps (`idVerification`, `interviewSatisfied`); `/jobs/<job>/id-verification/status`: Persona's own state (`session_status`); `/jobs/<job>/background-check`; `/v2/work-authorization`; `/geo/countries`. The profile is POST `/users` (GET answers 405).
- Accept: PATCH `/jobs/<job>/offer-acceptance` with `{acknowledge_offer_contingent_of_bgc: true}`. It checks the interview before the region: "You must complete an interview before accepting this offer" first, then the region.
- After Persona finishes, `id-verification/status` reads completed while the job's `idVerification` still reads "required"; that field did not block acceptance. Do not poll it waiting for a change.

## Offer not available in your region
- "This offer isn't available in your region" (400 from offer-acceptance) on 10-04 was a policy, not the network: support's assistant said Mercor had paused new projects and offers for Experts in California, and Experts not yet started cannot onboard. The user's network, work authorization, and the listing's location lists were all fine.
- When it appears, capture the failed response (`net --url offer-acceptance`, then its `body`), then ask support. Never suggest changing the stated location; that misstates where the user works.

## Help
- "Ask Maven" opens a side panel ("Ask Maven", a complementary region) with a "Message Maven" box; Enter sends. It is an AI only, with no human handoff, and answers in 30 to 60 s: wait with `changed` on the panel, and read `document.querySelector('[aria-label="Ask Maven"]').innerText`, not the first `aside`, which is the navigation sidebar.
- Mail to support@mercor.com is first answered by an AI ("Melvin") within about 2 minutes; ask in the same thread for a person.
- The whole help center is one text file, `https://talent.docs.mercor.com/llms-full.txt` (about 500 KB): fetch and search it instead of browsing.

## Earnings
- The payment report is emailed, not downloaded: the page says "Payment Report request sent". Read it from the account's mail.

---
name: Apple Developer
hosts: developer.apple.com, icloud.developer.apple.com, appstoreconnect.apple.com, idmsa.apple.com
---
# Apple Developer, App Store Connect, and CloudKit

The user's developer account: identifiers and capabilities, the CloudKit console, and App Store Connect. He wants these done in Safari with his sign-in; do not stop at the sign-in page. Show him any change to production (a schema deploy, a capability) before you save it.

## Signing in
- Signed out, `appstoreconnect.apple.com` goes to `login?...&authResult=FAILED`, and developer.apple.com and the CloudKit console go to `idmsa.apple.com/IDMSWebAuth/signin?...`.
- The sign-in form sits in an embedded frame, `#aid-auth-widget-iFrame`: "Email or Phone Number" (`#account_name_text_field`), `Continue`, and `Sign in with Passkey` (`#swp`). `snapshot` shows the frame's fields with refs.
- Sign in yourself; do not wait for him. `passwords {do: "fill", username: "aktanaazat@gmail.com"}` fills the email (the password field is hidden until Continue), a `real_input` click on `Continue` shows the password field, a second `fill` fills it, and a `click` on `#sign-in` signs in and lands on the page asked for. Enter does nothing on this form. Signed in this way on 2026-11-17 with no code asked.
- Only when Apple then asks for a code, or the vault has no login for idmsa.apple.com: `passwords {do: "code"}`, else a `real_input` click on `#swp` (Sign in with Passkey) and `handoff` for his Touch ID.

## CloudKit console
- `https://icloud.developer.apple.com/dashboard/`. A "What's New" dialog comes up again and again (three times in one session): click `Continue to CloudKit Console` each time.
- Schema lives under `/dashboard/database/teams/<team>/containers/<container>/env...`. The "Add field" control is a span with no role (aria-label "Add field", `data-testid=add-new-field-button`). Snapshots give such a control a ref when it shows a hand cursor; if its line has none, click the selector `[data-testid=add-new-field-button]`. A field's type is a dropdown: `select` with its `option` (for example "Bytes").
- A new record type may not exist yet: a `wait` for its name will miss. Check the list before waiting.
- To publish: `Deploy Schema Changes…` shows the difference from Production; confirm, then read the Production schema back to verify.
- Without Safari, `xcrun cktool import-schema` does the same, but it needs a management token the user creates in the console (`xcrun cktool get-teams` says "No management token found" until then). Creating one is his decision.

## Identifiers
- `https://developer.apple.com/account/resources/identifiers/list`, then the App ID. Its `App Services` tab holds MusicKit and WeatherKit; tick the box, `Save`, `Confirm`, then reload to verify.

---
name: Kaiser Permanente
hosts: kaiserpermanente.org, kp.org
---
# Kaiser Permanente

This is the user's health plan: MyChart messages, results, and the Kaiser pharmacy. Show the user any message, order, or form before you submit it, and submit only after they say yes.

## Signing in
- The sign-in page is on `identityauth.kaiserpermanente.org`, with fields `#userid` and `#password` and a `#submitButton`. Two logins are saved in Apple Passwords for that host, so `passwords` `fill` needs `username`; without it the call names both and fills nothing.
- `fill` waits for the user's Touch ID. The call now waits about two minutes, so the fill usually finishes inside it. If it still times out, the fill can land once the user approves: check the password field in a `snapshot` (a filled one reads `filled`) before calling `fill` again.
- After `#submitButton` the tab lands on a MyChart page (`/mychartcn/...`). The first page after sign-in can read "MyChart link error options"; loading `https://healthy.kaiserpermanente.org/mychartcn/Home` works.

## Finding pages
- Signed in, typed links to kp.org marketing and "learn" pages (`kp.org/newmember`, `/northern-california/learn/pharmacy/...`) stop on an `FdiRedirection` page that stays empty. Use the MyChart menu instead: `Menu`, then type in "Search the menu" (for example "transfer"), then click the result.
- Pharmacy pages open inside an iframe on `/northern-california/secure/pharmacy/...`, which fills in several seconds after the page loads; `wait` for the text you expect, then `snapshot` lists the frame's refs (`f<frame>:<n>`).

## Moving a prescription to Kaiser
- Menu, search "transfer", `Pharmacy transfer`, then `Transfer a prescription`. The intro says prescriptions with 0 refills, for pain or attention disorders, or for someone else may not transfer; `Continue`.
- The form asks for the drug name, the outside prescription number, strength, directions, whether refills remain (Yes or No), when it is needed (within 4, 7, or 14 business days, or not needed), and the outside pharmacy's name and phone. `Continue`, then `Add another prescription` or `Continue`.
- Each added prescription shows a "Use the same pharmacy as for the previous prescription." checkbox, checked, in place of the pharmacy fields; `type` on the hidden pharmacy fields fails with "element is not editable". For a different store, click its label to uncheck it, and the name and phone fields return. The page's frame is same-origin, so `eval` can read the checkbox (`#sameAsPreviousRX`) through `iframe.contentDocument`.
- Next come medication allergies (a checkbox list, "No known medication allergies", and a free-text box), then `Review & submit`, which shows the contact email and phones. `Submit` shows "Transfer submitted".
- A transfer does not order anything. Kaiser contacts the user by email, phone, or text, the drug appears on the Medication List when the transfer is done, and ordering it (free mail order) is a separate step.

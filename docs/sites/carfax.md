---
name: CARFAX
hosts: carfax.com
---
# CARFAX

Vehicle history reports, and for some cars the original window sticker. The public pages need no sign-in.

## Reading
- On 2026-09-28 CARFAX turned both routes away: `read` of `https://www.carfax.com/vehicle/<VIN>` returned HTTP 403, and all 11 dealer-linked `vehiclehistory/ar20/...` reports opened through `map` hit a DataDome bot wall. Its wall shows the title "carfax.com" only and a snapshot with no nodes. When a result carries `challenge`, call `handoff` for the one report that matters; do not wait again, and do not open a batch of them.
- Earlier, the public `https://www.carfax.com/vehicle/<VIN>` page read without Safari and carried the "View Original Window Sticker" link when CARFAX had the sticker; a VIN it did not know gave "404 - Page Not Found". In Safari, `ar20` reports loaded ("CARFAX Vehicle History Report"; `wait` for "Ownership History"), and `read` of a `vehiclehistory/ccl/...` report returned HTTP 403.
- A dealer's own inventory data often carries CARFAX's one-owner flag and badge without opening a report (Dealer Inspire's `history_report` field).
- A dealer page's CARFAX link often opens a new tab: continue in the click's `newTab`, and close it.

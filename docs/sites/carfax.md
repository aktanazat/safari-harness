---
name: CARFAX
hosts: carfax.com
---
# CARFAX

Vehicle history reports, and for some cars the original window sticker. The public pages need no sign-in.

## Reading
- `https://www.carfax.com/vehicle/<VIN>` is public: `read` returns its text, which is faster than Safari. It carries the "View Original Window Sticker" link when CARFAX has the sticker; a VIN it does not know gives "404 - Page Not Found".
- The same page in Safari once showed a bot wall: the title was only "carfax.com", the snapshot had no nodes, and two waits (15 s, 20 s) timed out. When a result carries `challenge`, call `handoff`; do not wait again.
- Full reports linked from dealer pages differ by path. `read` of a `vehiclehistory/ccl/...` report returned HTTP 403. In Safari, `vehiclehistory/ar20/...` reports loaded ("CARFAX Vehicle History Report"); `wait` for "Ownership History".
- A dealer page's CARFAX link often opens a new tab: continue in the click's `newTab`, and close it.

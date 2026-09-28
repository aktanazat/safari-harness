---
name: Cars.com
hosts: cars.com
---
# Cars.com

Public dealer listings and dealer reviews. No sign-in needed.

## Search
- `read` of a cars.com search returns HTTP 403; Safari loads it.
- Each result is a `fuse-card` whose `data-vehicle-details` attribute is JSON for the car. Read them all with one `eval`.
- The page spaces some model names ("M240 i xDrive"), so a `wait` for "M240i" missed for 20 s. Wait for the selector `fuse-card[data-vehicle-details]` instead of the model's name.

## A listing
- `https://www.cars.com/vehicledetail/<id>/`, titled "Used <year> <make> <model> For Sale $<price> | Cars.com".
- One listing once read "Just a moment..." (a Cloudflare check) while others loaded. That is a bot check: `handoff` in a session with the user, report it in a routine.

## Dealer reviews
- `https://www.cars.com/dealers/<id>/<slug>/reviews/?page=N&page_size=50&sort_by=LowestRated`. `wait` for "Show full review".

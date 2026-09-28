---
name: Autotrader
hosts: autotrader.com
---
# Autotrader

Public dealer listings. No sign-in needed.

## Search
- Model-path addresses such as `/cars-for-sale/used-cars/bmw/m240/<city>-ca?...` redirected to a generic "Used 2025 BMW Cars for Sale" page, and waits for the model missed.
- What worked: `/cars-for-sale/<year>/<make>/<series>/<city>-ca?searchRadius=<miles>&zip=<zip>&numRecords=100` (for example `/cars-for-sale/2025/bmw/2-series/...`), then `wait` for the selector `[data-cmp=inventoryListing]`. The query form `/cars-for-sale/used-cars/<city>-ca?makeCode=BMW&modelCode=<code>&startYear=...&zip=<zip>&numRecords=100` also works; `wait` for "Matches".
- The page's `script[type="application/ld+json"]` of `@type` `CollectionPage` lists the cars as JSON; read it with one `eval`.
- `keywordPhrases=<VIN>` in the search address finds one car.

## A listing
- `https://www.autotrader.com/cars-for-sale/vehicle/<id>`.

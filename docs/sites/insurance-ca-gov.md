---
name: California Department of Insurance
hosts: insurance.ca.gov
---
# California Department of Insurance

The state auto premium comparison tool runs at interactive.web.insurance.ca.gov. For many companies at once, the spreadsheets linked from www.insurance.ca.gov/01-consumers/105-type/9-compare-prem/auto-profiles.cfm are faster than the form.

## Comparison tool
- Start at interactive.web.insurance.ca.gov/apex_extprd/f?p=111:10. "Go to Comparison Tool" is an input button that text search misses; click its ref.
- Fill the selects in order: P11_TYPE, P11_LOCATION, P11_INSURANCE_FOR, P11_YEARS_LICENSED, P11_MILEAGE, P11_RECORD, P11_VEHICLE. Each fills only after the one before it changes.
- Submit with `input[value=Submit]`; results load at a URL ending P11_SUBMIT:Y.
- Discounts open per company by NAIC code, for example DiscountModal('17511') for GEICO.

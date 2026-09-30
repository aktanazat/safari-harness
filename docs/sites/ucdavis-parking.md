---
name: UC Davis Parking
hosts: ucdavis.aimsparking.com
---
# UC Davis Parking

Parking citations are paid at ucdavis.aimsparking.com. /citations and /pay-citation show an error page ("System Message" or "AIMS Web 9 Error"); the home page link "Pay Citation or Invoice" goes to /tickets/. transportation.ucdavis.edu/parking/invoice-program is a 404.

## Looking up a ticket
- /tickets/ needs no sign-in. It takes a ticket number and a plate or VIN, then Search.
- Setting field values from `eval` and submitting the form returns "System Message". Fill the fields with `type` instead; that path is not yet confirmed.

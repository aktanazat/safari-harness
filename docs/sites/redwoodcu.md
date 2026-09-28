---
name: Redwood Credit Union
hosts: redwoodcu.org, app.consumer.meridianlink.com, app.loanspq.com
---
# Redwood Credit Union

Auto-loan rates are public on redwoodcu.org. Loan applications and their status live on MeridianLink's consumer portal, which Redwood links to. Never submit an application or accept an offer without the user's yes.

## Rates
- `https://www.redwoodcu.org/loans/vehicle/auto-loan/` ("Car Loans Bay Area & San Francisco | Redwood Credit Union"). Guessed paths such as `/loans/auto-loans` return "Page not found - Redwood Credit Union".
- The page is public, so `read` reaches it too.
- The rate tables sit in tab panels, one per credit-score band, and only the first is visible. Each group is a `.ratecu-loan-table`; its tab links (`.ratecu-tabs a`, "Credit Score (720+)", "(700-719)", ...) point at `#tablecont-...`, which names their `.js-tabs__panel`. One `eval` that reads each link's text and its panel's `tbody tr` cells gets every band without clicking.
- Under the tables: "Rates are effective <date> and are subject to change without notice."

## Application status
- The status page is under the auto-loan page's `Apply Now` section (`#apply`): "Check on my application status", which goes to `https://app.consumer.meridianlink.com/cu/ViewSubmittedLoans.aspx?lenderref=Redwoodcu53018`.
- Links in the application emails point at `app.loanspq.com/cu/ViewSubmittedLoans.aspx?enc=...`, which failed to open. The same path on `app.consumer.meridianlink.com` works.
- The page, "Application Status", asks for "Last Name" and "Email", then `Send Email Authentication`. It then shows "Security Code Emailed" and a "Security Code (Sent to Email)" field with `Get Status`.
- The code comes by email from APAdmin@meridianlink.com ("Please enter the following security code to check the status of your application(s)."). It mixes letters and digits, so a six-digit pattern misses it. It works once. Never repeat it.
- After `Get Status`, "Processing your request... This may take a few minutes.", then "Applications": one row per application from the last 90 days ("<Type> Application #<n>" and a status such as Instant Approved, Incomplete, Canceled, Approved), each with "Messages", "Upload", and "Documents". The page notes that any approval shown is conditional. `Send Email Authentication to Refresh Status` starts over with a new code.
- "Messages" is a div; a click on its ref did nothing. The button that opens it is `.function-btn[loan_num="<n>"][onclick*="Message"]`, clicked from `eval`. The popup `#viewMessage` shows the "Conversation Log" and a "Type your message here" box with `Send Message`.

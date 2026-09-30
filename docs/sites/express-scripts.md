---
name: Express Scripts
hosts: express-scripts.com
---
# Express Scripts

The pharmacy benefit site. Its password reset has no email-only route.

## Password reset
- www.express-scripts.com/recover/password asks for first name, last name, and date of birth, then a Member ID, SSN, or Rx number. None of these is in Gmail or mail.ru, so ask the owner for one.
- The page can stop answering right after it opens ("did not answer within 5 s"). A `goto` to the same address and a retry worked.

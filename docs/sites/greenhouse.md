---
name: Greenhouse
hosts: job-boards.greenhouse.io, boards.greenhouse.io
---
# Greenhouse

Application forms at `job-boards.greenhouse.io/<company>/jobs/<job id>`. The form sits under the job description on the same page.

## Filling
- Text fields (`#first_name`, `#email`, `#question_<id>`) take `type`. The resume is `upload` on `[id="resume"]`; once a file is attached, that input is gone and the field shows the file name with a "Remove file" button.
- Dropdowns are comboboxes: click the field, type to filter, pick the option. An option with a long label (work authorization, sponsorship) may not match typed text; open the list with ArrowDown and pick it by position. The chosen answer shows in `.select__single-value`.

## Submitting
- Click "Submit application" with `real_input`. A scripted `click` on it once returned "There was an error processing your application. Please try again." and sent nothing.
- The form then asks for a security code: "A verification code was sent to <email>. To submit your application, enter the 8-character code to confirm you're a human." The mail comes from `no-reply@us.greenhouse-mail.io`, subject "Security code for your application to <Company>", with the code after "security code field on your application:". It mixes letters and digits and is case sensitive.
- The code goes in eight one-character boxes, `#security-input-0` to `#security-input-7`; `type` one character into each. Then click "Submit application" again with `real_input`.
- Submitted: the address ends in `/confirmation` and the page says "Thank you for applying." A "Thank you for applying to <Company>" email follows.

## Resume lost after an extension restart
After tab ids changed, one form still showed the resume's file name, yet Submit failed with "Resume/CV is required." Click "Remove file", upload the resume again, then submit.

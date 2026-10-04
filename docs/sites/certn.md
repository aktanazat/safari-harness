---
name: Certn
hosts: certn.co
---
# Certn

## Applicant form
- The invite's sign-up page offers "Continue with Google"; that avoids a new password.
- Consent signature: a react-signature-canvas pad. Synthetic pointer events draw nothing, and mouse events sent in one burst leave only dots, because its move handler is throttled. In a page eval, set the pad's `_strokeMoveUpdate` to its prototype's `_strokeUpdate` (the pad is `_sigPad` on the fiber above `canvas.signature-canvas`), then send mousedown and mousemove to the canvas and mouseup to the document. Scroll the consent viewer to the bottom first; an acknowledgement checkbox appears after the signature.
- Address: a Google Places combobox. Typing does not open the list; type with real_input, then send ArrowDown to the input, then click the option with pointer and mouse events. Choosing it fills county, city, and ZIP; add the unit by hand.
- Region-specific notices come one per page, and each "I acknowledge" checkbox shows only after its text is scrolled to the bottom. Next can take several seconds to move on.
- The SSN field comes last, before Review & Submit; leave it to the user.

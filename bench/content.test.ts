import { expect } from "bun:test";
import { benchRows } from "./bench.ts";

// content.js as it answers in Safari's WebKit, one page per behavior in
// bench/fixtures. Refs count from 1 in each fresh page; a comment on a
// setup snapshot names the refs the steps after it use.
benchRows("content.js in WebKit", [
  {
    name: "a snapshot leaves out text hidden by display, visibility, or opacity, but keeps text fading in",
    page: "hidden.html",
    steps: [{ op: "snapshot", answer: { value: { snapshot: "This sentence is shown on the page.\nThis sentence is fading in." } } }],
  },
  {
    name: "a snapshot that keeps hidden text still leaves out script, style, and noscript source",
    page: "source.html",
    steps: [{ op: "snapshot", args: [{ showHidden: true }], answer: { value: { snapshot: "Shown text. · Collapsed menu text." } } }],
  },
  {
    name: "a snapshot leaves out words no one sees, keeps a shown child of a hidden wrapper, and names a control by its screen-reader label",
    page: "unseen.html",
    steps: [{ op: "snapshot", answer: { value: { snapshot: 'Workspace shown inside a hidden wrapper.\nh2 "Gradient heading"\n[1] button "Close dialog"\nShown words.' } } }],
  },
  {
    name: "extract leaves out words no one sees and keeps a shown child of a hidden wrapper",
    page: "unseen.html",
    steps: [{ op: "extract", answer: { value: { text: "Workspace shown inside a hidden wrapper.\n\nGradient heading\n\nShown words." } } }],
  },
  {
    name: "a snapshot reads open shadow roots, with slotted text where its slot is drawn",
    page: "shadow.html",
    steps: [{ op: "snapshot", answer: { value: { snapshot: 'h2 "Ada Lovelace"\n[1] button "Follow"' } } }],
  },
  {
    name: "a snapshot gives each field's state, and a password field's value never",
    page: "form.html",
    steps: [{
      op: "snapshot",
      answer: {
        value: {
          snapshot: [
            '[1] label "Email"',
            '  [2] textbox "Email" {value="ada@example.com"}',
            '[3] label "Password"',
            '  [4] textbox "Password" {filled}',
            '[5] label "Remember me"',
            '  [6] checkbox "Remember me" {checked, value="on"}',
            '[7] label "Plan"',
            '  [8] combobox "Plan" {value="Pro", 2 options}',
            '[9] button "Sign in"',
          ].join("\n"),
        },
      },
    }],
  },
  {
    name: "a new password fills a form that shows it as text, into the field marked new-password and the repeat field named so",
    page: "shown-password.html",
    steps: [
      { op: "fillNewPassword", args: ["", null, "correct horse"], answer: { value: { ok: true, filled: ["new password", "confirm password"] } } },
      { op: "click", args: ["Change password"] },
      { op: "extract", answer: { value: { text: expect.stringContaining("Password changed") } } },
    ],
  },
  {
    name: "a new password fills a reset form whose only marked field is the repeat, into the unmarked field before it too",
    page: "repeat-only.html",
    steps: [
      { op: "fillNewPassword", args: ["", null, "correct horse"], answer: { value: { ok: true, filled: ["new password", "confirm password"] } } },
      { op: "click", args: ["Reset password"] },
      { op: "extract", answer: { value: { text: expect.stringContaining("Password reset") } } },
    ],
  },
  {
    name: "a new password fills a lone field that only its placeholder calls new",
    page: "new-password-placeholder.html",
    steps: [
      { op: "fillNewPassword", args: ["", null, "correct horse"], answer: { value: { ok: true, filled: ["new password"] } } },
      { op: "click", args: ["Save"] },
      { op: "extract", answer: { value: { text: expect.stringContaining("New password saved") } } },
    ],
  },
  {
    name: "a login fills the login form, not a sign-up form before it whose repeat password is unmarked",
    page: "signup-login.html",
    steps: [
      { op: "fillLogin", args: ["", "ada@example.com", "hunter2"], answer: { value: { ok: true, filled: ["username", "password"] } } },
      { op: "click", args: ["Sign in"] },
      { op: "extract", answer: { value: { text: expect.stringContaining("Signed in as ada@example.com") } } },
    ],
  },
  {
    name: "a code typed as a secret into the first of six digit boxes with no length limit goes one digit to a box, and no box shows its digit",
    page: "digit-boxes.html",
    steps: [
      { op: "snapshot" }, // [1] Digit 1 of 6
      { op: "type", args: ["1", "402913", { secret: true }], answer: { value: { ok: true, kept: true } } },
      { op: "snapshot", answer: { value: { snapshot: expect.not.stringContaining("value=") } } },
      { op: "click", args: ["Submit"] },
      { op: "extract", answer: { value: { text: expect.stringContaining("Code accepted") } } },
    ],
  },
  {
    name: "a code typed as a secret into the first of six one-character boxes goes one digit to a box",
    page: "code-boxes.html",
    steps: [
      { op: "snapshot" }, // [1] Digit 1 of 6
      { op: "type", args: ["1", "402913", { secret: true }], answer: { value: { ok: true, kept: true } } },
      { op: "click", args: ["Submit"] },
      { op: "extract", answer: { value: { text: expect.stringContaining("Code accepted") } } },
    ],
  },
  {
    name: "typing on a label's ref types into the field it labels",
    page: "form.html",
    steps: [
      { op: "snapshot" }, // [1] label "Email"
      { op: "type", args: ["1", "grace@example.com"], answer: { value: { ok: true, kept: true } } },
    ],
  },
  {
    name: "select on a label's ref picks from the list it labels",
    page: "form.html",
    steps: [
      { op: "snapshot" }, // [7] label "Plan"
      { op: "select", args: ["7", "Free"], answer: { value: { ok: true, value: "Free" } } },
    ],
  },
  {
    name: "a snapshot reads a srcdoc frame as part of the page, as Safari runs no script in one",
    page: "srcdoc.html",
    steps: [{ op: "snapshot", answer: { value: { snapshot: '[1] iframe "Inline"\n  Inline frame text\n  [2] button "Inline button"' } } }],
  },
  {
    name: "a snapshot marks a frame running its own copy with that copy's token, where its lines go",
    page: "frames.html",
    frames: 1,
    steps: [{ op: "snapshot", answer: { value: { snapshot: '[1] iframe "Child" @@frame:<frame.html>@@' } } }],
  },
  {
    name: "a frame's own copy snapshots its document, its refs carrying the frame's prefix",
    page: "frames.html",
    frames: 1,
    steps: [{ op: "snapshot", args: [{ refPrefix: "f1:" }], frame: "frame.html", answer: { value: { snapshot: '[f1:1] button "Frame button"' } } }],
  },
  {
    name: "a click on a ref presses the element the snapshot gave that ref",
    page: "click.html",
    steps: [
      { op: "snapshot" }, // [1] Press
      { op: "click", args: ["1"], answer: { value: { ok: true } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Pressed 1 times") } } },
    ],
  },
  {
    name: "a click on a ref whose element left the page says the ref is stale",
    page: "click.html",
    steps: [
      { op: "snapshot" }, // [2] Remove the next button, [3] Doomed
      { op: "click", args: ["2"] },
      { op: "click", args: ["3"], answer: { error: "stale ref 3; re-run snapshot" } },
    ],
  },
  {
    name: "a click on a ref whose element the page drew anew presses the element that took its place, and says so",
    page: "heal.html",
    steps: [
      { op: "snapshot" }, // [1] Save, [4] Redraw
      { op: "click", args: ["4"] },
      { op: "click", args: ["1"], answer: { value: { ok: true, healed: { ref: "1", now: "7" } } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Saved") } } },
    ],
  },
  {
    name: "real_input's press from behind is left to the real mouse on a select, a date or color input, and a label of a file input, which open Safari's own windows",
    page: "pickers.html",
    steps: [
      { op: "pressMark", args: ["#plan"], answer: { value: { picker: true } } },
      { op: "pressMark", args: ["#day"], answer: { value: { picker: true } } },
      { op: "pressMark", args: ["#shade"], answer: { value: { picker: true } } },
      { op: "pressMark", args: ["#upload"], answer: { value: { picker: true } } },
      { op: "pressMark", args: ["#go"], answer: { value: { mark: expect.stringMatching(/^__sh_press_/) } } },
    ],
  },
  {
    name: "a ref drawn anew finds its own row's control by the text beside it, after the rows moved",
    page: "heal.html",
    steps: [
      { op: "snapshot" }, // [3] Bob's Delete, [6] Sort (Bob before Alice)
      { op: "click", args: ["6"] },
      { op: "click", args: ["3"], answer: { value: { ok: true, healed: { ref: "3", now: "7" } } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Deleted Bob") } } },
    ],
  },
  {
    name: "a ref drawn anew as one of lookalikes it cannot tell apart stays stale",
    page: "heal.html",
    steps: [
      { op: "snapshot" }, // [1] Save, [5] Redraw twice
      { op: "click", args: ["5"] },
      { op: "click", args: ["1"], answer: { error: "stale ref 1; re-run snapshot" } },
    ],
  },
  {
    name: "typing replaces a text field's value, with the input event the page listens for",
    page: "type.html",
    steps: [
      { op: "snapshot" }, // [1] Name
      { op: "type", args: ["1", "Ada"], answer: { value: { ok: true, kept: true } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Page saw Ada") } } },
    ],
  },
  {
    name: "typing replaces a contenteditable's text",
    page: "type.html",
    steps: [
      { op: "snapshot" }, // [2] Notes
      { op: "type", args: ["2", "New notes"], answer: { value: { ok: true, kept: true } } },
    ],
  },
  {
    name: "typing into a Flutter field reaches the page's own model once the page has taken the field, so its Log In sees the text",
    page: "flutter-field.html",
    steps: [
      { op: "snapshot" }, // [1] User ID, [3] Log In
      { op: "type", args: ["1", "ada"], answer: { value: { ok: true, kept: true } } },
      { op: "click", args: ["3"] },
      { op: "extract", answer: { value: { text: expect.stringContaining("Signed in as ada") } } },
    ],
  },
  {
    name: "a login filled into Flutter fields reaches the page's own model",
    page: "flutter-field.html",
    steps: [
      { op: "fillLogin", args: ["", "ada", "hunter2"], answer: { value: { ok: true, filled: ["username", "password"] } } },
      { op: "click", args: ["Log In"] },
      { op: "extract", answer: { value: { text: expect.stringContaining("Signed in as ada with a password") } } },
    ],
  },
  {
    name: "a Flutter field the page holds already, after a click or a type, takes more text at once",
    page: "flutter-field.html",
    steps: [
      { op: "snapshot" }, // [1] User ID, [3] Log In
      { op: "click", args: ["1"] },
      { op: "type", args: ["1", "ada"], answer: { value: { ok: true, kept: true } } },
      { op: "type", args: ["1", " lovelace", { append: true }], answer: { value: { ok: true, kept: true } } },
      { op: "click", args: ["3"] },
      { op: "extract", answer: { value: { text: expect.stringContaining("Signed in as ada lovelace") } } },
    ],
  },
  {
    name: "a new password filled into a Flutter field reaches the page's own model",
    page: "flutter-field.html",
    steps: [
      { op: "fillNewPassword", args: ["", null, "correct horse"], answer: { value: { ok: true, filled: ["new password"] } } },
      { op: "click", args: ["Save"] },
      { op: "extract", answer: { value: { text: expect.stringContaining("New password saved") } } },
    ],
  },
  {
    name: "a rich editor's contenteditable with no role or label is a textbox with a ref, and typing on the ref reaches it",
    page: "prosemirror.html",
    steps: [
      { op: "snapshot", answer: { value: { snapshot: "[1] textbox\n  First line · Second line" } } },
      { op: "type", args: ["1", "New notes"], answer: { value: { ok: true, kept: true } } },
    ],
  },
  {
    name: "select picks an option by its label, with the change event the page listens for",
    page: "select.html",
    steps: [
      { op: "snapshot" }, // [1] Plan
      { op: "select", args: ["1", "Pro"], answer: { value: { ok: true, value: "Pro" } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Page saw pro") } } },
    ],
  },
  {
    name: "select with an option the list lacks names the options it has",
    page: "select.html",
    steps: [
      { op: "snapshot" }, // [1] Plan
      { op: "select", args: ["1", "Team"], answer: { error: 'no option "Team"; options: Free | Pro' } },
    ],
  },
  {
    name: "a dropdown the page draws itself gives each option floating over the page a ref, and a click on one picks it, while text under a hand cursor with no control behind it stays text",
    page: "dropdown.html",
    steps: [
      { op: "snapshot" }, // [2] the list's trigger
      { op: "click", args: ["2"] },
      {
        op: "snapshot",
        answer: {
          value: {
            snapshot: [
              '[1] label "Housing Status Choose"',
              "  [2] div",
              "    Choose",
              "Plain text under a hand cursor.",
              "A banner under the same hand.",
              "[3] div",
              "  Mortgage",
              "[4] div",
              "  Rent",
              "[5] div",
              "  Other",
            ].join("\n"),
          },
        },
      },
      { op: "click", args: ["4"] },
      { op: "extract", answer: { value: { text: expect.stringContaining("Page saw Rent") } } },
    ],
  },
  {
    name: "a click on a disabled button says it is disabled rather than that it pressed it",
    page: "disabled.html",
    steps: [
      { op: "snapshot" }, // [5] button "Authorize" {disabled}
      { op: "click", args: ["5"], answer: { error: "that control is disabled, so a click would do nothing: the page enables it once its form is complete, or, on a few sites, once its window is in front (call window, then activate)" } },
    ],
  },
  {
    name: "typing into a disabled field says it is disabled rather than that the text was kept",
    page: "disabled.html",
    steps: [
      { op: "snapshot" }, // [2] textbox "Name" {disabled}
      { op: "type", args: ["2", "Ada"], answer: { error: "that field is disabled, so the page would ignore text typed into it" } },
    ],
  },
  {
    name: "select on a disabled list says it is disabled rather than that the option was chosen",
    page: "disabled.html",
    steps: [
      { op: "snapshot" }, // [4] combobox "Plan" {disabled}
      { op: "select", args: ["4", "Pro"], answer: { error: "that list is disabled, so the page would ignore a choice made in it" } },
    ],
  },
  {
    name: "a click on a submit still disabled after type filled its form says the page did not take scripted typing",
    page: "typed-disabled.html",
    steps: [
      { op: "snapshot" }, // [1] Email, [2] Reset password {disabled}
      { op: "type", args: ["1", "ada@example.com"], answer: { value: { ok: true, kept: true } } },
      { op: "click", args: ["2"], answer: { error: expect.stringContaining("real_input type") } },
    ],
  },
  {
    name: "a button made of an input is named by its value, and an image button by its alt",
    page: "input-buttons.html",
    steps: [
      { op: "snapshot", answer: { value: { snapshot: '[1] button "Place order"\n[2] button "Add to cart"\n[3] button "Search"' } } },
      { op: "click", args: ["Add to cart"] },
      { op: "extract", answer: { value: { text: expect.stringContaining("Added to cart") } } },
    ],
  },
  {
    name: "a price field that rewrites the typed figures as dollars and cents keeps them",
    page: "currency.html",
    steps: [
      { op: "snapshot" }, // [1] Price
      { op: "type", args: ["1", "1234"], answer: { value: { ok: true, kept: true } } },
    ],
  },
  {
    name: "a field the page marks invalid a moment after typing says what the page said",
    page: "card-field.html",
    steps: [
      { op: "snapshot" }, // [1] Card number
      { op: "type", args: ["1", "4111"], answer: { value: { ok: true, kept: true, invalid: "Invalid card number" } } },
    ],
  },
  {
    name: "a selector matching a field behind an open dialog and one in it types into the dialog's",
    page: "dialog-field.html",
    steps: [
      { op: "type", args: ["input[type=email]", "ada@example.com"], answer: { value: { ok: true, kept: true } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Dialog saw ada@example.com") } } },
    ],
  },
  {
    name: "a wait for text answers found once the page's timer has added it",
    page: "wait.html",
    steps: [
      { op: "click", args: ["Search"] }, // adds "Results are ready" 300 ms later
      { op: "wait", args: [null, { text: "results are ready" }], answer: { value: { found: true } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Results are ready") } } },
    ],
  },
  {
    name: "a wait whose text shows when it begins says it held already",
    page: "wait.html",
    steps: [{ op: "wait", args: [null, { text: "Search" }], answer: { value: { found: true, already: true } } }],
  },
  {
    name: "a wait for text to go that was never on the page says so rather than that it went",
    page: "wait.html",
    steps: [{ op: "wait", args: [null, { gone: "never on this page" }], answer: { value: { found: true, already: true, hint: expect.stringContaining("never on this page") } } }],
  },
  {
    name: "a wait for text with a bar in it waits for any of its parts, and says which showed",
    page: "wait.html",
    steps: [
      { op: "click", args: ["Search"] }, // adds "Results are ready" 300 ms later
      { op: "wait", args: [null, { text: "nothing here|results are ready" }], timeout: 2000, answer: { value: { found: true, which: "results are ready" } } },
    ],
  },
  {
    name: "a changed wait answers the chat's reply, not the line the agent sent, a typing note, or a read receipt",
    page: "chat.html",
    steps: [
      { op: "type", args: ["Message", "please waive the fee"] },
      { op: "click", args: ["Send"] }, // echoes the line 1 s later, then a receipt, then the reply
      { op: "wait", args: [null, { changed: true }], timeout: 3000, answer: { value: { found: true, added: ["Agent: Your fee was waived"] } } },
    ],
  },
  {
    name: "a changed wait counts a reply that came between two waits",
    page: "chat.html",
    steps: [
      { op: "type", args: ["Message", "hello"] },
      { op: "click", args: ["Send"] },
      { op: "wait", args: [null, { changed: true }], timeout: 3000, answer: { value: { found: true, added: ["Agent: Your fee was waived"] } } },
      { op: "click", args: ["Later"] }, // replies 300 ms later
      { op: "wait", args: [null, { text: "A second reply" }], timeout: 2000 },
      { op: "wait", args: [null, { changed: true }], timeout: 2000, answer: { value: { found: true, added: ["Agent: A second reply"] } } },
    ],
  },
  {
    name: "a wait for text on a Flutter page finds words that only its semantics labels hold",
    page: "flutter-label.html",
    steps: [{ op: "wait", args: [null, { text: "Get an Email" }], timeout: 2000, answer: { value: { found: true } } }],
  },
  {
    name: "a snapshot of a page still drawing, with only a control no one sees on it yet, waits for the page to draw",
    page: "drawing.html",
    // the page draws 800 ms after it loads
    steps: [{ op: "snapshot", answer: { value: { snapshot: '[1] link "Skip to main content"\nh1 "Verify your identity"\n[2] button "Next"' } } }],
  },
  {
    name: "a snapshot of a page with nothing on it yet waits for the page to draw",
    page: "blank.html",
    // the page draws its form 800 ms after it loads
    steps: [{ op: "snapshot", answer: { value: { snapshot: '[1] button "Sign in"' } } }],
  },
  {
    name: "a snapshot of a page that never draws answers, with nothing, once the wait runs out, and says the page drew nothing",
    page: "empty.html",
    steps: [{ op: "snapshot", answer: { value: { nodes: 0, snapshot: "", hint: expect.stringContaining("drawn nothing yet") } } }],
  },
  {
    name: "a snapshot of a Flutter page clicks its Enable accessibility placeholder and waits for the controls Flutter then builds",
    page: "flutter.html",
    // Flutter builds them 50 ms after the click; the page shows words meanwhile
    steps: [{ op: "snapshot", answer: { value: { snapshot: 'Code editor text.\n[1] button "Log In"' } } }],
  },
  {
    name: "a query read of a page still drawing waits for the page to draw what it asks for",
    page: "drawing.html",
    steps: [{ op: "snapshot", args: [{ query: "next" }], answer: { value: { snapshot: '[1] button "Next"' } } }],
  },
  {
    name: "a root read of a page with nothing on it yet waits for the root to be drawn",
    page: "blank.html",
    steps: [{ op: "snapshot", args: [{ root: "button" }], answer: { value: { snapshot: '[1] button "Sign in"' } } }],
  },
  {
    name: "extract reads the main region as drawn: shadow text in, hidden text and one-pixel decoys out",
    page: "extract.html",
    steps: [{ op: "extract", answer: { value: { text: "Pricing\n\nPro costs $12 a month.\n\nCode: BENCH\n\nBilled yearly" } } }],
  },
  {
    name: "extract reads the dialog open over the page, and says how to read the page behind it",
    page: "modal.html",
    steps: [{ op: "extract", answer: { value: { text: expect.stringMatching(/^Billing\s+Max plan, renews Oct 1\.\s+Close$/), note: expect.any(String) } } }],
  },
  {
    name: "extract reads the whole page when its main region holds little of its text, and says so",
    page: "thin-main.html",
    steps: [{ op: "extract", answer: { value: { text: expect.stringContaining("renews October 12"), note: expect.any(String) } } }],
  },
  {
    name: "extract of a page whose lines hold only placeholder characters waits for its text",
    page: "filler.html",
    // the page puts its text in 800 ms after it loads
    steps: [{ op: "extract", answer: { value: { text: "Reports\n\nReport 1234 was resolved." } } }],
  },
  {
    name: "an extract query that matches no line says so in a note, a leading (?i) is dropped, and a query written as a regex is told it is plain text",
    page: "click.html",
    steps: [
      { op: "extract", args: [{ query: "nothing like this" }], answer: { value: { text: "", note: expect.stringContaining('"nothing like this"') } } },
      { op: "snapshot", args: [{ query: "(?i)pressed" }], answer: { value: { snapshot: expect.stringContaining("Pressed 0 times") } } },
      { op: "snapshot", args: [{ query: "^Pressed" }], answer: { value: { nodes: 0, hint: expect.stringContaining("plain text") } } },
    ],
  },
  {
    name: "a root or selector that matches nothing on a drawn page is named in the error, with how to read the whole page",
    page: "click.html",
    steps: [
      { op: "snapshot", args: [{ root: "main" }], answer: { error: 'nothing on the page matches root "main"; leave root out to read the whole page' } },
      { op: "extract", args: [{ selector: "main" }], answer: { error: 'nothing on the page matches selector "main"; leave selector out to read the whole page' } },
      { op: "extract", args: [{ selector: "main", as: "table" }], answer: { error: 'nothing on the page matches selector "main"; leave selector out to read the whole page' } },
    ],
  },
  {
    name: "after a takeover, a window the page opens is announced to the extension once, by the fresh copy",
    page: "popup.html",
    steps: [
      { takeover: true },
      { op: "click", args: ["Open"] },
      {
        sent: true,
        answer: {
          value: [
            { load: 1, message: { __safariHarnessReady: 1 } },
            { load: 2, message: { __safariHarnessReady: 1 } },
            { load: 2, message: { __safariHarnessPopup: 1 } },
          ],
        },
      },
    ],
  },
  {
    name: "a wait the old copy still held ends at a takeover, and stops watching the page",
    page: "popup.html",
    steps: [
      // the extension gives up on the answer; the wait stays open in the page
      { op: "wait", args: [null, { text: "never on this page" }], timeout: 100, answer: { error: "bench: wait did not answer within 100 ms" } },
      { takeover: true },
      {
        sent: true,
        answer: {
          value: [
            { load: 1, message: { __safariHarnessReady: 1 } },
            { load: 2, message: { __safariHarnessReady: 1 } },
            { load: 1, answer: { value: { found: false } } },
          ],
        },
      },
    ],
  },
  {
    name: "a card list reads every card, one with an extra field too, each field in a column of its own by where it sits",
    page: "cards.html",
    steps: [{
      op: "extract",
      args: [{ as: "table" }],
      answer: {
        value: {
          truncated: false,
          tables: [{
            kind: "cards",
            headers: ["p.sponsored", "a.card-link href", "a.card-link > h3.title", "div.drop > span.val", "div.info > span.val", "div.pricing > span.val", "span.spec", "span.spec 2"],
            rows: [
              ["", "file:///cars/101", "2021 BMW M340i", "", "24,100 mi", "$38,900", "AWD", "Automatic"],
              ["", "file:///cars/102", "2022 BMW M340i", "Price drop", "18,020 mi", "$41,250", "RWD", "Automatic"],
              ["", "file:///cars/103", "2020 BMW M340i", "", "40,870 mi", "$33,500", "AWD", "Manual"],
              ["Sponsored", "file:///cars/104", "2023 BMW M340i", "", "9,310 mi", "$47,995", "AWD", "Automatic"],
            ],
          }],
        },
      },
    }],
  },
  {
    name: "a scroll the window cannot take scrolls the box under the middle of the window, and says what moved",
    page: "inner-scroll.html",
    steps: [{ op: "scroll", args: [0, 300], answer: { value: { ok: true, moved: "box", scrollY: 300, maxY: 2200 } } }],
  },
  {
    name: "a scroll on a page that draws on a canvas goes to it as a wheel, which the page takes",
    page: "canvas-scroll.html",
    steps: [
      { op: "scroll", args: [0, 300], answer: { value: { ok: true, moved: "wheel" } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Drawn from 300") } } },
    ],
  },
  {
    name: "a scroll that moves nothing says so rather than that it scrolled",
    page: "click.html",
    steps: [{ op: "scroll", args: [0, 300], answer: { error: "nothing moved: the window is at scrollY 0 of 0, no box under its middle scrolls that way, and the page there does not take a wheel" } }],
  },
  {
    name: "download on a link to the page itself clicks it and saves the file the page's script makes",
    page: "js-download.html",
    steps: [{ op: "download", args: ["Statement"], answer: { value: { name: "statement.pdf", type: "application/pdf" } } }],
  },
  {
    name: "download on a button that opens a web page says so and what to do, rather than saving the page",
    page: "js-download.html",
    steps: [{ op: "download", args: ["Policy"], answer: { error: expect.stringContaining("opens a web page, not a file") } }],
  },
]);

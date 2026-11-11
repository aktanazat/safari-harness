import { expect } from "bun:test";
import { benchRows, type Step } from "./bench.ts";

// form-steps.html's first step as an agent fills it: its password and a
// member id typed as a secret too, which no draft may hold.
const firstStep: Step[] = [
  { op: "type", args: ["input[name=first_name]", "Ada"] },
  { op: "type", args: ["input[name=last_name]", "Lovelace"] },
  { op: "type", args: ["input[name=email]", "ada@example.com"] },
  { op: "type", args: ["input[name=password]", "Engine-1843"] },
  { op: "type", args: ["input[name=member_id]", "M-77341", { secret: true }] },
  { op: "select", args: ["select[name=country]", "Canada"] },
  { op: "click", args: ["Phone"] },
  { op: "click", args: ["Send me updates"] },
];

// The daemon's part, in content.js's world: the draft before Next and the
// one before Submit, kept as one (drafts.ts), and after the page's check
// emptied the form, the look after the click, a refill sent for another
// page, and then refill.
const SENT_AND_REFILLED = `(async () => {
  const run = async (op, ...args) => {
    const r = await window.__safariHarnessRun({ id: op, op, args });
    if (r.error) throw new Error(op + ": " + r.error);
    return r.value;
  };
  const values = () => [...document.querySelectorAll("input, select, textarea")].map((f) => (f.type === "checkbox" || f.type === "radio" ? f.checked : f.value));
  const first = await run("formDraft", "Next");
  await run("click", "Next");
  await run("type", "textarea[name=cover]", "I build engines.");
  await run("type", "input[name=card_number]", "4242 4242 4242 4242");
  await run("type", "input[name=otp]", "402913");
  const second = await run("formDraft", "Submit application");
  await run("click", "Submit application");
  const emptied = values();
  const draft = { ...second, at: Date.now(), fields: [...first.fields, ...second.fields] };
  const look = window.__safariHarnessProbe.draft(draft.fields.map((f) => f.key));
  const elsewhere = (await window.__safariHarnessRun({ id: "elsewhere", op: "refill", args: [[draft], "/jobs/another"] })).error;
  const back = await run("refill", [draft], second.page);
  return { emptied, look, elsewhere, back, said: Object.keys(back), values: values() };
})()`;

// A form that empties itself once it went through and says so in a status
// line, as Contact Form 7 does: the look hears it.
const SENT_AND_SAID = `(async () => {
  const { value: draft } = await window.__safariHarnessRun({ id: "draft", op: "formDraft", args: ["Next"] });
  document.querySelector("#application").reset();
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Thank you for your message. It has been sent.";
  document.body.append(status);
  return window.__safariHarnessProbe.draft(draft.fields.map((f) => f.key));
})()`;

benchRows("form drafts", [
  {
    name: "a draft taken as Next is clicked holds the step's filled fields, and not its password or a field typed as a secret",
    page: "form-steps.html",
    steps: [
      ...firstStep,
      {
        op: "formDraft",
        args: ["Next"],
        answer: {
          value: {
            final: false,
            form: "application",
            fields: [
              { name: "first_name", label: "First name", value: "Ada" },
              { name: "last_name", value: "Lovelace" },
              { name: "email", type: "email", value: "ada@example.com" },
              { name: "country", value: "CA" },
              { name: "contact", type: "radio", key: expect.stringContaining('"phone"'), checked: true },
              { name: "updates", type: "checkbox", checked: true },
            ],
          },
        },
      },
    ],
  },
  {
    name: "a draft taken as Submit is clicked holds the second step's text, and none of its card number, security code, or verification code",
    page: "form-steps.html",
    steps: [
      { op: "click", args: ["Next"] },
      { op: "type", args: ["textarea[name=cover]", "I build engines."] },
      { op: "type", args: ["input[name=card_number]", "4242 4242 4242 4242"] },
      { op: "type", args: ["input[name=cvv]", "737"] },
      { op: "type", args: ["input[name=otp]", "402913"] },
      { op: "formDraft", args: ["Submit application"], answer: { value: { final: true, form: "application", fields: [{ name: "cover", value: "I build engines." }] } } },
    ],
  },
  {
    name: "a click that sends no form on, as on a radio or a field, takes no draft",
    page: "form-steps.html",
    steps: [
      { op: "formDraft", args: ["Phone"], answer: { value: null } },
      { op: "formDraft", args: ["input[name=first_name]"], answer: { value: null } },
    ],
  },
  {
    name: "the draft read before a click on a ref whose element the page drew anew leaves the heal, and saying so, to the click",
    page: "heal.html",
    steps: [
      { op: "snapshot" }, // [1] Save, [4] Redraw
      { op: "formDraft", args: ["4"], answer: { value: null } },
      { op: "click", args: ["4"] },
      { op: "formDraft", args: ["1"], answer: { value: null } },
      { op: "click", args: ["1"], answer: { value: { ok: true, healed: { ref: "1", now: "7" } } } },
    ],
  },
  {
    name: "after the page's check emptied the two-step form, the look sees its fields emptied, and one refill puts back each one the agent filled, naming none of their values",
    page: "form-steps.html",
    steps: [
      ...firstStep,
      {
        op: "eval",
        args: [SENT_AND_REFILLED],
        timeout: 20000,
        answer: {
          value: {
            ok: true,
            result: {
              emptied: ["", "", "", "", "", "", false, false, false, "", "", "", ""],
              look: { present: 6, empty: 5, signIn: false, alerts: "Something went wrong. Please try again." },
              elsewhere: "the page moved since refill looked at it; nothing was refilled",
              back: { filled: 7 },
              said: ["filled"],
              values: ["Ada", "Lovelace", "ada@example.com", "", "", "CA", false, true, true, "I build engines.", "", "", ""],
            },
          },
        },
      },
    ],
  },
  {
    name: "the look after a click hears a status line saying the emptied form went through",
    page: "form-steps.html",
    steps: [
      ...firstStep,
      { op: "eval", args: [SENT_AND_SAID], answer: { value: { ok: true, result: { present: 6, empty: 5, alerts: "Thank you for your message. It has been sent." } } } },
    ],
  },
]);

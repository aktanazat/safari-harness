import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { DRAFT_MS, outcome, refill, saveDraft, type Draft, type Look } from "./drafts.ts";
import { connect } from "./fake-safari.ts";
import * as phone from "./phone.ts";
import * as redact from "./redact.ts";
import { keepSecret, tabSecrets } from "./redact.ts";
import { callTool } from "./tools.ts";

// Safari as the daemon sees it: the form a click sends on (formDraft's
// answer in content.js), each frame as draftFrame tells it (probe), the
// fields each look asked about, and the frames refill was sent to with the
// drafts each got. Each test keeps the harness's state files apart.
const TAB = 7;
const SITE = "https://apply.example";
let form: unknown = null;
let looks: unknown[] = [];
const asked: unknown[] = [];
const refills: { frame: unknown; drafts: Draft[] }[] = [];
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    let value: unknown = { ok: true };
    if (op === "probe") {
      asked.push(args[2]);
      value = looks;
    } else if (args[1] === "formDraft") value = form;
    else if (args[1] === "refill") {
      const [drafts] = args[2] as [Draft[]];
      refills.push({ frame: args[4], drafts });
      value = { filled: drafts[0].fields.length };
    }
    queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
  },
  close() {},
});

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "drafts-home-"));
  spyOn(phone, "dataFile").mockImplementation((name) => join(home, name));
});
afterEach(() => {
  mock.restore();
  form = null;
  looks = [];
  asked.length = 0;
  refills.length = 0;
  tabSecrets.clear();
  rmSync(home, { recursive: true, force: true });
});

// A text field as formDraft answers it, keyed as draftFields keys it.
const text = (name: string, value: string, facts: { type?: string; autocomplete?: string; label?: string } = {}) => ({
  key: `${JSON.stringify(["text", "name", name, ""])}#0`,
  type: "text",
  autocomplete: "",
  name,
  id: "",
  label: name,
  value,
  ...facts,
});
const radio = (name: string, value: string) => ({ key: `${JSON.stringify(["radio", "name", name, value])}#0`, type: "radio", autocomplete: "", name, id: "", label: value, checked: true });
const step = (fields: unknown[], final = false, origin = SITE, page = "/apply") => ({ final, form: "application", page, origin, fields });
const look = (facts: Partial<Look>): Look => ({ frame: 0, origin: SITE, page: "/apply", present: 0, empty: 0, signIn: false, ...facts });
const folder = () => join(home, "form-drafts");
const sites = () => readdirSync(folder()).map((name) => JSON.parse(readFileSync(join(folder(), name), "utf8")) as { origin: string; drafts: Draft[] });
const names = () => sites().flatMap((s) => s.drafts.map((d) => d.fields.map((f) => f.name)));
const ERROR = { present: 3, empty: 3, alerts: "Something went wrong. Please try again." };

test("a click that sends a form on keeps it for the user alone, no secret in it nor its page's address, and refill gives it back to its own site's frame", async () => {
  keepSecret(TAB, "m3mb3r-4471");
  keepSecret(8, "0th3r-t4b-k3y");
  form = step([
    text("first_name", "Ada"),
    text("last_name", "Lovelace"),
    text("email", "ada@example.com", { type: "email", autocomplete: "email" }),
    text("pw", "hunter2!", { type: "password" }),
    text("cardnumber", "4242 4242 4242 4242", { autocomplete: "cc-number" }),
    text("f7", "737", { label: "Security code" }),
    text("otp", "123456", { autocomplete: "one-time-code" }),
    text("applicantSSN", "078051120"),
    text("notes", "my number is 078-05-1120"),
    text("reference", "4111 1111 1111 1111"),
    text("member_id", "m3mb3r-4471"),
    text("partner", "0th3r-t4b-k3y"),
  ], false, SITE, "/apply?invite=1nv1t3-t0k3n");
  looks = [look({ page: "/apply?invite=1nv1t3-t0k3n", ...ERROR })];
  expect(await callTool("click", { tab: TAB, ref: 9 })).toMatchObject({ ok: true, note: expect.stringContaining("refill puts back") });

  const [name] = readdirSync(folder());
  expect([statSync(folder()).mode & 0o777, statSync(join(folder(), name)).mode & 0o777]).toEqual([0o700, 0o600]);
  const body = readFileSync(join(folder(), name), "utf8");
  for (const secret of ["hunter2!", "4242 4242", "078051120", "078-05-1120", "4111 1111", "m3mb3r-4471", "0th3r-t4b-k3y", '"737"', '"123456"', "1nv1t3-t0k3n"]) expect(body).not.toContain(secret);
  expect(names()).toEqual([["first_name", "last_name", "email"]]);

  looks = [look({ page: "/apply?invite=1nv1t3-t0k3n" }), look({ frame: 3, origin: "https://evil.example", page: "/apply?invite=1nv1t3-t0k3n" })];
  expect(await callTool("refill", { tab: TAB })).toMatchObject({ ok: true, filled: 3 });
  expect(refills.map((r) => [r.frame, r.drafts.flatMap((d) => d.fields.map((f) => ("value" in f ? f.value : f.checked)))])).toEqual([[0, ["Ada", "Lovelace", "ada@example.com"]]]);
});

test("a draft is gone a day after its last save: refill finds none, and no file of it is left", async () => {
  const at = Date.now();
  saveDraft(TAB, step([text("first_name", "Ada"), text("last_name", "Lovelace")]), at);
  looks = [look({})];
  expect(await refill(TAB, at + DRAFT_MS - 1)).toMatchObject({ ok: true, filled: 2 });
  saveDraft(TAB, step([text("first_name", "Grace"), text("last_name", "Hopper")], false, "https://other.example"), at + DRAFT_MS);
  expect(sites().map((s) => s.origin)).toEqual(["https://other.example"]);
  await expect(refill(TAB, at + DRAFT_MS)).rejects.toThrow(`nothing to refill: no form on this page of ${SITE} was saved in the last day`);
});

test("a form's last step that went through deletes its draft; one the page sent back emptied keeps it", async () => {
  form = step([text("first_name", "Ada"), text("last_name", "Lovelace")]);
  await callTool("click", { tab: TAB, ref: "Next" });
  form = step([text("cover", "I build engines."), text("referrer", "Babbage")], true);
  looks = [look(ERROR)];
  expect(await callTool("click", { tab: TAB, ref: "Submit" })).toMatchObject({ note: expect.stringContaining("refill puts back") });
  expect(names()).toEqual([["first_name", "last_name", "cover", "referrer"]]);
  looks = [look({ url: `${SITE}/thanks`, title: "Application received", text: "Thank you. We received your application." })];
  expect(await callTool("click", { tab: TAB, ref: "Submit" })).not.toHaveProperty("note");
  expect(readdirSync(folder())).toEqual([]);
});

test("a later step adds to its form's draft, and a newer radio choice replaces the older", () => {
  const at = Date.now();
  saveDraft(TAB, step([text("first_name", "Ada"), text("last_name", "Lovelace"), radio("contact", "email")]), at);
  saveDraft(TAB, step([text("first_name", "Ada"), text("last_name", "Lovelace"), radio("contact", "phone")]), at + 1);
  saveDraft(TAB, step([text("cover", "I build engines.")], true), at + 2);
  expect(sites().map((s) => s.drafts.map((d) => d.fields.map((f) => f.label)))).toEqual([[["first_name", "last_name", "phone", "cover"]]]);
});

// One job board holds every company's application, each form with the
// same id and fields (11-11 review).
test("a draft goes back only to the page its form was on: another company's application on the same site gets none of it", async () => {
  const BOARD = "https://boards.example";
  form = step([text("first_name", "Ada"), text("last_name", "Lovelace"), text("cover_letter", "Dear Acme team")], true, BOARD, "/acme/jobs/1");
  looks = [look({ origin: BOARD, page: "/acme/jobs/1", ...ERROR })];
  await callTool("click", { tab: TAB, ref: "Submit" });
  form = step([text("first_name", "Ada"), text("last_name", "Lovelace")], true, BOARD, "/globex/jobs/2");
  looks = [look({ origin: BOARD, page: "/globex/jobs/2", ...ERROR, present: 2, empty: 2 })];
  await callTool("click", { tab: TAB, ref: "Submit" });
  expect(await callTool("refill", { tab: TAB })).toMatchObject({ ok: true, filled: 2 });
  expect(refills.flatMap((r) => r.drafts.flatMap((d) => d.fields.map((f) => f.name)))).toEqual(["first_name", "last_name"]);
  looks = [look({ origin: BOARD, page: "/initech/jobs/3" })];
  await expect(callTool("refill", { tab: TAB })).rejects.toThrow(`nothing to refill: no form on this page of ${BOARD} was saved in the last day`);
});

test("a click on a form that keeps no draft looks at nothing and deletes nothing, and a last step that went through deletes its own form's draft alone", async () => {
  saveDraft(8, step([text("order", "A-1"), text("reason", "too big")], false, SITE, "/returns"));
  form = step([text("name", "Ada"), text("street", "1 Analytical Way")], true, SITE, "/checkout");
  looks = [look({ page: "/checkout", ...ERROR })];
  await callTool("click", { tab: TAB, ref: "Place order" });
  form = { ...step([text("coupon", "SAVE10")], true, SITE, "/checkout"), form: "coupon" };
  looks = [look({ url: `${SITE}/checkout`, title: "Checkout" })];
  asked.length = 0;
  await callTool("click", { tab: TAB, ref: "Apply" });
  expect(asked).toEqual([]);
  expect(names()).toEqual([["name", "street"], ["order", "reason"]]);
  form = step([text("name", "Ada"), text("street", "1 Analytical Way")], true, SITE, "/checkout");
  looks = [look({ url: `${SITE}/thanks`, title: "Order confirmed" })];
  await callTool("click", { tab: TAB, ref: "Place order" });
  expect(asked).toEqual([[text("name", "").key, text("street", "").key]]);
  expect(names()).toEqual([["order", "reason"]]);
});

// The secret check of a value can cost as its length squared: 200 such
// values held the daemon 55 s on 11-11.
test("of a page's long values, a click's secret checks read 30,000 characters at most", () => {
  const checked = spyOn(redact, "redactSecretText");
  saveDraft(TAB, step(Array.from({ length: 200 }, (_, i) => text(`t${i}`, "a.".repeat(2500)))));
  const read = checked.mock.calls.filter(([t]) => t.startsWith("a.")).reduce((n, [t]) => n + t.length, 0);
  expect(read).toBeGreaterThan(0);
  expect(read).toBeLessThanOrEqual(30_000);
});

// What the look after a click makes of the page: only "sent" on a last
// step deletes its draft, and only "emptied", "signIn", and "error" offer
// refill.
test.each([
  ["the form back with its fields empty and an error said", "emptied", [look(ERROR)]],
  ["a contact form that empties itself once sent", "sent", [look({ present: 2, empty: 2, alerts: "Thank you, your message was sent." })]],
  ["the form still holding its text", "kept", [look({ present: 3, empty: 0, alerts: "Please enter a valid phone number." })]],
  ["a sign-in page", "signIn", [look({ signIn: true, url: `${SITE}/login`, title: "Sign in" })]],
  ["an error page", "error", [look({ url: `${SITE}/apply`, title: "Error 500", text: "Internal Server Error" })]],
  ["the next page", "sent", [look({ url: `${SITE}/done`, title: "Application received" })]],
  ["no look at the top page", "unseen", [look({ frame: 2, present: 3, empty: 3 })]],
] as [string, string, Look[]][])("%s reads %s", (_name, want, frames) => {
  expect(outcome(frames, SITE)).toBe(want);
});

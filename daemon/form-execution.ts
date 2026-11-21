import { formInspectionProgram, FORM_SOURCE_MAX_BYTES, type FormSelection } from "./form-inspection.ts";

export type FormChange = { field: number } & (
  | { kind: "text"; text: string }
  | { kind: "checked"; checked: boolean }
  | { kind: "selection"; selection: number[] }
);
export type FormExecution = { expected: string; action: number; changes: FormChange[]; mode: "review" | "execute" };

/** Constructed only by the admitted resource transport. No caller-supplied program is accepted. */

export function readFormExecution(value: unknown): FormExecution {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !("expected" in value) || !("action" in value) || !("changes" in value) ||
      typeof value.action !== "number" || !Number.isSafeInteger(value.action) || value.action < 0 ||
      typeof value.expected !== "string" ||
      !("mode" in value) || (value.mode !== "review" && value.mode !== "execute") ||
      !Array.isArray(value.changes) || value.changes.length > 80) throw new Error("Invalid approved form operation.");
  const changes: FormChange[] = [];
  for (const change of value.changes) {
    if (!change || typeof change !== "object" || !("field" in change) || !("kind" in change) ||
        typeof change.field !== "number" || !Number.isSafeInteger(change.field) || change.field < 0) throw new Error("Invalid form field.");
    if (change.kind === "text" && "text" in change && typeof change.text === "string") changes.push({ field: change.field, kind: "text", text: change.text });
    else if (change.kind === "checked" && "checked" in change && typeof change.checked === "boolean") changes.push({ field: change.field, kind: "checked", checked: change.checked });
    else if (change.kind === "selection" && "selection" in change && Array.isArray(change.selection)) {
      const selection: number[] = [];
      for (const index of change.selection) {
        if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) throw new Error("Invalid form option.");
        selection.push(index);
      }
      changes.push({ field: change.field, kind: "selection", selection });
    } else throw new Error("Unsupported form field value.");
  }
  return { expected: value.expected, action: value.action, changes, mode: value.mode };
}
export function formExecutionProgram(selection: FormSelection, execution: FormExecution): string {
  const inspection = formInspectionProgram(selection);
  const encoded = JSON.stringify(execution);
  if (!encoded || Buffer.byteLength(encoded, "utf8") > FORM_SOURCE_MAX_BYTES ||
      !Number.isSafeInteger(execution.action) || execution.action < 0 ||
      (execution.mode !== "review" && execution.mode !== "execute") ||
      !Array.isArray(execution.changes) || execution.changes.length > 80) {
    throw new Error("The complete approved form is unavailable or oversized.");
  }
  return `(${EXECUTION})(()=>${inspection},${encoded})`;
}

const EXECUTION = String.raw`
(inspect, request) => {
  const refuse = (reason) => ({ phase: "failed", detail: reason });
  const definition = (value) => {
    const { captured, ...rest } = value;
    return rest;
  };
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
  };
  const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  let before;
  try { before = inspect(); } catch { return refuse("The original form cannot be inspected completely."); }
  if (!same(definition(before), definition(JSON.parse(request.expected)))) return refuse("The form, values, terms or destination changed. Review it again.");
  const action = before.form.actions.find(value => value.index === request.action);
  if (!action || action.disabled || action.type !== "submit" || !action.submission ||
      action.submission.skipsValidation || !["get", "post"].includes(action.submission.method) ||
      !["", "_self"].includes(action.submission.target) ||
      !["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"].includes(action.submission.encoding)) {
    return refuse("This action needs its original website flow.");
  }
  const destination = new URL(action.submission.destination, location.href);
  if (!["http:", "https:"].includes(destination.protocol) || destination.username || destination.password) return refuse("This destination is unsupported.");
  // Hidden values are deliberately not observed; they cannot be silently approved for disclosure.
  if (before.form.hiddenControls !== 0 || before.form.otherControls !== 0) return refuse("This form has unreviewed controls. Use its original website flow.");
  const textTypes = ["text", "search", "email", "url", "tel", "number", "date", "datetime-local", "month", "week", "time"];
  if (before.form.fields.some(field => field.tag !== "textarea" && field.tag !== "select" &&
      !(field.tag === "input" && (textTypes.includes(field.type) || field.type === "checkbox")))) {
    return refuse("This form contains an unsupported control. Use its original website flow.");
  }
  const form = document.forms.item(before.form.index);
  const controls = Array.from(document.querySelectorAll("button, fieldset, input, object, output, select, textarea")).filter(control => control.form === form);
  const seen = new Set();
  const expected = structuredClone(before);
  for (const change of request.changes) {
    const field = expected.form.fields.find(field => field.index === change.field);
    if (!field || seen.has(change.field) || field.disabled || field.readOnly) return refuse("An approved field is unavailable or repeated.");
    seen.add(change.field);
    if (change.kind === "text" && typeof change.text === "string" && change.text.length <= 8192 &&
        (field.tag === "textarea" || (field.tag === "input" && textTypes.includes(field.type)))) {
      field.value = change.text;
    } else if (change.kind === "checked" && typeof change.checked === "boolean" && field.type === "checkbox") {
      field.checked = change.checked;
    } else if (change.kind === "selection" && field.tag === "select" && Array.isArray(change.selection) &&
        change.selection.every(index => Number.isInteger(index) && field.options.some(option => option.index === index)) &&
        field.options.every(option => !option.disabled || option.selected === change.selection.includes(option.index)) &&
        new Set(change.selection).size === change.selection.length && (field.multiple || change.selection.length <= 1)) {
      for (const option of field.options) option.selected = change.selection.includes(option.index);
    } else return refuse("This field value needs the original website flow.");
  }
  // Effect-free preflight traverses the actual mutation receiver and full argument validation.
  // It never touches DOM properties, validation handlers, focus, navigation or submission.
  if (request.mode === "review") return { phase: "ready", detail: "The exact ordinary form and proposed changes are supported for native review." };
  if (request.mode !== "execute") return refuse("The fixed form purpose is unavailable.");
  try {
    for (const change of request.changes) {
      const control = controls[change.field];
      const proto = control.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      if (change.kind === "text") Object.getOwnPropertyDescriptor(proto, "value").set.call(control, change.text);
      else if (change.kind === "checked") Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked").set.call(control, change.checked);
      else {
        if (change.selection.length === 0) Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex").set.call(control, -1);
        for (const [index, option] of Array.from(control.options).entries()) Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, "selected").set.call(option, change.selection.includes(index));
      }
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const after = inspect();
    if (!same(definition(after), definition(expected))) return { phase: "unknown", detail: "Filling changed the form, terms, destination or values. The approved submit was not dispatched; effects of website handlers are unknown." };
    if (!HTMLFormElement.prototype.checkValidity.call(form)) return { phase: "unknown", detail: "The website rejected a value. The approved submit was not dispatched; effects of website handlers are unknown." };
    // Synchronous validation handlers can mutate the form; compare once more before dispatch.
    if (!same(definition(inspect()), definition(expected))) return { phase: "unknown", detail: "Validation changed the form. The approved submit was not dispatched; effects of website handlers are unknown." };
    const currentControls = Array.from(document.querySelectorAll("button, fieldset, input, object, output, select, textarea")).filter(control => control.form === form);
    if (!form.isConnected || document.forms.item(before.form.index) !== form || currentControls.length !== controls.length ||
        currentControls.some((control, index) => control !== controls[index]) || controls[request.action].form !== form) {
      return { phase: "unknown", detail: "The website replaced the original controls during filling. The approved submit was not dispatched; website effects are unknown." };
    }
    HTMLFormElement.prototype.requestSubmit.call(form, controls[request.action]);
    return { phase: "dispatched", detail: "The approved action was dispatched. The website has not confirmed acceptance." };
  } catch {
    return { phase: "unknown", detail: "The operation was interrupted. Check the website before doing anything again." };
  }
}
`;

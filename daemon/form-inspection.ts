// The sole fixed DOM program for the native form read. This module neither evaluates code nor
// grants a source read. The admitted resource owner dispatches it through the strict relay only.
export type FormSelection = { document: string; form: number };
export const FORM_SOURCE_MAX_BYTES = 512_000;

// Comparison data for an actually created helper resource, never a source grant.
export type FormResource = Readonly<{
  tab: number;
  token: string;
  owner: number;
  epoch: string;
  connection: number;
  window: number;
  document: string;
}>;
export type FormReadResult = { resource: FormResource; form: number; json: string };

export function readFormResource(value: unknown): FormResource {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !("tab" in value) || !("token" in value) || !("owner" in value) || !("epoch" in value) ||
      !("connection" in value) || !("window" in value) || !("document" in value)) {
    throw new Error("The original created-resource receipt is unavailable.");
  }
  const { tab, token, owner, epoch, connection, window, document } = value;
  if (typeof tab !== "number" || !Number.isSafeInteger(tab) || tab <= 0 ||
      typeof token !== "string" || !token || typeof owner !== "number" || !Number.isSafeInteger(owner) || owner <= 1 ||
      typeof epoch !== "string" || !epoch || typeof connection !== "number" || !Number.isFinite(connection) || connection <= 0 ||
      typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0 || typeof document !== "string" || !document) {
    throw new Error("The original created-resource receipt is invalid.");
  }
  return { tab, token, owner, epoch, connection, window, document };
}

// Link.Widget.FormNode bounds and Link.Widget.mostParts. These are operation policy, never tool args.
const BOUNDS = Object.freeze({
  mostFields: 80,
  mostOptions: 256,
  mostActions: 8,
  mostControls: 256,
  mostText: 64_000,
  mostValue: 8_192,
  mostParts: 40,
});

export function formInspectionProgram(selection: FormSelection): string {
  const document = URL.parse(selection.document);
  if (!document || (document.protocol !== "https:" && document.protocol !== "http:") || !document.hostname || document.username || document.password) {
    throw new Error("Inspect an actual web document without embedded credentials.");
  }
  if (!Number.isSafeInteger(selection.form) || selection.form < 0) throw new Error("Choose an actual form occurrence.");
  return `(${INSPECTION})(${JSON.stringify({ document: selection.document, form: selection.form, ...BOUNDS })})`;
}

// Transferred from Pages' canonical inspector; values and rendered text remain exact, not truncated.
const INSPECTION = String.raw`
(request) => {
  const fail = (message) => { throw new Error(message); };
  if (location.href !== request.document) fail("The original browser document changed.");
  if (!Number.isInteger(request.form) || request.form < 0 || request.form >= document.forms.length) {
    fail("Choose an actual form occurrence.");
  }
  const form = document.forms.item(request.form);
  if (!form) fail("The inspected form is no longer present.");
  if (typeof Element.prototype.checkVisibility !== "function") fail("This browser cannot verify rendered form controls.");
  const controls = [];
  // form.elements omits image submitters. Keep all associated controls in document order,
  // including controls outside the form that explicitly name it.
  for (const control of document.querySelectorAll("button, fieldset, input, object, output, select, textarea")) {
    if (control.form === form) controls.push(control);
  }
  if (controls.length > request.mostControls) fail("This form has too many controls to inspect completely.");
  const privateControl = (control) => {
    const type = String(control.type || "").toLowerCase();
    const tokens = String(control.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    return type === "password" || type === "file" || tokens.some((token) =>
      token === "current-password" || token === "new-password" || token === "one-time-code" || token.startsWith("cc-"));
  };
  if (controls.some(privateControl)) fail("This form contains private, payment or file controls. Use its existing secure flow.");
  const range = document.createRange();
  const nonWhitespace = /\S/;
  const styles = new WeakMap();
  const styleOf = (element) => {
    let style = styles.get(element);
    if (!style) { style = getComputedStyle(element); styles.set(element, style); }
    return style;
  };
  const renderedText = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      // Control values are observed separately, never through text nodes or hidden defaults.
      if (!parent || parent.closest("input, textarea, select, script, style, template, noscript")) continue;
      const visibility = styleOf(parent).visibility;
      if (visibility === "hidden" || visibility === "collapse") continue;
      let transparent = false;
      for (let element = parent; element; element = element.parentElement) {
        if (styleOf(element).opacity === "0") { transparent = true; break; }
      }
      if (transparent) continue;
      range.selectNodeContents(node);
      let rendered = false;
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) { rendered = true; break; }
      }
      if (!rendered) continue;
      const value = node.nodeValue;
      if (!nonWhitespace.test(value)) continue;
      if (text.length) text += "\n";
      text += value;
      if (text.length > request.mostText) fail("The complete rendered form text is too long for native review.");
    }
    return text;
  };
  const text = renderedText(form);
  const label = (control) => {
    const labelledBy = control.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).filter(Boolean).map((id) => {
        const node = document.getElementById(id);
        return node ? renderedText(node) : "";
      });
      if (parts.some((value) => value.trim())) return parts.join(" ");
    }
    const ariaLabel = control.getAttribute("aria-label");
    if (ariaLabel?.trim()) return ariaLabel;
    const associated = Array.from(control.labels || [], renderedText);
    return associated.some((value) => value.trim()) ? associated.join(" ") : null;
  };
  const fields = [];
  const actions = [];
  let hiddenControls = 0;
  let otherControls = 0;
  let partCount = 0;
  for (const [index, control] of controls.entries()) {
    const tag = control.localName;
    const type = String(control.type || tag).toLowerCase();
    // Fieldsets are grouping structure, not submitted controls. Keep their original occurrence
    // in controls so child indices, observed legends and disabled state stay exact.
    if (tag === "fieldset") continue;
    if ((tag === "input" && type === "hidden") || !control.checkVisibility({ opacityProperty: true, visibilityProperty: true })) { hiddenControls++; continue; }
    if ((tag === "button" && type === "submit") || (tag === "input" && (type === "submit" || type === "image"))) {
      if (++partCount >= request.mostParts) fail("The complete form exceeds the native composition bound.");
      actions.push({
        index, domID: control.getAttribute("id"), name: control.getAttribute("name"), type,
        label: label(control) ?? (tag === "button" ? renderedText(control) : control.value),
        value: control.value, disabled: control.matches(":disabled"),
        submission: {
          destination: control.hasAttribute("formaction") ? control.formAction : form.action,
          method: control.hasAttribute("formmethod") ? control.formMethod : form.method,
          encoding: control.hasAttribute("formenctype") ? control.formEnctype : form.enctype,
          target: control.hasAttribute("formtarget") ? control.formTarget : form.target,
          skipsValidation: form.noValidate || control.formNoValidate
        }
      });
      continue;
    }
    if (tag !== "input" && tag !== "textarea" && tag !== "select") { otherControls++; continue; }
    if (tag === "input" && (type === "button" || type === "reset")) { otherControls++; continue; }
    const fieldset = control.closest("fieldset");
    const legend = fieldset?.querySelector(":scope > legend");
    const group = legend ? renderedText(legend) : null;
    const value = tag === "select" ? null : control.value;
    if (value !== null && value.length > request.mostValue) fail("A form value is too long to review completely.");
    const optionCount = tag === "select" ? control.options.length : 0;
    if (optionCount > request.mostOptions || partCount + 1 + optionCount >= request.mostParts) {
      fail("The complete form and its choices exceed the native composition bound.");
    }
    partCount += 1 + optionCount;
    const options = tag === "select" ? Array.from(control.options, (option, optionIndex) => ({
      index: optionIndex, value: option.value, label: option.label,
      group: option.parentElement?.localName === "optgroup" ? option.parentElement.label : null,
      disabled: option.matches(":disabled"), selected: option.selected
    })) : [];
    fields.push({
      index, domID: control.getAttribute("id"), name: control.getAttribute("name"), tag, type,
      label: label(control), group: group || null,
      placeholder: control.getAttribute("placeholder"), autocomplete: control.getAttribute("autocomplete"),
      inputMode: control.getAttribute("inputmode"), readOnly: control.readOnly === true,
      disabled: control.matches(":disabled"), value,
      checked: type === "checkbox" || type === "radio" ? control.checked : null,
      multiple: tag === "select" && control.multiple, options,
      constraints: {
        required: typeof control.required === "boolean" ? control.required : null,
        minimum: control.getAttribute("min"), maximum: control.getAttribute("max"),
        step: control.getAttribute("step"), pattern: control.getAttribute("pattern"),
        minimumLength: control.hasAttribute("minlength") ? control.minLength : null,
        maximumLength: control.hasAttribute("maxlength") ? control.maxLength : null
      }
    });
  }
  if (fields.length > request.mostFields || actions.length > request.mostActions) fail("This form cannot be reviewed completely within the native field limits.");
  return {
    version: 1, document: location.href, title: document.title, captured: new Date().toISOString(),
    form: {
      index: request.form, domID: form.getAttribute("id"), name: form.getAttribute("name"), text,
      submission: {
        destination: form.action, method: form.method, encoding: form.enctype,
        target: form.target, skipsValidation: form.noValidate
      },
      fields, actions, hiddenControls, otherControls
    }
  };
}
`;

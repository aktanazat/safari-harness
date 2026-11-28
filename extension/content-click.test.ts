import { expect, test } from "bun:test";

const content = await Bun.file(new URL("./content.js", import.meta.url)).text();
const between = (start: string, end: string) => content.slice(content.indexOf(start), content.indexOf(end));
const source = [
  between("  function fireMouse(", "  // What an action set in motion"),
  between("  function insideTarget(", "  // A cover's way out"),
  between("  function clickPoint(", "  // A control that asks for his passkey"),
  between("  function clickElement(", "  function clickProbe("),
].join("\n");

const clickIn = new Function("deepPoint", "isInteractive", "MouseEvent", `
  const clickBlocked = () => null, frameCover = () => null, standIn = () => null;
  const parentOf = (node) => node.parentElement;
  const asksPasskey = () => false, watchTarget = () => {}, refused = (_, reason) => reason;
  const coveredBy = (hit) => hit.localName;
  ${source}
  return clickElement;
`);

function coveredInput(type: string, wrapping: boolean, obstruction?: "other label" | "button") {
  const defaultView = {
    innerWidth: 100, innerHeight: 100,
    getComputedStyle: () => ({ overflowX: "visible", overflowY: "visible", position: "static" }),
  };
  const root = { localName: "html", ownerDocument: { defaultView } };
  const doc = { documentElement: root, defaultView };
  const input = {
    localName: "input", tagName: "INPUT", type, checked: false, ownerDocument: doc,
    matches: (selector: string) => selector.includes(`input[type=${type}]`),
    getClientRects: () => [{ left: 0, top: 0, right: 20, bottom: 20 }],
    focus() {}, scrollIntoView() {},
    get parentElement() { return wrapping ? label : root; },
    dispatchEvent(event: MouseEvent) { if (event.type === "click") input.checked = true; },
  };
  const label = { localName: "label", control: obstruction === "other label" ? null : input, ownerDocument: doc, parentElement: root };
  let clickedLabel = false;
  const hit = {
    localName: obstruction === "button" ? "button" : "span", ownerDocument: doc, parentElement: label,
    closest: (selector: string) => selector === "label" ? label : null,
    dispatchEvent(event: MouseEvent) {
      if (event.type === "click" && !obstruction) {
        clickedLabel = true;
        label.control?.dispatchEvent(event);
      }
    },
  };
  const click = clickIn(() => hit, (el: typeof hit) => el.localName === "button", class {
    constructor(readonly type: string) {}
  });
  return { result: click(input), checked: input.checked, clickedLabel };
}

test.each([
  { label: "a for= label", type: "radio", wrapping: false },
  { label: "a wrapping label", type: "checkbox", wrapping: true },
])("click can check a $type covered by $label", ({ type, wrapping }) => {
  expect(coveredInput(type, wrapping)).toEqual({ result: { ok: true }, checked: true, clickedLabel: true });
});

test.each(["other label", "button"] as const)("click refuses a checkbox when the cover is a %s", (obstruction) => {
  expect(coveredInput("checkbox", false, obstruction)).toMatchObject({ result: { reason: "covered" }, checked: false });
});

import { benchRows } from "./bench.ts";

const request = `const request = (phase, secrets = []) => window.__safariHarnessRun({ id: "capture-test", op: "capturePrivacy", args: ["capture-test", phase, secrets] });`;
const coverage = `
  const covers = (rect) => result.value.regions.some((r) => r.x <= rect.left && r.y <= rect.top && r.x + r.width >= rect.right && r.y + r.height >= rect.bottom);
  const bounds = (selector) => document.querySelector(selector).getBoundingClientRect();
`;

benchRows("private captures in WebKit", [
  {
    name: "protection covers filled password, code and card fields without changing ordinary text fields",
    page: "private-capture.html",
    steps: [{
      op: "eval",
      args: [`(async () => {
        ${request}
        await request("start");
        const result = await request("prepare");
        ${coverage}
        const protectedFields = ["#password", "#otp", "#card"].map((selector) => covers(bounds(selector)));
        const ordinary = covers(bounds("#ordinary"));
        await request("restore");
        return { protectedFields, ordinary, events: document.documentElement.dataset.fieldEvents, focus: document.activeElement.id };
      })()`],
      answer: { value: { result: { protectedFields: [true, true, true], ordinary: false, events: "0", focus: "ordinary" } } },
    }],
  },
  {
    name: "known secret text remains protected when it spans several text nodes",
    page: "private-capture.html",
    steps: [{
      op: "eval",
      args: [`(async () => {
        ${request}
        const secrets = ["known-sentinel", "split-sentinel"];
        await request("start", secrets);
        const result = await request("prepare", secrets);
        ${coverage}
        const covered = ["#known", "#split"].map((selector) => {
          const range = document.createRange();
          range.selectNodeContents(document.querySelector(selector));
          return [...range.getClientRects()].every(covers);
        });
        await request("restore");
        return covered;
      })()`],
      answer: { value: { result: [true, true] } },
    }],
  },
  {
    name: "protection enters open shadows and readable frames while covering opaque frame pixels",
    page: "private-capture.html",
    steps: [{
      op: "eval",
      args: [`(async () => {
        ${request}
        await request("start");
        const result = await request("prepare");
        ${coverage}
        const shadow = covers(document.querySelector("#shadow").shadowRoot.querySelector("input").getBoundingClientRect());
        const frame = document.querySelector("#same");
        const inner = frame.contentDocument.querySelector("input").getBoundingClientRect();
        const outer = frame.getBoundingClientRect();
        const sameOrigin = covers({left: outer.left + inner.left, top: outer.top + inner.top, right: outer.left + inner.right, bottom: outer.top + inner.bottom});
        const opaque = covers(bounds("#opaque"));
        await request("restore");
        return { shadow, sameOrigin, opaque };
      })()`],
      answer: { value: { result: { shadow: true, sameOrigin: true, opaque: true } } },
    }],
  },
  {
    name: "repeated protection leaves values, focus, events, and page children unchanged",
    page: "private-capture.html",
    steps: [{
      op: "eval",
      args: [`(async () => {
        ${request}
        const values = () => [...document.querySelectorAll("input")].map((el) => el.value);
        const before = values();
        const children = document.documentElement.children.length;
        const checks = [];
        for (let i = 0; i < 2; i++) {
          await request("start", ["known-sentinel"]);
          await request("prepare", ["known-sentinel"]);
          checks.push((await request("check", ["known-sentinel"])).value?.ok === true);
          await request("restore");
        }
        return { checks, sameValues: JSON.stringify(before) === JSON.stringify(values()), sameChildren: children === document.documentElement.children.length, focus: document.activeElement.id, events: document.documentElement.dataset.fieldEvents };
      })()`],
      answer: { value: { result: { checks: [true, true], sameValues: true, sameChildren: true, focus: "ordinary", events: "0" } } },
    }],
  },
  {
    name: "a scrolled capture protects newly visible secrets and restores the original scroll position",
    page: "private-capture.html",
    steps: [{
      op: "eval",
      args: [`(async () => {
        ${request}
        scrollTo({top: 300, behavior: "instant"});
        await request("start", ["bottom-sentinel"]);
        scrollTo({top: 1000, behavior: "instant"});
        const result = await request("prepare", ["bottom-sentinel"]);
        ${coverage}
        const range = document.createRange();
        range.selectNodeContents(document.querySelector("#bottom"));
        const covered = [...range.getClientRects()].every(covers);
        const valid = (await request("check", ["bottom-sentinel"])).value?.ok === true;
        await request("restore");
        return { covered, valid, scroll: scrollY, events: document.documentElement.dataset.fieldEvents };
      })()`],
      answer: { value: { result: { covered: true, valid: true, scroll: 300, events: "0" } } },
    }],
  },
  {
    name: "a changed shadow field invalidates capture instead of returning unprotected pixels",
    page: "private-capture.html",
    steps: [{
      op: "eval",
      args: [`(async () => {
        ${request}
        await request("start");
        await request("prepare");
        const field = document.createElement("input");
        field.autocomplete = "one-time-code";
        field.value = "938217";
        document.querySelector("#shadow").shadowRoot.append(field);
        const check = await request("check");
        await request("restore");
        return { refused: typeof check.error === "string" && check.error.startsWith("screenshot privacy: "), events: document.documentElement.dataset.fieldEvents };
      })()`],
      answer: { value: { result: { refused: true, events: "0" } } },
    }],
  },
  {
    name: "an extension takeover removes capture overlays and keeps the focused field unchanged",
    page: "private-capture.html",
    steps: [
      { op: "eval", args: ["document.documentElement.dataset.childrenBefore = String(document.documentElement.children.length)"] },
      { op: "capturePrivacy", args: ["retired", "start", []] },
      { op: "capturePrivacy", args: ["retired", "prepare", []] },
      { takeover: true },
      { op: "eval", args: ["({clean: document.documentElement.children.length === Number(document.documentElement.dataset.childrenBefore), focus: document.activeElement.id, events: document.documentElement.dataset.fieldEvents})"], answer: { value: { result: { clean: true, focus: "ordinary", events: "0" } } } },
    ],
  },
  {
    name: "a card number echoed with spaces and hyphens remains protected",
    page: "private-capture.html",
    steps: [{
      op: "eval",
      args: [`(async () => {
        ${request}
        await request("start");
        const result = await request("prepare");
        ${coverage}
        const range = document.createRange();
        range.selectNodeContents(document.querySelector("#formatted"));
        const covered = [...range.getClientRects()].every(covers);
        await request("restore");
        return covered;
      })()`],
      answer: { value: { result: true } },
    }],
  },
  {
    name: "a known secret appearing through a field property change invalidates the captured frame",
    page: "private-capture.html",
    steps: [{
      op: "eval",
      args: [`(async () => {
        ${request}
        await request("start", ["known-sentinel"]);
        await request("prepare", ["known-sentinel"]);
        document.querySelector("#ordinary").value = "known-sentinel";
        const check = await request("check", ["known-sentinel"]);
        await request("restore");
        return { refused: typeof check.error === "string" && check.error.startsWith("screenshot privacy: "), events: document.documentElement.dataset.fieldEvents };
      })()`],
      answer: { value: { result: { refused: true, events: "0" } } },
    }],
  },
  ...[
    { name: "a user-filled code", field: "#otp", secret: "639275", echo: "639275", encoded: "639275" },
    { name: "an encoded user-filled password", field: "#password", secret: "fresh+pass/[7]?", echo: "fresh+pass/[7]?", encoded: "fresh%2Bpass%2F%5B7%5D%3F" },
    { name: "a grouped user-filled card number", field: "#card", secret: "5555555555554444", echo: "5555 5555-5555 4444", encoded: "5555%205555-5555%204444" },
    { name: "a user-filled code equal to numeric geometry", field: "#otp", secret: "2026", echo: "2026", encoded: "2026" },
  ].map(({ name, field, secret, echo, encoded }) => ({
    name: `source metadata hides ${name} without changing protection or geometry`,
    page: `private-capture.html?view=summary&credential=${encoded}#review`,
    steps: [{
      op: "eval",
      args: [`(async () => {
        ${request}
        const field = document.querySelector(${JSON.stringify(field)});
        field.value = ${JSON.stringify(secret)};
        const title = "Account review: " + ${JSON.stringify(echo)};
        document.title = title;
        document.querySelector("#known").textContent = ${JSON.stringify(echo)};
        document.body.style.minHeight = "2026px";
        const viewport = { width: innerWidth, height: innerHeight, devicePixelRatio };
        const start = await request("start");
        const result = await request("prepare");
        ${coverage}
        const range = document.createRange();
        range.selectNodeContents(document.querySelector("#known"));
        const protectedField = covers(field.getBoundingClientRect());
        const protectedEcho = [...range.getClientRects()].every(covers);
        const ordinary = covers(bounds("#ordinary"));
        const metadata = (response) => ({ title: response.value.source.title, url: new URL(response.value.source.url).search + new URL(response.value.source.url).hash });
        const valid = (await request("check")).value?.ok === true;
        await request("restore");
        return {
          start: metadata(start),
          prepare: metadata(result),
          protectedField,
          protectedEcho,
          ordinary,
          viewportPreserved: JSON.stringify(start.value.source.viewport) === JSON.stringify(viewport) && JSON.stringify(result.value.source.viewport) === JSON.stringify(viewport),
          page: result.value.page,
          valid,
          unchanged: field.value === ${JSON.stringify(secret)} && document.title === title,
          events: document.documentElement.dataset.fieldEvents,
        };
      })()`],
      answer: { value: { result: {
        start: { title: "Account review: ...", url: "?view=summary&credential=...#review" },
        prepare: { title: "Account review: ...", url: "?view=summary&credential=...#review" },
        protectedField: true,
        protectedEcho: true,
        ordinary: false,
        viewportPreserved: true,
        page: { x: 0, y: 0, height: 2026 },
        valid: true,
        unchanged: true,
        events: "0",
      } } },
    }],
  })),
]);

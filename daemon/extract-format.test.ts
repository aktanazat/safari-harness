import { expect, test } from "bun:test";
import { formatResult } from "./tools.ts";

test("a gathered read says which dialogs its page raised and how each was answered", () => {
  const url = "http://feed.example/";
  const text = formatResult({
    url,
    title: "Feed",
    text: "Item 1",
    harvested: "scrolled 18 times, 150 items, stopped: nothing new",
    dialogs: [
      { type: "alert", message: "Batch three arrived", answer: null, url },
      { type: "confirm", message: "Keep loading?", answer: false, url },
      { type: "prompt", message: "Your name?", answer: "Ann", url },
    ],
  });
  expect(text).toContain('alert "Batch three arrived"');
  expect(text).toContain('confirm "Keep loading?", dismissed');
  expect(text).toContain('prompt "Your name?", answered "Ann"');
});

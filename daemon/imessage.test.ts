import { expect, test } from "bun:test";
import { findCode } from "./imessage.ts";

// imessage_wait_code types whatever findCode returns into a sign-in form, so
// a wrong number is worse than none.

test("finds the code in common sign-in texts", () => {
  expect(findCode("Your Apple Account code is: 482913. Don't share it with anyone.")).toBe("482913");
  expect(findCode("G-551203 is your Google verification code.")).toBe("551203");
  expect(findCode("Chase: your one-time code is 123-456. We will never call to ask for it.")).toBe("123456");
});

test("picks the number next to the sign-in word, not a date or amount", () => {
  expect(findCode("On Sep 25 2026 your verification code is 4829")).toBe("4829");
  expect(findCode("Payment of 2500 pending. Your login code: 771204")).toBe("771204");
});

test("ignores numbers in texts that are not sign-in codes", () => {
  expect(findCode("Your order #58213 has shipped and is confirmed")).toBeNull();
  expect(findCode("Verification for order #58213 failed, reply HELP")).toBeNull();
  expect(findCode("Your order 58213 has shipped")).toBeNull();
  expect(findCode("Lunch at 1230?")).toBeNull();
  expect(findCode("Use code SAVE20 to get $15 off")).toBeNull();
  expect(findCode("A login attempt at 10:45 was blocked")).toBeNull();
});

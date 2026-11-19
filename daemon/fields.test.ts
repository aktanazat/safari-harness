import { expect, test } from "bun:test";
import { pickFields } from "./fields.ts";

test("fields takes a card's price, not the struck-out price beside it", () => {
  const cards = {
    kind: "cards",
    headers: ["h3.s-item__title", "span.s-item__price--was", "span.s-item__price", "span.s-item__seller"],
    rows: [
      ["Red kettle", "$40.00", "$29.99", "kettleshop"],
      ["Blue kettle", "$45.00", "$31.50", "potsandpans"],
      ["Green kettle", "$38.00", "$27.25", "kettleshop"],
    ],
  };
  const picked = pickFields([cards], ["title", "price", "seller"]);
  expect(picked.rows.map((row) => row.price)).toEqual(["$29.99", "$31.50", "$27.25"]);
});

test("fields reads a JSON feed's rows by their keys", () => {
  const picked = pickFields([[{ name: "serde", downloads: 1736, updated_at: "2026-07-18" }, { name: "tokio", downloads: 900, updated_at: "2026-07-02" }]], ["title", "date"]);
  expect(picked.rows).toEqual([{ title: "serde", date: "2026-07-18" }, { title: "tokio", date: "2026-07-02" }]);
});

// The card lists content.js reads from ratings.html (bench/fixtures): a
// rating drawn only by class names reads as its number, hinted "rating".
const BOOKS = { kind: "cards", headers: ["h3.title", "p.star-rating", "p.price"], hints: ["", "rating", ""], rows: [["A Light in the Attic", "3", "£51.77"], ["Tipping the Velvet", "1", "£53.74"], ["Soumission", "5", "£50.10"]] };
const SHOP = { kind: "cards", headers: ["h3.name", "span.meta", "span.cost"], hints: ["", "rating", ""], rows: [["Kettle", "4", "$29.99"], ["Toaster", "4.5", "$31.50"], ["Blender", "0", "$27.25"]] };
const UNCLEAR = { kind: "cards", headers: ["h3.name", "span.cost"], rows: [["Two values", "$1.00"], ["Run together", "$2.00"], ["Out of ten", "$3.00"]] };

test("fields takes a rating drawn only by class names, by the column's name", () => {
  const picked = pickFields([BOOKS], ["title", "price", "rating"]);
  expect(picked.rows).toEqual([
    { title: "A Light in the Attic", price: "£51.77", rating: "3" },
    { title: "Tipping the Velvet", price: "£53.74", rating: "1" },
    { title: "Soumission", price: "£50.10", rating: "5" },
  ]);
  expect(picked.fields.rating).toMatchObject({ column: "p.star-rating", by: "name" });
});

test("fields takes a class-drawn rating whose column says nothing, by its hint", () => {
  const picked = pickFields([SHOP], ["title", "rating"]);
  expect(picked.rows.map((row) => row.rating)).toEqual(["4", "4.5", "0"]);
  expect(picked.fields.rating).toMatchObject({ column: "span.meta", by: "hint" });
});

test("fields leaves a rating missing where no card's classes told it, and gives it no price", () => {
  const picked = pickFields([UNCLEAR], ["title", "price", "rating"]);
  expect(picked.missing).toEqual(["rating"]);
  expect(picked.rows.map((row) => row.rating)).toEqual(["", "", ""]);
});

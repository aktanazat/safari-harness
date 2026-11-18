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

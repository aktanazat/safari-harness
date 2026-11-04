// An action whose page navigates while it runs is answered for the page it
// went to, { ok: true, navigated: { url, title } } (act in background.js):
// the page that would have given the action's own answer is gone. A caller
// that reads a field of that answer asks here first.

export type Navigated = { url: string; title: string };

export function navigatedOf(res: unknown): Navigated | undefined {
  if (!res || typeof res !== "object" || !("navigated" in res)) return undefined;
  const to = res.navigated;
  if (!to || typeof to !== "object" || !("url" in to) || typeof to.url !== "string") return undefined;
  return { url: to.url, title: "title" in to && typeof to.title === "string" ? to.title : "" };
}

// An action that opened a tab answers with that tab, { newTab: { id, url,
// title } } (act in background.js).
export function newTabOf(res: unknown): { id: number } | undefined {
  if (!res || typeof res !== "object" || !("newTab" in res)) return undefined;
  const t = res.newTab;
  if (!t || typeof t !== "object" || !("id" in t) || typeof t.id !== "number") return undefined;
  return { id: t.id };
}

// What a fill reports: the fields the page says it filled, or, when a form
// that submits itself took the page away before it could say, the fields
// sent to it and where the page went.
export function filledOf(res: unknown, sent: string[], what: string): { filled: string[]; navigated?: Navigated } {
  const navigated = navigatedOf(res);
  const said = res && typeof res === "object" && "filled" in res && Array.isArray(res.filled) ? res.filled.map(String) : [];
  const filled = said.length > 0 || !navigated ? said : sent;
  if (filled.length === 0) throw new Error(`the page changed before the ${what} was filled`);
  return navigated ? { filled, navigated } : { filled };
}

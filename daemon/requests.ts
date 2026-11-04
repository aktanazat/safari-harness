export function localRequest(req: Request, url: URL): boolean {
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false;
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== url.origin) return false;
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || (site === "none" && req.method === "GET");
}

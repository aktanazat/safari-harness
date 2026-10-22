import { Resolver } from "node:dns/promises";
import { get } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export async function verifyPublicMemorySource(source: { url: string; title: string; body: string }): Promise<boolean> {
  const url = URL.parse(source.url);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port || url.search || isIP(url.hostname) || !url.hostname.includes(".") || /\.(?:local|localhost|internal|lan|home)$/.test(url.hostname) || source.body.length > 24000) return false;
  try {
    const until = Date.now() + 5000;
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    const cancel = setTimeout(() => resolver.cancel(), 5000);
    cancel.unref();
    let v4: string[], v6: string[];
    try {
      const empty = (error: unknown): string[] => {
        if (error && typeof error === "object" && "code" in error && (error.code === "ENODATA" || error.code === "ENOTFOUND")) return [];
        throw error;
      };
      [v4, v6] = await Promise.all([resolver.resolve4(url.hostname).catch(empty), resolver.resolve6(url.hostname).catch(empty)]);
    } finally {
      clearTimeout(cancel);
    }
    const addresses = [...v4.map((address) => ({ address, family: 4 })), ...v6.map((address) => ({ address, family: 6 }))];
    if (Date.now() >= until) return false;
    if (!addresses.length || addresses.some(({ address, family }) => family === 4 ? blocked.check(address, "ipv4") : !globalV6.check(address, "ipv6") || blocked.check(address, "ipv6"))) return false;
    const address = addresses.find((entry) => entry.family === 4) ?? addresses[0];
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const request = get(url, { agent: false, autoSelectFamily: false, headers: { accept: "text/html", "accept-encoding": "identity", "cache-control": "no-store", "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, (response) => {
      if (response.statusCode !== 200 || !response.headers["content-type"]?.startsWith("text/html") || Number(response.headers["content-length"] ?? 0) > 524288 || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) {
        response.destroy();
        reject(new Error("the anonymous source is not readable public HTML"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 524288) { request.destroy(new Error("public source verification exceeded its limit")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
    });
    const timer = setTimeout(() => request.destroy(new Error("public source verification timed out")), Math.max(1, until - Date.now()));
    timer.unref();
    request.on("error", reject);
    request.on("close", () => clearTimeout(timer));
    const html = await promise;
    let text = "", title = "";
    await new HTMLRewriter().on("title", { text(chunk) { title += chunk.text; } }).onDocument({ text(chunk) { text += chunk.text; } }).transform(new Response(html)).text();
    const normalize = (value: string) => value.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (original: string, hex: string | undefined, decimal: string | undefined) => {
      const code = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : original;
    }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_original, name: string) => entities[name] ?? "").replace(/\s+/g, " ").trim();
    const publicText = normalize(text);
    const lines = source.body.split("\n").map(normalize).filter(Boolean);
    return normalize(title) === normalize(source.title) && lines.length > 0 && lines.every((line) => publicText.includes(line));
  } catch {
    return false;
  }
}

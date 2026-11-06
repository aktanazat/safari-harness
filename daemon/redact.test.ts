import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Invoke } from "./call.ts";
import { PACE_TOOL } from "./pace.ts";
import { redactSecrets, redactSecretText } from "./redact.ts";
import { ReplSession } from "./repl.ts";

// Made-up values of each shape, joined at run time so no file holds one
// whole: scanners read the source as well.
const k = (...parts: string[]) => parts.join("");
const FAKE = {
  openai: k("sk-", "proj-", "Fixture0123456789abcdefXYZ"),
  anthropic: k("sk-", "ant-", "api03-Fixture0123456789abcdefXYZ"),
  slack: k("xo", "xb-", "1111111111-2222222222-Fixture0123abc"),
  aws: k("AK", "IA", "FIXTURE012345678"),
  jwt: k("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "yb2xlIjoic2VydmljZV9yb2xlIn0", ".", "Fixture0123456789abc"),
  github: k("gh", "p_", "Fixture0123456789abcdefghijklmnopqrst"),
  github_pat: k("github", "_pat_", "11FIXTURE0_0123456789abcdefghij"),
  supabase: k("sb_", "secret_", "Fixture0123456789abcdef"),
  telnyx: k("KEY", "0190FIXTURE0123456789ABCDEF", "_", "Fixture0123456789abcdef"),
  tavily: k("tv", "ly-", "Fixture0123456789abcdef"),
  perplexity: k("pp", "lx-", "Fixture0123456789abcdefghijklmnopqrstuvwxyz01"),
  private_key: k("-----BEGIN ", "PRIVATE KEY-----\nMIIFixture0123\n-----END ", "PRIVATE KEY-----"),
};

// On 11-06 Slack and Notion reads put keys of all these kinds, pasted by
// teammates, into transcripts (audit I-1).
test("each key shape is cut to [REDACTED:kind] and counted", () => {
  const counts = {};
  const text = Object.entries(FAKE).map(([kind, v]) => `${kind}: ${v}`).join("\n");
  const out = redactSecretText(text, counts);
  for (const v of Object.values(FAKE)) expect(out).not.toContain(v);
  expect(out).toBe([
    "openai: [REDACTED:openai]",
    "anthropic: [REDACTED:anthropic]",
    "slack: [REDACTED:slack]",
    "aws: [REDACTED:aws]",
    "jwt: [REDACTED:jwt]",
    "github: [REDACTED:github]",
    "github_pat: [REDACTED:github]",
    "supabase: [REDACTED:supabase]",
    "telnyx: [REDACTED:telnyx]",
    "tavily: [REDACTED:tavily]",
    "perplexity: [REDACTED:perplexity]",
    "private_key: [REDACTED:private_key]",
  ].join("\n"));
  expect(counts).toEqual({ private_key: 1, jwt: 1, anthropic: 1, openai: 1, slack: 1, aws: 1, github: 2, supabase: 1, telnyx: 1, tavily: 1, perplexity: 1 });
});

// A Notion page of env keys held a 65-character hex *_API_TOKEN and a
// uuid-shaped Exa key beside the shapes above (MineSessionA-4, D-1).
test("a value after a credential's name is cut, the name kept", () => {
  const counts = {};
  const text = [
    k("BENCH_API", "_TOKEN=", "a3f5c2e1b4d6978877665544332211aabbccddeeff00112233445566778899aab"),
    k('"X-API', '-Key": "', "fixture_9f8e7d6c5b4a3210", '"'),
    k("EXA_API", "_KEY=", "123e4567-e89b-12d3-a456-426614174000"),
    k("DB_PASS", "WORD: Fixture-pass-77"),
  ].join("\n");
  expect(redactSecretText(text, counts)).toBe([
    "BENCH_API_TOKEN=[REDACTED:secret]",
    '"X-API-Key": "[REDACTED:secret]"',
    "EXA_API_KEY=[REDACTED:secret]",
    "DB_PASSWORD: [REDACTED:password]",
  ].join("\n"));
  expect(counts).toEqual({ secret: 3, password: 1 });
});

test("links, ids, uuids, hashes, labels and paging tokens stay whole", () => {
  const text = [
    "https://example.com/a/b?id=123&page=2 and https://www.notion.so/Bench-KT-3c3c16ba560a80e983dfeb3b9c123b33",
    "uuid 123e4567-e89b-12d3-a456-426614174000, git da39a3ee5e6b4b0d3255bfef95601890afd80709, md5 d41d8cd98f00b204e9800998ecf8427e",
    "Slack ts 1730812345.123456 in C08FIXTURE1 by U0FIXTURE",
    k("sk-spinner-double-bounce, risk-adjusted-return-2024, ta", "sk-", "1234567890abcdefghij"),
    "Password: Required; password: ********; token: abc; sort_key=createdAt",
    "nextPageToken: CiAKGjBpNDd2Nmp2Zml2cXRiYmQ5, max_tokens: 4096",
    "OPENAI_API_KEY=[REDACTED:openai]",
  ].join("\n");
  const counts = {};
  expect(redactSecretText(text, counts)).toBe(text);
  expect(counts).toEqual({});
});

test("a structure's strings are cut however deep, a file's base64 bytes left whole", () => {
  const { value, redacted } = redactSecrets({ data: FAKE.openai, rows: [{ text: `key ${FAKE.openai}` }], n: 3 });
  expect(value).toEqual({ data: FAKE.openai, rows: [{ text: "key [REDACTED:openai]" }], n: 3 });
  expect(redacted).toEqual({ openai: 1 });
});

// The audit's own case (I-1): a Slack search through the REPL returned a
// channel's pasted keys verbatim. The run's answer has them cut and counted;
// the script itself still sees the page as it is.
test("a REPL run's Slack search comes back with its keys cut and a count of each kind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "redact-repl-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const TEAM = { teamId: "T1", name: "Acme", domain: "acme", url: "https://acme.slack.com/", userId: "U1", signedIn: true, lastActive: true };
  const text = `here are the keys: ${FAKE.openai} ${FAKE.slack} ${FAKE.aws} and ${FAKE.jwt}`;
  const send: Invoke = async (tool, args) => {
    if (tool === "open") return { id: 1 };
    if (tool === "pace") return PACE_TOOL.run(args);
    if (tool !== "eval") return { ok: true };
    if (!/\/api\/search\.messages/.test(String(args.expression))) return { result: { lastActiveTeamId: "T1", teams: [TEAM] } };
    const answer = { ok: true, messages: { matches: [{ ts: "1.0", user: "U2", text, channel: { id: "C1", name: "eng" } }], paging: { total: 1, page: 1, pages: 1 } } };
    return { result: { status: 200, retryAfter: null, text: JSON.stringify(answer), truncated: false } };
  };
  const repl = new ReplSession("redact", { cwd: dir, invoke: send });
  const r = await repl.run(`const c = await slack.getClient(); const { matches } = await c.search("keys"); console.log(matches[0].text.includes(${JSON.stringify(FAKE.aws)})); matches[0].text`);
  expect(r.error).toBeUndefined();
  expect(r.output).toBe("true\nhere are the keys: [REDACTED:openai] [REDACTED:slack] [REDACTED:aws] and [REDACTED:jwt]");
  expect(r.redacted).toEqual({ openai: 1, slack: 1, aws: 1, jwt: 1 });
  await repl.close();
});

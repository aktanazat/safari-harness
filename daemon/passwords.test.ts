import { expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { bridge } from "./bridge.ts";
import { passwords } from "./passwords.ts";
import { callTool } from "./tools.ts";

// The passwords tool promises three things: only the code the Mac shows
// unlocks it, a wrong code cannot be retried, and a fill puts the password
// into the page without handing it to the caller. The fake helper below plays
// Apple's side of the pairing (the SRP server, whose math differs from the
// client's), so a client that computes the key wrong fails to pair here.

const N = BigInt(
  "0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
);
const G = 5n;
const CODE = "482913";
const SECRET = "correct horse battery staple";
const SITE = "login.example.com";
const USER = "aktan@example.com";

const H = (...parts: (Buffer | string)[]) => parts.reduce((h, p) => h.update(p), createHash("sha256")).digest();
const big = (b: Buffer) => BigInt(`0x${b.toString("hex") || "0"}`);
const buf = (n: bigint, len = 0) => {
  const hex = n.toString(16);
  return Buffer.from(hex.padStart(Math.max(len * 2, hex.length + (hex.length % 2)), "0"), "hex");
};
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  for (let x = b % N; e > 0n; e >>= 1n, x = (x * x) % N) if (e & 1n) r = (r * x) % N;
  return r;
}

type Sent = Record<string, unknown> & { cmd: number };

// Apple's helper: shows CODE, verifies the client's proof, and answers
// encrypted queries for one saved login.
function fakeHelper() {
  const queries: string[] = [];
  let srp: { user: string; A: Buffer; B: Buffer; b: bigint; v: bigint; salt: Buffer } | null = null;
  let key: Buffer | null = null;

  const answer = (m: Sent): Record<string, unknown> => {
    const msg = m.msg && typeof m.msg === "object" && "PAKE" in m.msg ? m.msg : null;
    if (m.cmd === 14) return { cmd: 14, capabilities: { shouldUseBase64: true } };
    if (m.cmd === 2 && msg) {
      const pake = JSON.parse(Buffer.from(String(msg.PAKE), "base64").toString());
      const reply = (o: unknown) => ({ cmd: 2, payload: { PAKE: Buffer.from(JSON.stringify(o)).toString("base64") } });
      if (pake.MSG === 0) {
        const salt = randomBytes(16);
        const v = pow(G, big(H(salt, H(`${pake.TID}:${CODE}`))));
        const b = big(randomBytes(32));
        const k = big(H(buf(N), buf(G, 384)));
        const B = buf((k * v + pow(G, b)) % N);
        srp = { user: pake.TID, A: Buffer.from(pake.A, "base64"), B, b, v, salt };
        return reply({ TID: pake.TID, MSG: 1, B: B.toString("base64"), s: salt.toString("base64"), PROTO: 1 });
      }
      if (!srp) return reply({ TID: pake.TID, MSG: 3, ErrCode: 2 });
      const s = srp;
      srp = null;
      const u = big(H(buf(big(s.A), 384), buf(big(s.B), 384)));
      const K = H(buf(pow((big(s.A) * pow(s.v, u)) % N, s.b)));
      const hng = Buffer.from(H(buf(N)).map((x, i) => x ^ H(buf(G, 384))[i]));
      const M = H(hng, H(s.user), s.salt, s.A, s.B, K);
      if (!M.equals(Buffer.from(pake.M, "base64"))) return reply({ TID: pake.TID, MSG: 3, ErrCode: 1 });
      key = K.subarray(0, 16);
      return reply({ TID: pake.TID, MSG: 3, HAMK: H(s.A, M, K).toString("base64"), ErrCode: 0 });
    }
    const payload = m.payload && typeof m.payload === "object" && "SMSG" in m.payload ? m.payload : null;
    if (payload && key) {
      const smsg = JSON.parse(String(payload.SMSG));
      const data = Buffer.from(smsg.SDATA, "base64");
      const d = createDecipheriv("aes-128-gcm", key, data.subarray(data.length - 16));
      d.setAuthTag(data.subarray(data.length - 32, data.length - 16));
      const q = JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 32)), d.final()]).toString());
      queries.push(`${m.cmd} ${q.URL}`);
      const out = m.cmd === 4 ? { STATUS: 0, Entries: [{ USR: USER, sites: [SITE] }] } : { STATUS: 0, Entries: [{ USR: q.USR, PWD: SECRET }] };
      const iv = randomBytes(16);
      const c = createCipheriv("aes-128-gcm", key, iv);
      const sealed = Buffer.concat([iv, c.update(JSON.stringify(out)), c.final(), c.getAuthTag()]);
      return { cmd: m.cmd, payload: { SMSG: JSON.stringify({ TID: smsg.TID, SDATA: sealed.toString("base64") }) } };
    }
    return { cmd: m.cmd };
  };

  const link = {
    send(data: string) {
      const reply = answer(JSON.parse(data).helper);
      queueMicrotask(() => passwords.handleMessage(JSON.stringify({ helper: reply })));
    },
    close() {},
  };
  passwords.attach(link);
  return { queries };
}

// The Safari tab: a sign-in page whose fields record what was typed.
function fakeTab(url: string) {
  const page: { username?: string; password?: string } = {};
  bridge.attach({
    send(data: string) {
      const { id, args } = JSON.parse(data);
      const [, op, opArgs] = args;
      const value = op === "tabInfo" ? { url }
        : op === "loginForm" ? { username: true, password: true }
        : op === "fillLogin" ? (Object.assign(page, { username: opArgs[1], password: opArgs[2] }), { ok: true, filled: ["username", "password"] })
        : null;
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
    },
    close() {},
  });
  return page;
}

test("the code on the Mac unlocks, and fill types the password into the page but never returns it", async () => {
  fakeHelper();
  const page = fakeTab(`https://${SITE}/signin`);
  await callTool("passwords", { do: "pair" });
  expect(await callTool("passwords", { do: "unlock", code: CODE })).toEqual({ unlocked: true });
  const result = await callTool("passwords", { do: "fill", tab: 7 });
  expect(page).toEqual({ username: USER, password: SECRET });
  expect(result).toEqual({ filled: ["username", "password"], username: USER, site: SITE });
  expect(JSON.stringify(await callTool("passwords", { do: "logins", tab: 7 }))).not.toContain(SECRET);
});

test("a wrong code is refused and cannot be retried with the right one", async () => {
  fakeHelper();
  fakeTab(`https://${SITE}/signin`);
  await callTool("passwords", { do: "pair" });
  await expect(callTool("passwords", { do: "unlock", code: "000000" })).rejects.toThrow("wrong code");
  await expect(callTool("passwords", { do: "unlock", code: CODE })).rejects.toThrow("no code is waiting");
  await expect(callTool("passwords", { do: "fill", tab: 7 })).rejects.toThrow("locked");
});

test("fill on a page that is not https asks the helper for nothing", async () => {
  const helper = fakeHelper();
  const page = fakeTab(`http://${SITE}/signin`);
  await callTool("passwords", { do: "pair" });
  await callTool("passwords", { do: "unlock", code: CODE });
  await expect(callTool("passwords", { do: "fill", tab: 7 })).rejects.toThrow("https");
  expect(helper.queries).toEqual([]);
  expect(page).toEqual({});
});

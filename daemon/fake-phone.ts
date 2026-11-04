// A stand-in for the user's iPhone on the card approval page (passkey.ts),
// for cards.test.ts: it reads a link's request as the page does, and
// answers it as Safari does after Face ID, with a P-256 passkey of its own
// and, for PRF output, an HMAC of the request's salt under a secret only it
// holds. An answer can be made the way a forged or broken one would be.

import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";

// signedFor: the page the phone says it signed on; uv: false, an answer
// Face ID did not verify; otherKey: signed by a key other than the
// passkey's, under its id; prf: PRF output other than the passkey's.
type How = { signedFor?: string; uv?: boolean; otherKey?: true; prf?: Buffer };

export class FakePhone {
  private readonly id = randomBytes(16);
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  private readonly secret = randomBytes(32);

  // What the page posts to link after Face ID: for a setup, the new
  // passkey and its first signature; for a fill, the signature alone.
  async answer(link: string, how: How = {}): Promise<Record<string, unknown>> {
    const o = Object.fromEntries(Object.entries(await (await fetch(`${link}/options`)).json()));
    const origin = how.signedFor ?? new URL(link).origin;
    const flags = 0x01 | (how.uv === false ? 0 : 0x04);
    const rpIdHash = createHash("sha256").update(String(o.rpId)).digest();
    const counter = Buffer.alloc(4);
    const b64 = (b: Buffer) => b.toString("base64url");
    const clientData = (type: string, challenge: unknown) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    const body: Record<string, unknown> = {};
    if (o.kind === "enroll") {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(this.id.length);
      // The passkey's id follows a zero AAGUID; its COSE key, which the
      // daemon reads from publicKey instead, is left out.
      const made = Buffer.concat([rpIdHash, Buffer.from([flags | 0x40]), counter, Buffer.alloc(16), length, this.id]);
      body.registration = { id: b64(this.id), clientDataJSON: b64(clientData("webauthn.create", o.create)), authenticatorData: b64(made), publicKey: b64(this.keys.publicKey.export({ type: "spki", format: "der" })), publicKeyAlgorithm: -7 };
    }
    const data = clientData("webauthn.get", o.challenge);
    const auth = Buffer.concat([rpIdHash, Buffer.from([flags]), counter]);
    const key = how.otherKey ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey : this.keys.privateKey;
    const signature = sign("sha256", Buffer.concat([auth, createHash("sha256").update(data).digest()]), { key, dsaEncoding: "der" });
    body.assertion = { id: b64(this.id), clientDataJSON: b64(data), authenticatorData: b64(auth), signature: b64(signature) };
    body.prf = b64(how.prf ?? createHmac("sha256", this.secret).update(Buffer.from(String(o.salt), "base64url")).digest());
    return body;
  }

  // body posted to link, as the page posts it.
  post(link: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(link, { method: "POST", headers: { "content-type": "application/json", origin: new URL(link).origin }, body: JSON.stringify(body) });
  }

  // Face ID, then its answer posted.
  async approve(link: string, how: How = {}): Promise<Response> {
    return this.post(link, await this.answer(link, how));
  }
}

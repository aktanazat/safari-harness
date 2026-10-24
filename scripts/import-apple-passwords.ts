// Rebuilds the logins this Mac keeps (daemon/vault.ts) from the file Apple
// Passwords writes with File > Export All Passwords to File, then deletes
// that file, which holds every password in plain text. Verification-code
// keys (its OTPAuth column) are left out, so the copy alone passes no
// two-step sign-in. Prints counts and hosts, never a username or password.
//
//   bun scripts/import-apple-passwords.ts /path/to/Passwords.csv

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOGINS_DIR, type Login, memSecretVault, refusal } from "../daemon/vault.ts";

// RFC 4180: quoted fields may hold commas, doubled quotes, and line breaks.
function rows(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') field += text[++i];
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) out.push([...row, field]);
  return out;
}

// The store opens with the key mem-secret uses on this Mac: the key file
// when there is one, else the Keychain's.
function sealToThisMac(): void {
  if (existsSync(join(LOGINS_DIR, "recipients.txt"))) return;
  const keyFile = join(homedir(), ".config", "sops", "age", "keys.txt");
  const read = existsSync(keyFile)
    ? Bun.spawnSync(["age-keygen", "-y", keyFile])
    : Bun.spawnSync(["sh", "-c", `"$0" | age-keygen -y`, join(homedir(), "memory", "bin", "_age-key-cmd")]);
  const recipient = read.stdout.toString().trim();
  if (!read.success || !recipient.startsWith("age1")) throw new Error("this Mac's age key could not be read");
  mkdirSync(LOGINS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(LOGINS_DIR, "recipients.txt"), `${recipient}  # this Mac only\n`, { mode: 0o600 });
}

const file = process.argv[2];
if (!file) {
  console.error("usage: bun scripts/import-apple-passwords.ts /path/to/Passwords.csv");
  process.exit(2);
}
try {
  const [header = [], ...records] = rows(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  const column = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`not an Apple Passwords export: no ${name} column`);
    return i;
  };
  const [url, username, password] = [column("URL"), column("Username"), column("Password")];
  const logins = new Map<string, Login>();
  const skipped = new Map<string, string[]>();
  for (const r of records) {
    const site = URL.parse(r[url] ?? "");
    const host = site && /^https?:$/.test(site.protocol) ? site.hostname.replace(/^www\./, "") : "";
    const login = { host, username: r[username] ?? "", password: r[password] ?? "" };
    const why = host ? refusal(login) : "no website";
    if (why) skipped.set(why, [...(skipped.get(why) ?? []), host]);
    else logins.set(`${host}\n${login.username}`, login);
  }
  sealToThisMac();
  await memSecretVault().rebuild([...logins.values()]);
  console.log(`kept ${logins.size} logins for ${new Set([...logins.values()].map((l) => l.host)).size} sites`);
  for (const [why, hosts] of skipped) {
    const named = [...new Set(hosts.filter(Boolean))];
    console.log(`skipped ${hosts.length} (${why})${named.length ? `: ${named.join(", ")}` : ""}`);
  }
} finally {
  rmSync(file, { force: true });
}

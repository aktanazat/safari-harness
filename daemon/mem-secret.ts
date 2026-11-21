// A mem-secret store of the harness's own, sealed to this Mac's age key
// alone: the logins (vault.ts) and the cards (card-vault.ts). mem-secret is
// the one engram's install puts on PATH: on the work Mac it lives in
// ~/.local/bin and ~/memory/bin does not exist (11-20).
//
// mem-secret never prints a value: run hands the wanted variables to env,
// whose output only this process reads, and batch takes new values on
// stdin. Nothing here logs or returns a value.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// A call still running then waits on something nobody answers; the call
// fails rather than hang.
const CALL_MS = 15000;
const AGE_KEY = join(homedir(), ".config", "sops", "age", "keys.txt");

// The age key every call hands mem-secret, as the variable sops reads it
// from. With one named, mem-secret looks for no key of its own: unnamed, it
// runs the Keychain's through ~/memory/bin/_age-key-cmd unless ENGRAM_ROOT
// says otherwise, and launchd sets no ENGRAM_ROOT.
type Key = { name: "SOPS_AGE_KEY_FILE" | "SOPS_AGE_KEY_CMD"; value: string; source: string };

export type Opened = { memSecret: string; key: string; names: string[] | undefined };

export type Store = {
  call(args: string[], stdin?: string): Promise<string>;
  // mem-secret, the key's source, and the names the store keeps; with
  // make, a store not made yet is made, sealed to this Mac's key; without,
  // names is undefined for it, once mem-secret has run (it checks for sops
  // and age first). Throws why the store cannot be used.
  open(make: boolean): Promise<Opened>;
};

function memSecretPath(): string {
  const found = Bun.which("mem-secret", { PATH: process.env.PATH ?? "" });
  if (!found) throw new Error(`mem-secret is not on this process's PATH (${process.env.PATH ?? ""}); install engram's CLI there`);
  return found;
}

// The daemon's own key wins; then the key file, which sops reads with no
// Keychain prompt; then the Keychain, through the _age-key-cmd that ships
// beside mem-secret.
function keyOf(memSecret: string): Key {
  const { SOPS_AGE_KEY_CMD: cmd, SOPS_AGE_KEY_FILE: file } = process.env;
  if (cmd) return { name: "SOPS_AGE_KEY_CMD", value: cmd, source: `the command ${cmd} (SOPS_AGE_KEY_CMD)` };
  if (file) return { name: "SOPS_AGE_KEY_FILE", value: file, source: `the key file ${file} (SOPS_AGE_KEY_FILE)` };
  if (existsSync(AGE_KEY)) return { name: "SOPS_AGE_KEY_FILE", value: AGE_KEY, source: `the key file ${AGE_KEY}` };
  const beside = join(dirname(realpathSync(memSecret)), "_age-key-cmd");
  return { name: "SOPS_AGE_KEY_CMD", value: beside, source: `the Keychain, through ${beside}` };
}

async function recipientOf(key: Key): Promise<string> {
  const read = key.name === "SOPS_AGE_KEY_FILE" ? ["age-keygen", "-y", key.value] : ["sh", "-c", `"$0" | age-keygen -y`, key.value];
  const proc = Bun.spawn(read, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: CALL_MS });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const recipient = out.trim();
  if (code !== 0 || !recipient.startsWith("age1")) throw new Error(`this Mac's age key could not be read from ${key.source}`);
  return recipient;
}

// what names the store in errors: "vault", "card vault".
export function memSecretStore(dir: string, what: string): Store {
  async function call(args: string[], stdin?: string): Promise<string> {
    const memSecret = memSecretPath();
    const key = keyOf(memSecret);
    const env: Record<string, string | undefined> = { ...process.env, ENGRAM_SECRETS_DIR: dir };
    delete env.SOPS_AGE_KEY_FILE;
    delete env.SOPS_AGE_KEY_CMD;
    env[key.name] = key.value;
    const proc = Bun.spawn([memSecret, ...args], {
      env,
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: CALL_MS,
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (proc.signalCode) throw new Error(`the ${what} did not answer within ${CALL_MS / 1000} s`);
    if (code !== 0) throw new Error(`the ${what} refused: ${err.trim().split("\n").pop() || `mem-secret exited ${code}`}`);
    return out;
  }

  return {
    call,

    async open(make) {
      const memSecret = memSecretPath();
      const key = keyOf(memSecret);
      const recipient = await recipientOf(key);
      const sealed = join(dir, "recipients.txt");
      if (!existsSync(sealed)) {
        if (!make) {
          await call(["list"]);
          return { memSecret, key: key.source, names: undefined };
        }
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // Linked into place whole, so a reader never sees it half written,
        // and a store another call sealed first is left as it is.
        const draft = join(dir, `.recipients.${process.pid}.${crypto.randomUUID()}`);
        await writeFile(draft, `${recipient}  # this Mac only\n`, { mode: 0o600 });
        await link(draft, sealed)
          .catch((e: NodeJS.ErrnoException) => {
            if (e.code !== "EEXIST") throw e;
          })
          .finally(() => rm(draft, { force: true }));
      }
      if (!readFileSync(sealed, "utf8").includes(recipient)) throw new Error(`the ${what} at ${dir} is sealed to another age key than this Mac's, read from ${key.source}`);
      return { memSecret, key: key.source, names: (await call(["list"])).split("\n").filter(Boolean) };
    },
  };
}

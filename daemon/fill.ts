// Filling forms from what the user already keeps: their address from the
// Contacts card marked as theirs, logins from Bitwarden, and the pairing
// that opens Apple Passwords (pair.ts). All run in the caller: reading
// Contacts needs the terminal's Full Disk Access, the Bitwarden vault is
// unlocked in the terminal's own environment, and the Mac's pairing code is
// read off its window with the terminal's Accessibility access. No reply
// carries what was filled, only which fields got it.

import { Database } from "bun:sqlite";
import { resolveTab, TAB, TOOLS, type TabInfo, type Tool } from "./tools.ts";
import { addressBooks } from "./imessage.ts";
import { rpc } from "./rpc.ts";
import { navigatedOf } from "./navigated.ts";
import { confirmSave, pairPasswords } from "./pair.ts";

type Labeled = { label: string; primary: boolean };
type Postal = Labeled & { street: string; city: string; state: string; zip: string; country: string; countryCode: string };

// "_$!<Home>!$_" -> "home"; a custom label stays as typed, lowercased.
const labelOf = (raw: string | null) => (raw ?? "").replace(/^_\$!</, "").replace(/>!\$_$/, "").toLowerCase();

function pick<T extends Labeled>(rows: T[], label?: string): T | undefined {
  return (label ? rows.find((r) => r.label === label.toLowerCase()) : undefined) ?? rows.find((r) => r.primary) ?? rows[0];
}

// The card Contacts marks as the user's own ("My Card"), across every
// account's address book, as autocomplete token -> value.
export function myCard(label?: string): Record<string, string> {
  let name: { f: string | null; m: string | null; l: string | null; o: string | null } | undefined;
  const postal: Postal[] = [];
  const phones: (Labeled & { v: string })[] = [];
  const emails: (Labeled & { v: string })[] = [];
  for (const path of addressBooks()) {
    let db: Database;
    try { db = new Database(path, { readonly: true }); } catch { continue; }
    try {
      const me = db.query("SELECT Z_PK id, ZFIRSTNAME f, ZMIDDLENAME m, ZLASTNAME l, ZORGANIZATION o FROM ZABCDRECORD WHERE ZCONTAINERWHERECONTACTISME IS NOT NULL").all() as { id: number; f: string | null; m: string | null; l: string | null; o: string | null }[];
      for (const p of me) {
        if (!name && (p.f || p.l)) name = p;
        const own = { $id: p.id };
        for (const r of db.query("SELECT ZSTREET s, ZCITY c, ZSTATE st, ZZIPCODE z, ZCOUNTRYNAME cn, ZCOUNTRYCODE cc, ZLABEL lb, ZISPRIMARY pr FROM ZABCDPOSTALADDRESS WHERE ZOWNER = $id").all(own) as { s: string | null; c: string | null; st: string | null; z: string | null; cn: string | null; cc: string | null; lb: string | null; pr: number | null }[]) {
          postal.push({ street: r.s ?? "", city: r.c ?? "", state: r.st ?? "", zip: r.z ?? "", country: r.cn ?? "", countryCode: (r.cc ?? "").toUpperCase(), label: labelOf(r.lb), primary: r.pr === 1 });
        }
        for (const r of db.query("SELECT ZFULLNUMBER v, ZLABEL lb, ZISPRIMARY pr FROM ZABCDPHONENUMBER WHERE ZOWNER = $id AND ZFULLNUMBER IS NOT NULL").all(own) as { v: string; lb: string | null; pr: number | null }[]) phones.push({ v: r.v, label: labelOf(r.lb), primary: r.pr === 1 });
        for (const r of db.query("SELECT ZADDRESS v, ZLABEL lb, ZISPRIMARY pr FROM ZABCDEMAILADDRESS WHERE ZOWNER = $id AND ZADDRESS IS NOT NULL").all(own) as { v: string; lb: string | null; pr: number | null }[]) emails.push({ v: r.v, label: labelOf(r.lb), primary: r.pr === 1 });
      }
    } finally {
      db.close();
    }
  }
  if (!name && postal.length === 0) throw new Error("Contacts has no card marked as yours: in Contacts, choose your card, then Card > Make This My Card");
  const out: Record<string, string> = {};
  const set = (token: string, v: string | null | undefined) => { if (v) out[token] = v; };
  set("given-name", name?.f);
  set("additional-name", name?.m);
  set("family-name", name?.l);
  set("name", [name?.f, name?.m, name?.l].filter(Boolean).join(" "));
  set("organization", name?.o);
  const addr = pick(postal, label);
  if (label && postal.length && addr?.label !== label.toLowerCase()) throw new Error(`your card has no ${label} address; it has: ${postal.map((p) => p.label || "unlabeled").join(", ")}`);
  if (addr) {
    const lines = addr.street.split("\n");
    set("street-address", addr.street);
    set("address-line1", lines[0]);
    set("address-line2", lines.slice(1).join(", "));
    set("address-level2", addr.city);
    set("address-level1", addr.state);
    set("postal-code", addr.zip);
    set("country", addr.countryCode || addr.country);
    set("country-name", addr.country);
  }
  set("tel", pick(phones, label)?.v);
  set("email", pick(emails, label)?.v);
  return out;
}

async function bw(args: string[]): Promise<string> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["bw", ...args, "--nointeraction"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error("the Bitwarden CLI is not installed: brew install bitwarden-cli");
  }
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`bw ${args[0]}: ${err.trim() || `exited ${code}`}`);
  return out;
}

const BW_LOCKED: Record<string, string> = {
  unauthenticated: "Bitwarden is signed out: run `bw login` once in a terminal, then `export BW_SESSION=$(bw unlock --raw)` in the terminal (or MCP client) that runs safari",
  locked: "Bitwarden is locked: run `export BW_SESSION=$(bw unlock --raw)` in the terminal (or MCP client) that runs safari, then try again",
};

type BwItem = { id: string; name: string; type: number; login?: { username?: string | null; password?: string | null } };

// The site comes from the tab, never from the caller: the frame holding the
// sign-in form, or the top page. So a login only reaches the site whose
// address Bitwarden has saved for it.
async function bitwarden(a: Record<string, unknown>): Promise<unknown> {
  const status = (JSON.parse(await bw(["status"])) as { status: string }).status;
  if (BW_LOCKED[status]) throw new Error(BW_LOCKED[status]);
  const tab = await resolveTab(a.tab, async () => (await rpc("tabs")) as TabInfo[]);
  const form = await rpc("login_form", { tab });
  if (!form || typeof form !== "object" || !("site" in form) || typeof form.site !== "string" || !("frame" in form) || typeof form.frame !== "number") throw new Error("the tab's sign-in form did not answer; reload it with goto and try again");
  const site = form.site;
  const frame = form.frame;
  const items = (JSON.parse(await bw(["list", "items", "--url", `https://${site}`])) as BwItem[]).filter((i) => i.type === 1 && i.login);
  const usernames = items.map((i) => i.login?.username ?? "").filter(Boolean);
  if ((a.do ?? "fill") === "logins") return { site, usernames };
  const wanted = a.username === undefined ? undefined : String(a.username);
  const chosen = wanted === undefined ? (items.length === 1 ? items[0] : undefined) : items.find((i) => i.login?.username === wanted);
  if (!chosen) {
    throw new Error(items.length === 0 ? `Bitwarden has no login saved for ${site}` : wanted === undefined ? `several Bitwarden logins for ${site}; pass username: ${usernames.join(", ")}` : `no Bitwarden login ${wanted} for ${site}; saved: ${usernames.join(", ")}`);
  }
  // Only the fields the form holds are sent, so a form that submits itself
  // as it is filled is said to have got just those.
  const res = await rpc("login_fill", {
    tab,
    frame,
    site,
    username: "username" in form && form.username === true ? chosen.login?.username ?? null : null,
    password: "password" in form && form.password === true ? chosen.login?.password ?? null : null,
  });
  const filled = res && typeof res === "object" && "filled" in res && Array.isArray(res.filled) ? res.filled.map(String) : [];
  const navigated = navigatedOf(res);
  return { filled, ...(navigated ? { navigated } : {}), username: chosen.login?.username ?? "", site };
}

// Apple Passwords with one touch. pair, or a call that finds it locked,
// pairs first (pair.ts): the user approves with Touch ID, and the code the
// Mac shows is read off its window or typed by him into a prompt there.
// The agent learns only whether it paired, and the call goes on.
async function applePasswords(a: Record<string, unknown>): Promise<unknown> {
  const status = async () => {
    const s = await rpc("passwords", { do: "status" });
    return s && typeof s === "object" ? (s as { unlocked?: boolean; helper?: number }) : {};
  };
  if (a.do !== "pair") {
    try {
      return await (a.do === "change" ? change(a, await status()) : rpc("passwords", a));
    } catch (e) {
      if (!["logins", "fill", "code", "change"].includes(String(a.do)) || (await status()).unlocked === true) throw e;
    }
  } else if ((await status()).unlocked === true) {
    return { paired: true };
  }
  const tab = a.tab === undefined ? undefined : await resolveTab(a.tab, async () => (await rpc("tabs")) as TabInfo[]).catch(() => undefined);
  const form = tab === undefined ? undefined : await rpc("login_form", { tab }).catch(() => undefined);
  const site = form && typeof form === "object" && "site" in form && typeof form.site === "string" ? ` to sign in to ${form.site}` : "";
  const paired = await pairPasswords(site);
  return a.do === "pair" || !paired.paired ? paired : rpc("passwords", a);
}

// A changed password is saved the way Safari saves one it suggested, and
// Apple's helper then asks in its own window whether to update the saved
// one, answering nothing until a button is pressed. Nobody watches that
// window for an agent, so while the call runs, its Update Password is
// pressed here, where the terminal's Accessibility access is; only the
// window naming the tab's site.
async function change(a: Record<string, unknown>, status: { helper?: number }): Promise<unknown> {
  const tabs = (await rpc("tabs")) as TabInfo[];
  const tab = await resolveTab(a.tab, async () => tabs);
  const url = tabs.find((t) => t.id === tab)?.url;
  if (status.helper === undefined || !url) return rpc("passwords", a);
  const stop = new AbortController();
  const pressed = confirmSave(status.helper, new URL(url).hostname, stop.signal);
  try {
    return await rpc("passwords", a);
  } finally {
    stop.abort();
    await pressed;
  }
}

export const FILL_TOOLS: Record<string, Tool> = {
  // The daemon's own tool (tools.ts), listed once from there, with the
  // one-touch pairing in front.
  passwords: { ...TOOLS.passwords, hidden: true, run: applePasswords },
  fill_address: {
    desc: "Fill the page's empty address, name, email, and phone fields from the user's own Contacts card; card-number fields are left alone. Returns which fields were filled, not what.",
    params: { tab: TAB, label: { type: "string", description: "which address on the card, e.g. home or work; default the primary one" }, root: { type: "string", description: "CSS selector of the form, when the page has several" } },
    required: ["tab"],
    hidden: true,
    run: async (a) => rpc("autofill", { tab: a.tab, values: myCard(a.label === undefined ? undefined : String(a.label)), root: a.root }),
  },
  bitwarden: {
    desc: "Fill the tab's sign-in form with the login Bitwarden saved for its site; you never see the password. logins lists the saved usernames.",
    params: { do: { type: "string", enum: ["fill", "logins"], description: "default fill" }, tab: TAB, username: { type: "string", description: "which saved login, when there are several" } },
    required: ["tab"],
    hidden: true,
    run: bitwarden,
  },
};

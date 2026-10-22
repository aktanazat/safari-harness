import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

const SOURCE = await Bun.file(new URL("./upgrades.js", import.meta.url)).text();
const STORAGE = "agent-upgrade-origins";
type Feature = "react" | "siteActions";
type Settings = Record<string, Partial<Record<Feature, boolean>>>;
type Registration = { id: string; matches: string[]; js: string[] };
type Configure = (tabId: number, feature: Feature, enabled: boolean) => Promise<{ origin: string; feature: Feature; enabled: boolean; reloadRequired: boolean }>;

function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

function start(origins: string[]) {
  let settings: Settings = {};
  const registrations = new Map<string, Registration>();
  let registrationHold: { entered: () => void; wait: Promise<void> } | undefined;
  let writeHold: { entered: () => void; wait: Promise<void> } | undefined;
  let removalHold: { entered: () => void; wait: Promise<void> } | undefined;
  let writeFailure: Error | undefined;
  const api = {
    storage: { local: {
      get: async () => ({ [STORAGE]: structuredClone(settings) }),
      set: async (items: Record<string, Settings>) => {
        const failure = writeFailure;
        writeFailure = undefined;
        const hold = writeHold;
        writeHold = undefined;
        if (hold) {
          hold.entered();
          await hold.wait;
        }
        if (failure) throw failure;
        settings = structuredClone(items[STORAGE]);
      },
    } },
    scripting: {
      executeScript: async ({ target, args }: { target: { tabId: number }; args?: unknown[] }) => [{ result: args ? null : { origin: origins[target.tabId - 1], document: `document-${target.tabId}` } }],
      getRegisteredContentScripts: async ({ ids }: { ids: string[] }) => structuredClone(ids.flatMap((id) => {
        const script = registrations.get(id);
        return script ? [script] : [];
      })),
      registerContentScripts: async (scripts: Registration[]) => {
        const hold = registrationHold;
        registrationHold = undefined;
        if (hold) {
          hold.entered();
          await hold.wait;
        }
        for (const script of scripts) {
          if (registrations.has(script.id)) throw new Error("content script id already registered");
          registrations.set(script.id, structuredClone(script));
        }
      },
      unregisterContentScripts: async ({ ids }: { ids: string[] }) => {
        const hold = removalHold;
        removalHold = undefined;
        if (hold) {
          hold.entered();
          await hold.wait;
        }
        for (const id of ids) registrations.delete(id);
      },
    },
  };
  const crypto = { subtle: { digest: async (_algorithm: string, bytes: Uint8Array) => createHash("sha256").update(bytes).digest() } };
  const configure: Configure = new Function("api", "crypto", `${SOURCE}\nreturn upgradeConfigure;`)(api, crypto);
  return {
    configure,
    permissions: () => structuredClone(settings),
    hooks: () => [...registrations.values()].map((script) => ({
      scope: script.matches[0],
      feature: script.js.includes("site-actions.js") ? "siteActions" : "react",
    })).sort((a, b) => `${a.scope}:${a.feature}`.localeCompare(`${b.scope}:${b.feature}`)),
    holdRegistration() {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      registrationHold = { entered: entered.resolve, wait: release.promise };
      return { entered: entered.promise, release: () => release.resolve() };
    },
    holdWrite() {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      writeHold = { entered: entered.resolve, wait: release.promise };
      return { entered: entered.promise, release: release.resolve };
    },
    holdRemoval() {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      removalHold = { entered: entered.resolve, wait: release.promise };
      return { entered: entered.promise, release: release.resolve };
    },
    refuseNextWrite(error: Error) { writeFailure = error; },
  };
}

const enableCases: { name: string; first: Feature; second: Feature; origins: string[] }[] = [
  { name: "react on separate hosts", first: "react", second: "react", origins: ["https://one.example", "https://two.example"] },
  { name: "site actions on separate hosts", first: "siteActions", second: "siteActions", origins: ["https://one.example", "https://two.example"] },
  { name: "react on shared-host ports", first: "react", second: "react", origins: ["https://one.example:4001", "https://one.example:4002"] },
  { name: "site actions on shared-host ports", first: "siteActions", second: "siteActions", origins: ["https://one.example:4001", "https://one.example:4002"] },
  { name: "different features on separate hosts", first: "react", second: "siteActions", origins: ["https://one.example", "https://two.example"] },
  { name: "different features on one origin", first: "react", second: "siteActions", origins: ["https://one.example", "https://one.example"] },
];

test.each(enableCases)("overlapping enables retain both permissions and matching hooks: $name", async ({ first, second, origins }) => {
  const browser = start(origins);
  const hold = browser.holdRegistration();
  const earlier = browser.configure(1, first, true);
  await hold.entered;
  const later = browser.configure(2, second, true);
  const completed = Promise.all([earlier, later]);
  try {
    await settle();
  } finally {
    hold.release();
  }
  const replies = await completed;
  expect(replies).toMatchObject([
    { origin: origins[0], feature: first, enabled: true, reloadRequired: true },
    { origin: origins[1], feature: second, enabled: true, reloadRequired: true },
  ]);
  const expected: Settings = {};
  expected[origins[0]] = { [first]: true };
  expected[origins[1]] = { ...expected[origins[1]], [second]: true };
  expect(browser.permissions()).toEqual(expected);
  const hooks = origins.map((origin, index) => {
    const url = new URL(origin);
    return { scope: `${url.protocol}//${url.hostname}/*`, feature: index === 0 ? first : second };
  });
  const uniqueHooks = hooks.filter((hook, index) => hooks.findIndex((other) => other.scope === hook.scope && other.feature === hook.feature) === index);
  expect(browser.hooks()).toEqual(uniqueHooks.sort((a, b) => `${a.scope}:${a.feature}`.localeCompare(`${b.scope}:${b.feature}`)));
});

test.each(["react", "siteActions"] as const)("a later overlapping disable leaves %s disabled without a startup hook", async (feature) => {
  const origin = "https://one.example";
  const browser = start([origin, origin]);
  const hold = browser.holdRegistration();
  const earlier = browser.configure(1, feature, true);
  await hold.entered;
  const later = browser.configure(2, feature, false);
  const completed = Promise.all([earlier, later]);
  try {
    await settle();
  } finally {
    hold.release();
  }
  expect(await completed).toMatchObject([{ enabled: true }, { enabled: false }]);
  expect(browser.permissions()).toEqual({ [origin]: { [feature]: false } });
  expect(browser.hooks()).toEqual([]);
});

test.each(["react", "siteActions"] as const)("a later overlapping enable leaves %s enabled with its startup hook", async (feature) => {
  const origin = "https://one.example";
  const browser = start([origin, origin]);
  await browser.configure(1, feature, true);
  const hold = browser.holdRemoval();
  const earlier = browser.configure(1, feature, false);
  await hold.entered;
  const later = browser.configure(2, feature, true);
  const completed = Promise.all([earlier, later]);
  try {
    await settle();
  } finally {
    hold.release();
  }
  expect(await completed).toMatchObject([{ enabled: false }, { enabled: true }]);
  expect(browser.permissions()).toEqual({ [origin]: { [feature]: true } });
  expect(browser.hooks()).toEqual([{ scope: "https://one.example/*", feature }]);
});

test.each(["react", "siteActions"] as const)("a rejected %s enable rolls back its hook and allows the queued update", async (feature) => {
  const origins = ["https://one.example", "https://two.example"];
  const browser = start(origins);
  const hold = browser.holdWrite();
  const failure = new Error("Safari storage write failed");
  browser.refuseNextWrite(failure);
  const earlier = browser.configure(1, feature, true);
  const rejected = earlier.catch((error: unknown) => error);
  await hold.entered;
  const later = browser.configure(2, feature, true);
  const completed = Promise.all([rejected, later]);
  try {
    await settle();
  } finally {
    hold.release();
  }
  const [error, reply] = await completed;
  expect(error).toBe(failure);
  expect(reply).toMatchObject({ origin: origins[1], feature, enabled: true, reloadRequired: true });
  expect(browser.permissions()).toEqual({ [origins[1]]: { [feature]: true } });
  expect(browser.hooks()).toEqual([{ scope: "https://two.example/*", feature }]);
});

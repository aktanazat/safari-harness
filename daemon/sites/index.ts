// The site globals `safari repl` binds, by name. Each factory takes the
// session's SiteKit and returns plain methods; nothing opens until a method
// runs.

import type { SiteKit } from "./kit.ts";
import { imessage } from "./imessage.ts";
import { slack } from "./slack.ts";
import { notion } from "./notion.ts";
import { gmail, googleAccounts, googleDocs, googleSheets } from "./google.ts";
import { googleSearch } from "./google-search.ts";
import { youtube } from "./youtube.ts";
import { x } from "./x.ts";

export const SITE_GLOBALS: Record<string, (kit: SiteKit) => object> = {
  slack,
  gmail,
  googleAccounts,
  notion,
  googleDocs,
  googleSheets,
  googleSearch,
  youtube,
  x,
  imessage,
};

// Other names for the same global.
export const SITE_ALIASES: Record<string, string> = { twitter: "x" };

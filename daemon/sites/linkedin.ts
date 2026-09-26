// LinkedIn (www.linkedin.com) for safari repl: the web app's own Voyager
// API, called from the kit's background tab so the owner's session goes
// with each request. The tab parks on a path LinkedIn has nothing for (its
// small not-found page), because the feed starves a hidden tab's scripts.
// LinkedIn's security policy refuses page-world eval, so the calls run in
// the extension's content-script world: they read the csrf token from the
// JSESSIONID cookie there, and it never leaves the tab. Messaging, posts,
// and jobs go through the app's GraphQL, whose query ids the app's bundles
// name; they are read from the bundles once per session (fetched, never
// navigated to, so nothing is marked read). Requests are paced 1 to 1.75 s
// apart; LinkedIn flags bursts hard, and this is the owner's real account.

import { draftOrSend, NotSignedIn, type SiteKit } from "./kit.ts";

const ORIGIN = "https://www.linkedin.com";
const SITE = "LinkedIn";
const PARK_URL = `${ORIGIN}/safari-repl`;
const API = "/voyager/api";
// The route whose bundles register every query used here.
const BUNDLE_PAGE = `${ORIGIN}/messaging/`;
const PACE_MIN_MS = 1000;
const PACE_JITTER_MS = 750;
const NOTE_MAX = 300;

// A GraphQL query as the bundles register it: the id LinkedIn wants in the
// url, keyed by the name the app gives it.
const QUERIES = {
  inbox: "find-conversations-by-category",
  conversationsWith: "find-conversations-by-recipients",
  messages: "get-messages-by-timestamp",
  posts: "get-feed-dash-profile-updates-by-member-share-feed",
  job: "fetch-full-job-posting",
} as const;
type Query = keyof typeof QUERIES;

type Job = { method: string; path: string; body: string | null; query: string | null; discover: string[] };
type Reply = { signedOut?: boolean; status: number; url: string; body: unknown; ids?: Record<string, string> };

// Runs in the tab. Plain script: nothing leaves but the response and the
// query ids, which hold no secrets.
const PAGE = String.raw`
const cookie = (name) => (document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]+)")) || [])[1] || "";
const csrf = () => decodeURIComponent(cookie("JSESSIONID")).replace(/^"|"$/g, "");
// The bundles register each query as {kind, id, typeName, name}.
const discover = async (names) => {
  const html = await (await fetch(${JSON.stringify(BUNDLE_PAGE)}, { credentials: "include" })).text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const srcs = [...doc.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"));
  const texts = await Promise.all(srcs.map(async (s) => { try { return await (await fetch(s)).text(); } catch { return ""; } }));
  const ids = {};
  for (const t of texts) for (const m of t.matchAll(/id:"(voyager[A-Za-z]+\.[0-9a-f]{32})",typeName:"[^"]+",name:"([^"]+)"/g)) if (names.includes(m[2]) && !ids[m[2]]) ids[m[2]] = m[1];
  return ids;
};
const run = async (job) => {
  if (!cookie("JSESSIONID")) return { signedOut: true, status: 0, url: "", body: null };
  const out = {};
  let path = job.path;
  if (job.query) {
    const ids = await discover(job.discover);
    out.ids = ids;
    if (!ids[job.query]) throw new Error("LinkedIn's web app no longer defines the " + job.query + " query");
    path = path.replace("QUERY_ID", ids[job.query]);
  }
  const headers = { "csrf-token": csrf(), accept: "application/vnd.linkedin.normalized+json+2.1", "x-restli-protocol-version": "2.0.0", "x-li-lang": "en_US" };
  if (job.body !== null) headers["content-type"] = "application/json; charset=UTF-8";
  const r = await fetch(${JSON.stringify(ORIGIN + API)} + path, { method: job.method, credentials: "include", headers, body: job.body === null ? undefined : job.body });
  const t = await r.text();
  let body = t.slice(0, 500);
  try { body = JSON.parse(t); } catch {}
  return Object.assign({ status: r.status, url: r.url, body }, out);
};
`;

// ---------- Rest.li url encoding ----------

// A value inside a Rest.li parameter: strings percent-encoded with the
// parentheses the syntax reserves, lists as List(a,b), numbers as they are.
type RestliValue = string | number | boolean | RestliValue[] | { [key: string]: RestliValue };
function restli(v: RestliValue): string {
  if (Array.isArray(v)) return `List(${v.map(restli).join(",")})`;
  if (typeof v === "object") return `(${Object.entries(v).map(([k, x]) => `${k}:${restli(x)}`).join(",")})`;
  if (typeof v === "string") return encodeURIComponent(v).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return String(v);
}

// ---------- shapes the endpoints answer with (only what we read) ----------

type Included = { $type?: string; entityUrn?: string } & Record<string, unknown>;
type Envelope = { data?: Record<string, unknown>; included?: Included[] };
type Text = { text?: string } | null | undefined;
type DateParts = { year?: number; month?: number; day?: number } | null | undefined;
type DateRange = { start?: DateParts; end?: DateParts } | null | undefined;

const text = (t: Text): string => t?.text ?? "";
const dateOf = (d: DateParts): string => (d?.year ? [d.year, d.month, d.day].filter((n) => n !== undefined).map((n, i) => (i ? String(n).padStart(2, "0") : String(n))).join("-") : "");
const iso = (ms: unknown): string => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : "");
const stripQuery = (url: string): string => url.split("?")[0];
// An activity id is a timestamp in its top bits, the way the app shows "2d".
const activityTime = (activityUrn: string): string => {
  const id = /(\d{15,})/.exec(activityUrn)?.[1];
  return id ? new Date(Number(BigInt(id) >> 22n)).toISOString() : "";
};

// The entities in the envelope, by urn and by type.
class Bag {
  private byUrn = new Map<string, Included>();
  private byType = new Map<string, Included[]>();
  constructor(readonly env: Envelope) {
    for (const e of env.included ?? []) {
      if (e.entityUrn) this.byUrn.set(e.entityUrn, e);
      const type = (e.$type ?? "").split(".").pop() ?? "";
      const list = this.byType.get(type);
      if (list) list.push(e);
      else this.byType.set(type, [e]);
    }
  }
  get(urn: unknown): Included | undefined {
    return typeof urn === "string" ? this.byUrn.get(urn) : undefined;
  }
  all(type: string): Included[] {
    return this.byType.get(type) ?? [];
  }
  first(type: string): Included | undefined {
    return this.byType.get(type)?.[0];
  }
}

const idOf = (urn: unknown, kind: string): string => (typeof urn === "string" ? (new RegExp(`urn:li:${kind}:([^,()]+)`).exec(urn)?.[1] ?? "") : "");
const profileUrn = (id: string): string => `urn:li:fsd_profile:${id}`;

// ---------- what the methods answer with ----------

export type Me = { id: string; publicId: string; name: string; headline: string; url: string };
export type Experience = { title: string; company: string; companyUrl: string; location: string; start: string; end: string; description: string };
export type Education = { school: string; degree: string; field: string; start: string; end: string };
export type Profile = { id: string; publicId: string; url: string; name: string; firstName: string; lastName: string; headline: string; about: string; location: string; industry: string; premium: boolean; avatar: string; experience: Experience[]; education: Education[] };
export type PersonHit = { id: string; name: string; headline: string; location: string; distance: string; url: string };
export type CompanyHit = { id: string; name: string; headline: string; summary: string; followers: string; url: string };
export type Search<T> = { results: T[]; total: number; nextStart?: number };
export type Company = { id: string; universalName: string; name: string; url: string; website: string; tagline: string; description: string; industries: string[]; type: string; staffCount: number; staffRange: string; headquarters: string; founded: number | null; followers: number; specialties: string[] };
export type JobPosting = { id: string; url: string; title: string; company: { name: string; url: string }; location: string; employmentType: string; listedAt: string; expiresAt: string; description: string; applyUrl: string };
export type Post = { id: string; url: string; author: { name: string; url: string }; text: string; createdAt: string; likes: number; comments: number; reposts: number; reshare: boolean };
export type Participant = { id: string; name: string; headline: string; url: string };
export type Message = { id: string; from: Participant; text: string; subject: string; sentAt: string; attachments: string[] };
export type Conversation = { id: string; url: string; title: string; group: boolean; participants: Participant[]; unread: boolean; unreadCount: number; lastActivityAt: string; lastMessage: Message | null };
export type Thread = { id: string; url: string; participants: Participant[]; messages: Message[] };

// ---------- readers ----------

function profile(bag: Bag, p: Included): Profile {
  const id = idOf(p.entityUrn, "fsd_profile");
  const geo = bag.get((p.geoLocation as { geoUrn?: string } | null)?.geoUrn);
  const industry = bag.get(p.industryUrn);
  const picture = (p.profilePicture as { displayImageReference?: { vectorImage?: { rootUrl?: string; artifacts?: { width?: number; fileIdentifyingUrlPathSegment?: string }[] } } } | null)?.displayImageReference?.vectorImage;
  const largest = (picture?.artifacts ?? []).reduce<{ width?: number; fileIdentifyingUrlPathSegment?: string } | null>((best, a) => (!best || (a.width ?? 0) > (best.width ?? 0) ? a : best), null);
  const range = (d: DateRange) => ({ start: dateOf(d?.start), end: dateOf(d?.end) });
  const experience = bag.all("Position").map((x): Experience => {
    const company = bag.get(x.companyUrn);
    return { title: (x.title as string) ?? "", company: (x.companyName as string) ?? (company?.name as string) ?? "", companyUrl: (company?.url as string) ?? "", location: (x.locationName as string) ?? "", ...range(x.dateRange as DateRange), description: (x.description as string) ?? "" };
  });
  const education = bag.all("Education").map((x): Education => ({ school: (x.schoolName as string) ?? "", degree: (x.degreeName as string) ?? "", field: (x.fieldOfStudy as string) ?? "", ...range(x.dateRange as DateRange) }));
  const key = (s: string) => (s ? s : "0000");
  experience.sort((a, b) => key(b.start).localeCompare(key(a.start)));
  education.sort((a, b) => key(b.start).localeCompare(key(a.start)));
  const publicId = (p.publicIdentifier as string) ?? "";
  return {
    id,
    publicId,
    url: `${ORIGIN}/in/${publicId || id}/`,
    name: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim(),
    firstName: (p.firstName as string) ?? "",
    lastName: (p.lastName as string) ?? "",
    headline: (p.headline as string) ?? "",
    about: (p.summary as string) ?? "",
    location: (geo?.defaultLocalizedName as string) ?? "",
    industry: (industry?.name as string) ?? "",
    premium: p.premium === true,
    avatar: picture?.rootUrl && largest?.fileIdentifyingUrlPathSegment ? picture.rootUrl + largest.fileIdentifyingUrlPathSegment : "",
    experience,
    education,
  };
}

// Search answers in clusters of items; the hits are entityResult items, in
// the order the page shows them.
function searchHits(bag: Bag): Included[] {
  const hits: Included[] = [];
  const clusters = (bag.env.data?.elements ?? []) as { items?: { itemUnion?: { "*entityResult"?: string } }[] }[];
  for (const c of clusters) for (const i of c.items ?? []) {
    const hit = bag.get(i.itemUnion?.["*entityResult"]);
    if (hit) hits.push(hit);
  }
  return hits;
}

function searchPage<T>(bag: Bag, start: number, count: number, hit: (e: Included) => T): Search<T> {
  const results = searchHits(bag).map(hit);
  const total = (bag.env.data?.paging as { total?: number } | undefined)?.total ?? results.length;
  const next = start + count;
  return { results, total, ...(results.length === count && next < total ? { nextStart: next } : {}) };
}

function person(e: Included): PersonHit {
  return { id: idOf(e.entityUrn, "fsd_profile"), name: text(e.title as Text), headline: text(e.primarySubtitle as Text), location: text(e.secondarySubtitle as Text), distance: text(e.badgeText as Text).replace(/^•\s*/, ""), url: stripQuery((e.navigationUrl as string) ?? "") };
}

function companyHit(e: Included): CompanyHit {
  return { id: idOf(e.entityUrn, "fsd_company"), name: text(e.title as Text), headline: text(e.primarySubtitle as Text), summary: text(e.summary as Text), followers: text(e.secondarySubtitle as Text), url: stripQuery((e.navigationUrl as string) ?? "") };
}

function company(bag: Bag, c: Included): Company {
  const hq = c.headquarter as { city?: string; geographicArea?: string; country?: string } | null;
  const range = c.staffCountRange as { start?: number; end?: number } | null;
  const following = bag.get(c["*followingInfo"]);
  return {
    id: idOf(c.entityUrn, "fs_normalized_company"),
    universalName: (c.universalName as string) ?? "",
    name: (c.name as string) ?? "",
    url: (c.url as string) ?? "",
    website: (c.companyPageUrl as string) ?? "",
    tagline: (c.tagline as string) ?? "",
    description: (c.description as string) ?? "",
    industries: (c.industries as string[]) ?? [],
    type: (c.companyType as { localizedName?: string } | null)?.localizedName ?? "",
    staffCount: (c.staffCount as number) ?? 0,
    staffRange: range?.start ? `${range.start}${range.end ? `-${range.end}` : "+"}` : "",
    headquarters: [hq?.city, hq?.geographicArea, hq?.country].filter(Boolean).join(", "),
    founded: (c.foundedOn as { year?: number } | null)?.year ?? null,
    followers: (following?.followerCount as number) ?? 0,
    specialties: (c.specialities as string[]) ?? [],
  };
}

function jobPosting(bag: Bag, j: Included): JobPosting {
  const id = idOf(j.entityUrn, "fsd_jobPosting");
  const details = j.companyDetails as { name?: string; jobCompany?: { "*company"?: string } } | null;
  const co = bag.get(details?.jobCompany?.["*company"]);
  const geo = bag.get(j["*location"]);
  return {
    id,
    url: `${ORIGIN}/jobs/view/${id}/`,
    title: (j.title as string) ?? "",
    company: { name: details?.name ?? (co?.name as string) ?? "", url: (co?.url as string) ?? "" },
    location: (geo?.defaultLocalizedName as string) ?? "",
    employmentType: (bag.get(j["*employmentStatus"])?.localizedName as string) ?? "",
    listedAt: iso(j.listedAt),
    expiresAt: iso(j.expireAt),
    description: text(j.description as Text),
    applyUrl: (j.companyApplyUrl as string) ?? "",
  };
}

function post(bag: Bag, u: Included): Post {
  const meta = u.metadata as { backendUrn?: string } | null;
  const activity = meta?.backendUrn ?? idOf(u.entityUrn, "fsd_update");
  const actor = u.actor as { name?: Text; navigationContext?: { actionTarget?: string } | null } | null;
  const counts = bag.get(bag.get(u["*socialDetail"])?.["*totalSocialActivityCounts"]);
  const share = (u.socialContent as { shareUrl?: string } | null)?.shareUrl;
  return {
    id: idOf(activity, "activity") || activity,
    url: share ? stripQuery(share) : `${ORIGIN}/feed/update/${activity}/`,
    author: { name: text(actor?.name), url: stripQuery(actor?.navigationContext?.actionTarget ?? "") },
    text: text((u.commentary as { text?: Text } | null)?.text),
    createdAt: activityTime(activity),
    likes: (counts?.numLikes as number) ?? 0,
    comments: (counts?.numComments as number) ?? 0,
    reposts: (counts?.numShares as number) ?? 0,
    reshare: typeof u.entityUrn === "string" && u.entityUrn.includes(",RESHARED,"),
  };
}

function participant(bag: Bag, urn: unknown): Participant {
  const p = bag.get(urn);
  const kinds = (p?.participantType ?? {}) as Record<string, Record<string, unknown> | null>;
  const member = kinds.member;
  const other = kinds.organization ?? kinds.custom ?? kinds.agent;
  const id = idOf(p?.hostIdentityUrn ?? urn, "fsd_profile") || idOf(p?.hostIdentityUrn ?? urn, "fsd_company");
  if (member) return { id, name: `${text(member.firstName as Text)} ${text(member.lastName as Text)}`.trim(), headline: text(member.headline as Text), url: stripQuery((member.profileUrl as string) ?? "") };
  return { id, name: text(other?.name as Text), headline: "", url: "" };
}

function message(bag: Bag, m: Included): Message {
  const render = (m.renderContent ?? []) as Record<string, unknown>[];
  return {
    id: idOf(m.backendUrn, "messagingMessage"),
    from: participant(bag, m["*sender"]),
    text: text(m.body as Text),
    subject: (m.subject as string) ?? "",
    sentAt: iso(m.deliveredAt),
    attachments: render.flatMap((r) => Object.keys(r).filter((k) => !k.startsWith("$") && r[k] !== null)),
  };
}

const threadId = (conversationUrn: unknown): string => (typeof conversationUrn === "string" ? /,([^,()]+)\)$/.exec(conversationUrn)?.[1] ?? "" : "");

function conversation(bag: Bag, c: Included, me: string): Conversation {
  const id = threadId(c.entityUrn);
  const participants = ((c["*conversationParticipants"] ?? []) as string[]).map((u) => participant(bag, u)).filter((p) => p.id !== me);
  const messages = ((c.messages as { "*elements"?: string[] } | null)?.["*elements"] ?? []).map((u) => bag.get(u)).filter((m): m is Included => !!m);
  messages.sort((a, b) => ((b.deliveredAt as number) ?? 0) - ((a.deliveredAt as number) ?? 0));
  return {
    id,
    url: (c.conversationUrl as string) ?? `${ORIGIN}/messaging/thread/${id}/`,
    title: (c.title as string) ?? "",
    group: c.groupChat === true,
    participants,
    unread: c.read === false || ((c.unreadCount as number) ?? 0) > 0,
    unreadCount: (c.unreadCount as number) ?? 0,
    lastActivityAt: iso(c.lastActivityAt),
    lastMessage: messages[0] ? message(bag, messages[0]) : null,
  };
}

// ---------- identifiers the methods accept ----------

// A public id (vanity name) or profile id from a bare value or a profile url.
const memberIdentity = (idOrUrl: string): string => {
  const s = idOrUrl.trim().replace(/^urn:li:fsd_profile:/, "");
  const m = /linkedin\.com\/in\/([^/?#]+)/.exec(s);
  const id = m ? decodeURIComponent(m[1]) : s;
  if (!id || /[/?#\s]/.test(id)) throw new Error(`not a LinkedIn profile id or url: ${idOrUrl}`);
  return id;
};
const universalName = (nameOrUrl: string): string => {
  const s = nameOrUrl.trim();
  const m = /linkedin\.com\/(?:company|school|showcase)\/([^/?#]+)/.exec(s);
  const name = m ? decodeURIComponent(m[1]) : s;
  if (!name || /[/?#\s]/.test(name)) throw new Error(`not a LinkedIn company name or url: ${nameOrUrl}`);
  return name;
};
const jobId = (idOrUrl: string): string => {
  const m = /(?:^|jobs\/view\/|jobPosting:|currentJobId=)(\d{6,})(?:[/?#&]|$)/.exec(idOrUrl.trim());
  if (!m) throw new Error(`not a LinkedIn job id or url: ${idOrUrl}`);
  return m[1];
};
// A thread id ("2-..."), a conversation urn, or a messaging thread url.
const threadOf = (conversation: string): string => {
  const s = conversation.trim();
  const m = /messaging\/thread\/([^/?#]+)/.exec(s);
  const id = m ? decodeURIComponent(m[1]) : threadId(s) || s;
  if (!/^\d+-[A-Za-z0-9+/=_-]+$/.test(id)) throw new Error(`not a LinkedIn conversation id or url: ${conversation}`);
  return id;
};

const uuid = () => crypto.randomUUID();

export function linkedin(kit: SiteKit) {
  // Query ids found this session, and the owner's profile id.
  const ids = new Map<string, string>();
  let myId = "";

  async function call(method: string, path: string, opts: { body?: string; query?: Query } = {}): Promise<unknown> {
    await kit.tab(ORIGIN, PARK_URL);
    await kit.pace("linkedin", PACE_MIN_MS + Math.random() * PACE_JITTER_MS);
    const query = opts.query ?? null;
    const known = query ? ids.get(QUERIES[query]) : undefined;
    const job: Job = { method, path: known ? path.replace("QUERY_ID", known) : path, body: opts.body ?? null, query: known ? null : query && QUERIES[query], discover: Object.values(QUERIES) };
    const r = await kit.eval<Reply>(ORIGIN, `(async () => {${PAGE}\nreturn run(${JSON.stringify(job)});})()`);
    if (r.ids) for (const [name, id] of Object.entries(r.ids)) ids.set(name, id);
    if (r.signedOut || r.status === 401 || r.status === 403 || /\/(login|uas\/login|authwall)/.test(r.url)) throw new NotSignedIn(SITE, r.signedOut ? "no session cookie" : r.status ? `HTTP ${r.status}` : "redirected to sign in");
    if (r.url.includes("/checkpoint/")) throw new Error("LinkedIn is challenging this account (redirected to a checkpoint); stop and sign in by hand before trying again");
    if (r.status === 429) throw new Error("LinkedIn rate-limited this request (HTTP 429); wait a few minutes before trying again");
    if (r.status === 999) throw new Error("LinkedIn blocked this request (HTTP 999); stop for at least a minute before trying again");
    const body = r.body as Envelope | string;
    if (r.status < 200 || r.status >= 300) throw new Error(`LinkedIn answered HTTP ${r.status}${typeof body === "string" ? `: ${body.slice(0, 200)}` : ""}`);
    if (typeof body === "string") throw new Error(`LinkedIn did not answer with JSON: ${body.slice(0, 200)}`);
    const errors = ((body.data?.errors ?? []) as { message?: string }[]).map((e) => e.message ?? "").filter((m) => !/jobBudget|Budget fetch/.test(m));
    if (errors.length && !Object.keys(body.data ?? {}).some((k) => k !== "errors" && k !== "$type" && k !== "$recipeTypes")) throw new Error(`LinkedIn refused the request: ${errors.join("; ")}`);
    return body;
  }

  const get = (path: string): Promise<Bag> => call("GET", path).then((b) => new Bag(b as Envelope));
  const graphql = (query: Query, variables: { [key: string]: RestliValue }): Promise<Bag> => call("GET", `/graphql?queryId=QUERY_ID&variables=${restli(variables)}`, { query }).then((b) => new Bag(b as Envelope));
  const send = (path: string, body: unknown): Promise<unknown> => call("POST", path, { body: JSON.stringify(body) });

  async function me(): Promise<Me> {
    const bag = await get("/me");
    const mini = bag.first("MiniProfile");
    if (!mini) throw new NotSignedIn(SITE, "the session's member was not found");
    const publicId = (mini.publicIdentifier as string) ?? "";
    myId = idOf(mini.entityUrn, "fs_miniProfile");
    return { id: myId, publicId, name: `${mini.firstName ?? ""} ${mini.lastName ?? ""}`.trim(), headline: (mini.occupation as string) ?? "", url: `${ORIGIN}/in/${publicId}/` };
  }
  const mailbox = async (): Promise<string> => profileUrn(myId || (await me()).id);

  async function profileByIdentity(idOrUrl: string): Promise<{ bag: Bag; raw: Included }> {
    const identity = memberIdentity(idOrUrl);
    const bag = await get(`/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(identity)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101`);
    const raw = bag.get(((bag.env.data?.["*elements"] ?? []) as string[])[0]) ?? bag.first("Profile");
    if (!raw) throw new Error(`no LinkedIn member ${identity}`);
    return { bag, raw };
  }

  const search = (keywords: string, type: "PEOPLE" | "COMPANIES", start: number, count: number): Promise<Bag> => get(`/search/dash/clusters?decorationId=com.linkedin.voyager.dash.deco.search.SearchClusterCollection-175&origin=GLOBAL_SEARCH_HEADER&q=all&query=${restli({ keywords, flagshipSearchIntent: "SEARCH_SRP", queryParameters: { resultType: [type] }, includeFiltersInResponse: false })}&start=${start}&count=${count}`);

  // The conversations the mailbox has with these members, if any.
  async function conversationWith(recipientUrn: string): Promise<string> {
    const bag = await graphql("conversationsWith", { mailboxUrn: await mailbox(), recipients: [recipientUrn] });
    const found = (bag.env.data?.data as { messengerConversationsByRecipients?: { "*elements"?: string[] } } | undefined)?.messengerConversationsByRecipients?.["*elements"] ?? [];
    return found[0] ?? "";
  }

  return {
    // ----- reads -----
    getMe: (): Promise<Me> => me(),

    // LinkedIn may count this as a profile view the member can see.
    async getProfile(publicIdOrUrl: string): Promise<Profile> {
      const { bag, raw } = await profileByIdentity(publicIdOrUrl);
      return profile(bag, raw);
    },

    async searchPeople(query: string, opts: { limit?: number; start?: number } = {}): Promise<Search<PersonHit>> {
      const [start, count] = [opts.start ?? 0, opts.limit ?? 10];
      return searchPage(await search(query, "PEOPLE", start, count), start, count, person);
    },

    async searchCompanies(query: string, opts: { limit?: number; start?: number } = {}): Promise<Search<CompanyHit>> {
      const [start, count] = [opts.start ?? 0, opts.limit ?? 10];
      return searchPage(await search(query, "COMPANIES", start, count), start, count, companyHit);
    },

    async getCompany(universalNameOrUrl: string): Promise<Company> {
      const name = universalName(universalNameOrUrl);
      const bag = await get(`/organization/companies?q=universalName&universalName=${encodeURIComponent(name)}`);
      const raw = bag.get(((bag.env.data?.["*elements"] ?? []) as string[])[0]) ?? bag.first("Company");
      if (!raw) throw new Error(`no LinkedIn company ${name}`);
      return company(bag, raw);
    },

    async getJob(jobIdOrUrl: string): Promise<JobPosting> {
      const id = jobId(jobIdOrUrl);
      const bag = await graphql("job", { jobPostingUrn: `urn:li:fsd_jobPosting:${id}` });
      const raw = bag.get(bag.env.data?.data && (bag.env.data.data as Record<string, unknown>)["*jobsDashJobPostingsById"]) ?? bag.first("JobPosting");
      if (!raw) throw new Error(`LinkedIn job ${id} is not available (closed, or the id is wrong)`);
      return jobPosting(bag, raw);
    },

    // A member's own posts and reposts, newest first.
    async getUserPosts(profileIdOrUrl: string, opts: { limit?: number } = {}): Promise<{ posts: Post[] }> {
      const identity = memberIdentity(profileIdOrUrl);
      const id = /^ACo[A-Za-z0-9_-]{30,}$/.test(identity) ? identity : idOf((await profileByIdentity(identity)).raw.entityUrn, "fsd_profile");
      const bag = await graphql("posts", { count: opts.limit ?? 10, start: 0, profileUrn: profileUrn(id) });
      const feed = (bag.env.data?.data as { feedDashProfileUpdatesByMemberShareFeed?: { "*elements"?: string[] } } | undefined)?.feedDashProfileUpdatesByMemberShareFeed;
      const posts = (feed?.["*elements"] ?? []).map((u) => bag.get(u)).filter((u): u is Included => !!u).map((u) => post(bag, u));
      return { posts };
    },

    // The inbox as the messaging page lists it; reading it marks nothing seen.
    async getInbox(opts: { limit?: number } = {}): Promise<{ conversations: Conversation[] }> {
      const box = await mailbox();
      const bag = await graphql("inbox", { mailboxUrn: box, category: "INBOX", count: opts.limit ?? 20 });
      const list = (bag.env.data?.data as { messengerConversationsByCategory?: { "*elements"?: string[] } } | undefined)?.messengerConversationsByCategory;
      const conversations = (list?.["*elements"] ?? []).map((u) => bag.get(u)).filter((c): c is Included => !!c).map((c) => conversation(bag, c, myId));
      return { conversations };
    },

    // One conversation's messages, newest first; nothing is marked read.
    async getConversation(conversationId: string, opts: { limit?: number } = {}): Promise<Thread> {
      const id = threadOf(conversationId);
      const box = await mailbox();
      const urn = `urn:li:msg_conversation:(${box},${id})`;
      const bag = await graphql("messages", { conversationUrn: urn, deliveredAt: Date.now(), countBefore: opts.limit ?? 20, countAfter: 0 });
      const page = (bag.env.data?.data as { messengerMessagesByAnchorTimestamp?: { "*elements"?: string[] } } | undefined)?.messengerMessagesByAnchorTimestamp;
      const raw = (page?.["*elements"] ?? []).map((u) => bag.get(u)).filter((m): m is Included => !!m);
      raw.sort((a, b) => ((b.deliveredAt as number) ?? 0) - ((a.deliveredAt as number) ?? 0));
      // This query answers with a conversation stub, so the people in the
      // thread are whoever sent something in the page.
      const senders = new Set(raw.map((m) => m["*sender"] as string).filter(Boolean));
      const participants = [...senders].map((u) => participant(bag, u)).filter((p) => p.id !== myId);
      return { id, url: `${ORIGIN}/messaging/thread/${id}/`, participants, messages: raw.map((m) => message(bag, m)) };
    },

    // ----- writes: drafts until approved -----
    // The approved paths post what the web app's bundles post for the same
    // actions; they were read from the bundles, not exercised, since sending
    // from the owner's account is not a test.
    // conversationId: a thread from getInbox; to: a member's public id or
    // profile url (their existing conversation is used, or a new one starts).
    sendMessage(opts: { conversationId?: string; to?: string; text: string; approved?: boolean }) {
      const thread = opts.conversationId ? threadOf(opts.conversationId) : "";
      const recipient = opts.to ? memberIdentity(opts.to) : "";
      if (!thread && !recipient) throw new Error("sendMessage needs a conversationId or a recipient in to");
      if (!opts.text.trim()) throw new Error("sendMessage needs text");
      return draftOrSend({
        site: SITE,
        action: "message",
        to: thread ? `conversation ${thread}` : recipient,
        text: opts.text,
        approved: opts.approved,
        send: async () => {
          const box = await mailbox();
          let conversationUrn = thread ? `urn:li:msg_conversation:(${box},${thread})` : "";
          let recipientUrn = "";
          if (!thread) {
            recipientUrn = profileUrn(idOf((await profileByIdentity(recipient)).raw.entityUrn, "fsd_profile"));
            conversationUrn = await conversationWith(recipientUrn);
          }
          // The app's sendMessageToConversationAPI / sendFirstMessageToRecipientsAPI bodies.
          const body = {
            message: { body: { attributes: [], text: opts.text }, renderContentUnions: [], originToken: uuid(), ...(conversationUrn ? { conversationUrn } : {}) },
            mailboxUrn: box,
            trackingId: uuid().replace(/-/g, "").slice(0, 16),
            dedupeByClientGeneratedToken: false,
            ...(conversationUrn ? {} : { hostRecipientUrns: [recipientUrn] }),
          };
          const reply = (await send("/voyagerMessagingDashMessengerMessages?action=createMessage", body)) as { value?: { entityUrn?: string; backendUrn?: string; backendConversationUrn?: string } };
          const sent = reply.value ?? {};
          return { conversationId: threadId(sent.entityUrn) || idOf(sent.backendConversationUrn, "messagingThread") || thread, messageId: idOf(sent.backendUrn, "messagingMessage") };
        },
      });
    },

    // note: at most 300 characters, and LinkedIn drops it for accounts
    // without Premium.
    sendInvitation(publicIdOrUrl: string, opts: { note?: string; approved?: boolean } = {}) {
      const identity = memberIdentity(publicIdOrUrl);
      const note = opts.note?.trim() ?? "";
      if (note.length > NOTE_MAX) throw new Error(`an invitation note is at most ${NOTE_MAX} characters (this one is ${note.length})`);
      return draftOrSend({
        site: SITE,
        action: "invitation",
        to: identity,
        text: note ? `connect with ${identity}: ${note}` : `connect with ${identity} (no note)`,
        approved: opts.approved,
        send: async () => {
          const { raw } = await profileByIdentity(identity);
          const urn = profileUrn(idOf(raw.entityUrn, "fsd_profile"));
          // The app's verifyQuotaAndCreateDashRequestV2 body.
          await send("/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2", { invitee: { inviteeUnion: { memberProfile: urn } }, recipe: "com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee", ...(note ? { customMessage: note } : {}) });
          return { invited: identity, id: idOf(urn, "fsd_profile") };
        },
      });
    },
  };
}

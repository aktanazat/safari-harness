import { expect, test } from "bun:test";
import { classifyPage, withPageState, type PageFacts, type PageKind } from "./page-state.ts";

const articleText = "Publishers offer different ways to read their work, and the choice is not always a subscription. This article explains how sign-in prompts, cookie consent, region restrictions, and payment notices affect readers without asking the reader to complete any of those steps. A phrase such as Subscribe to continue reading can be quoted in reporting without becoming a barrier on the reporting itself.";
const article = { url: "https://news.example/technology/access", title: "How publishers control access", text: `How publishers control access\n\n${articleText}` };

const fixtures: { name: string; facts: PageFacts; kind: PageKind }[] = [
  {
    name: "an email-first account sign-in form",
    facts: { url: "https://accounts.example/signin/identifier", title: "Sign in - Example Accounts", text: 'h1 "Sign in"\nUse your account\n[1] textbox "Email or phone"\n[2] button "Next"\n[3] link "Create account"' },
    kind: "login_wall",
  },
  {
    name: "a full-page password sign-in flow",
    facts: { url: "https://accounts.example/login", title: "Log in | Example", text: "Log in\nEmail address\nPassword\nLog in\nForgot password?\nCreate an account" },
    kind: "login_wall",
  },
  {
    name: "an extracted sign-in form with inline labels",
    facts: { url: "https://accounts.example/login", title: "Account", text: "Sign in to continue\nEmailPasswordSign in", controls: [{ role: "textbox", label: "Email" }, { role: "textbox", label: "Password" }, { role: "button", label: "Sign in" }] },
    kind: "login_wall",
  },
  {
    name: "an explicit sign-in-to-read gate",
    facts: { url: "https://news.example/story", title: "The morning report", text: 'h1 "Sign in to continue reading"\n[1] button "Sign in"\n[2] link "Create account"' },
    kind: "login_wall",
  },
  {
    name: "a subscriber-only article gate",
    facts: { url: "https://news.example/story", title: "The morning report", text: 'h1 "Subscribe to continue reading"\nThis article is available to subscribers.\n[1] button "Subscribe now"\n[2] link "Already a subscriber? Sign in"' },
    kind: "paywall",
  },
  {
    name: "an exhausted free-article allowance",
    facts: { url: "https://news.example/story", title: "The morning report", text: "You’ve reached your free article limit\nSubscribe now\nAlready a subscriber? Sign in" },
    kind: "paywall",
  },
  {
    name: "a geographic content restriction",
    facts: { url: "https://video.example/watch", title: "Content unavailable", text: "Sorry, this content is not available in your region.\nContact support" },
    kind: "region_block",
  },
  {
    name: "a regional refusal with a forbidden HTTP response",
    facts: { url: "https://video.example/watch", title: "Content unavailable", status: 403, text: "This video is not available in your country." },
    kind: "region_block",
  },
  {
    name: "a full-page Google-shaped cookie choice",
    facts: { url: "https://consent.example/", title: "Before you continue", text: "Before you continue to Example\nWe use cookies and data to deliver and maintain our services, track outages and protect against spam, fraud and abuse.\nReject all\nAccept all\nMore options\nPrivacy Policy\nTerms of Service" },
    kind: "consent",
  },
  {
    name: "an extracted consent wall with adjacent buttons",
    facts: { url: "https://consent.example/", title: "Choice", text: "Before you continue\n\nWe use cookies. Accept all cookies or reject optional cookies to continue.\n\nAccept all cookiesReject optional cookies", controls: [{ role: "button", label: "Accept all cookies" }, { role: "button", label: "Reject optional cookies" }] },
    kind: "consent",
  },
  {
    name: "a cookie choice dialog above a readable article",
    facts: { ...article, text: `h1 "How publishers control access"\n${articleText}\ndialog "We value your privacy"\n  We use cookies to remember your choices.\n  [1] button "Accept all"\n  [2] button "Reject all"\n  [3] button "Manage preferences"` },
    kind: "consent",
  },
  {
    name: "a real page-not-found response",
    facts: { url: "https://news.example/missing", title: "404 - Not Found", text: 'h1 "Page not found"\nThe page you requested does not exist.\n[1] link "Return home"' },
    kind: "error",
  },
  {
    name: "GitHub's not-found page as a snapshot: a search box under a title that says so",
    facts: { url: "https://github.com/nobody-here/nope", title: "Page not found · GitHub", text: '[1] link "Skip to content"\nbanner "Global navigation menu"\n  [2] button "Open menu"\nmain\n  img "404 “This is not the web page you are looking for”"\n  [3] label "Find code, projects, and people on GitHub:"\n  [4] textbox "Find code, projects, and people on GitHub:"\n  [5] button "Search"\n  [6] link "Contact Support" https://support.github.com/?tags=dotcom-404\ncontentinfo\n  h2 "Footer"\n  © 2026 GitHub, Inc.' },
    kind: "error",
  },
  {
    name: "MDN's not-found page as extract reads it, menus and a copyright line included",
    facts: { url: "https://developer.mozilla.org/en-US/docs/nope", title: "Page not found | MDN", text: "HTML\n\nCSS\n\nJS\n\nWeb APIs\n\nPage not found\n\nGo back to the home page\n\nYour blueprint for a better internet.\n\nMDN\nAbout\nBlog\nMozilla careers\n\nPortions of this content are ©1998–2026 by individual mozilla.org contributors. Content available under a Creative Commons license." },
    kind: "error",
  },
  {
    name: "Safari's failed-open page without readable body text",
    facts: { url: "https://offline.example/", title: "Failed to open page" },
    kind: "error",
  },
  {
    name: "a server failure with no readable body",
    facts: { url: "https://news.example/", title: "", status: 503 },
    kind: "error",
  },
  {
    name: "legal unavailability without evidence of geography",
    facts: { url: "https://news.example/", title: "Unavailable for legal reasons", status: 451 },
    kind: "error",
  },
  {
    name: "a known authentication response",
    facts: { url: "https://accounts.example/", title: "", status: 401 },
    kind: "login_wall",
  },
  {
    name: "a known payment-required response",
    facts: { url: "https://news.example/", title: "", status: 402 },
    kind: "paywall",
  },
  {
    name: "a spinner-only read",
    facts: { url: "https://app.example/", title: "App", text: "Loading..." },
    kind: "loading",
  },
  {
    name: "an explicit partly loading extraction",
    facts: { ...article, loading: true },
    kind: "loading",
  },
  {
    name: "a sign-in redirect interstitial",
    facts: { url: "https://accounts.example/sso", title: "Signing In", text: "Signing In…" },
    kind: "loading",
  },
  {
    name: "a read that returned no text after loading finished",
    facts: { url: "https://app.example/", title: "App", text: " \n\u200b ", ready: "complete" },
    kind: "empty",
  },
  {
    name: "a blank snapshot outline",
    facts: { url: "about:blank", title: "", text: "(0 nodes)" },
    kind: "empty",
  },
  {
    name: "a body that has not been read yet",
    facts: { url: "https://news.example/story", title: "A promising headline" },
    kind: "unjudged",
  },
  {
    name: "a title that says sign in without a body read",
    facts: { url: "https://accounts.example/login", title: "Sign in" },
    kind: "unjudged",
  },
  {
    name: "an empty selected region rather than an empty page",
    facts: { ...article, text: "", partial: true },
    kind: "unjudged",
  },
  {
    name: "a truncated read of a possible gate",
    facts: { url: "https://news.example/story", title: "Sign in", text: "Sign in\nEmail address", truncated: true },
    kind: "unjudged",
  },
  {
    name: "a snapshot diff with no change",
    facts: { ...article, text: "(no change)" },
    kind: "unjudged",
  },
  {
    name: "a lone ambiguous sign-in label",
    facts: { url: "https://news.example/", title: "News", text: "Sign in" },
    kind: "unjudged",
  },
  {
    name: "unrendered fetched HTML instead of a page read",
    facts: { ...article, text: "<!doctype html><html><body><h1>Sign in</h1></body></html>", contentType: "text/html; charset=utf-8" },
    kind: "unjudged",
  },
  {
    name: "a successful JSON response instead of rendered content",
    facts: { ...article, text: '{"message":"Sign in"}', contentType: "application/json" },
    kind: "unjudged",
  },
  {
    name: "a normal article discussing access restrictions",
    facts: article,
    kind: "content",
  },
  {
    name: "an article with an exact paywall phrase as its heading",
    facts: { ...article, title: "Subscribe to continue reading", text: `h1 "Subscribe to continue reading"\n${articleText}\n[1] button "Subscribe"` },
    kind: "content",
  },
  {
    name: "a short article with sign-in controls in its sidebar",
    facts: { ...article, text: 'h1 "How publishers control access"\nReaders can sign in to save a story about privacy.\nform "Sign in"\n  [1] textbox "Email"\n  [2] textbox "Password"\n  [3] button "Sign in"' },
    kind: "content",
  },
  {
    name: "a short article beside a non-blocking cookie banner",
    facts: { ...article, text: 'h1 "How publishers control access"\nReaders can choose whether to allow tracking.\nh2 "We value your privacy"\nWe use cookies.\n[1] button "Accept all"\n[2] button "Reject all"', controls: [{ role: "button", label: "Accept all" }, { role: "button", label: "Reject all" }] },
    kind: "content",
  },
  {
    name: "an article quoting a country restriction",
    facts: { ...article, title: "This content is not available in your region", text: `This content is not available in your region\n${articleText}` },
    kind: "content",
  },
  {
    name: "an article about an outage rather than an error page",
    facts: { ...article, title: "Something went wrong", text: `Something went wrong\n${articleText}` },
    kind: "content",
  },
  {
    name: "a short page whose title names 404 inside a longer phrase",
    facts: { url: "https://docs.example/errors/404", title: "Fixing 404 errors | Example Docs", text: 'h1 "Fixing 404 errors"\nCheck the address first.\n[1] link "Next: redirects"' },
    kind: "content",
  },
  {
    name: "a question page titled with the error it asks about",
    facts: { url: "https://qa.example/questions/1/nginx-404", title: "nginx - 404 Not Found - Q&A", text: "nginx - 404 Not Found\n\nI set up nginx in front of my app, and every request to /api answers 404 Not Found although the app itself answers. What is wrong with my location block?\n\n[1] button \"Answer\"" },
    kind: "content",
  },
  {
    name: "a loading-related headline beside real content",
    facts: { ...article, title: "Please wait", text: `h1 "Please wait"\n${articleText}`, ready: "loading" },
    kind: "content",
  },
  {
    name: "an article with an embedded unsolved bot-check box",
    facts: { ...article, challenge: { kind: "recaptcha", where: "box" } },
    kind: "content",
  },
  {
    name: "a whole-page bot check is not called readable content",
    facts: { url: "https://news.example/", title: "Just a moment...", text: "Checking your browser", challenge: { kind: "cloudflare", where: "page" } },
    kind: "unjudged",
  },
];

test.each(fixtures.map(({ name, ...fixture }) => [name, fixture] as const))("%s has an honest page state", (_name, { facts, kind }) => {
  expect(classifyPage(facts)).toMatchObject({ kind, next: expect.stringMatching(/\S/) });
});

test("a whole-page bot check points to the user rather than offering a solver or a bypass", () => {
  expect(classifyPage({ url: "https://news.example/", title: "Check", challenge: { kind: "other", where: "page" } })).toMatchObject({ kind: "unjudged", next: expect.stringMatching(/handoff.*rather than solving/i) });
});

test("a browser block does not pretend a human can clear it", () => {
  expect(classifyPage({ url: "https://news.example/", title: "Blocked", challenge: { kind: "cloudflare", where: "block" } })).toMatchObject({ kind: "error", next: expect.stringMatching(/report the block.*do not bypass/i) });
});

test.each(["open", "goto", "info"])("%s with only an address and title stays unjudged", (tool) => {
  expect(withPageState(tool, { id: 7, url: article.url, title: article.title })).toMatchObject({ id: 7, url: article.url, title: article.title, pageState: { kind: "unjudged" } });
});

test.each(["snapshot", "extract"])("%s decorates a complete read without changing its content", (tool) => {
  const page = { url: article.url, title: article.title, [tool === "snapshot" ? "snapshot" : "text"]: article.text };
  expect(withPageState(tool, page)).toMatchObject({ ...page, pageState: { kind: "content" } });
});

test("a caller's partial-read scope does not turn an empty query match into an empty page", () => {
  expect(withPageState("extract", { ...article, text: "" }, { partial: true })).toMatchObject({ pageState: { kind: "unjudged" } });
});

test("an HTTP error remains visible even when its body read was partial", () => {
  expect(withPageState("fetch", { url: article.url, status: 503, type: "text/html", text: "" }, { partial: true })).toMatchObject({ status: 503, text: "", pageState: { kind: "error" } });
});

test("an action's requested after-page read receives its own state without relabeling the action receipt", () => {
  expect(withPageState("click", { ok: true, effect: { added: 1 }, page: { ...article, loading: true } })).toMatchObject({ ok: true, effect: { added: 1 }, page: { pageState: { kind: "loading" } } });
});

test("map and follow preserve an already judged partial child through nested listing results", () => {
  const pageState = { kind: "unjudged", next: "read the whole page." };
  const result = withPageState("map", { pages: [{ url: "https://news.example/", title: "News", ok: true, items: [{ url: article.url, title: article.title, ok: true, value: { ...article, text: "", pageState } }] }] });
  expect(result).toMatchObject({ pages: [{ pageState: { kind: "unjudged" }, items: [{ pageState, value: { text: "", pageState } }] }] });
});

test("a mapped readable value supplies the page state without treating arbitrary eval results as page bodies", () => {
  const evalResult = { result: { text: "Sign in", url: "https://accounts.example/login", title: "Sign in" } };
  expect(withPageState("map", { pages: [{ url: article.url, ok: true, value: article }, { url: article.url, ok: true, value: evalResult }] })).toMatchObject({ pages: [{ pageState: { kind: "content" }, value: { pageState: { kind: "content" } } }, { pageState: { kind: "unjudged" }, value: evalResult }] });
  expect(evalResult.result).not.toHaveProperty("pageState");
});

test("run decorates reads according to each step's tool and leaves eval data alone", () => {
  const evalData = { text: "Sign in", url: "https://accounts.example/login", title: "Sign in", page: article };
  const result = withPageState("run", { steps: [{ step: 1, tool: "open", value: { id: 7, url: article.url, title: article.title } }, { step: 2, tool: "extract", value: article }, { step: 3, tool: "eval", value: evalData }] });
  expect(result).toMatchObject({ steps: [{ value: { pageState: { kind: "unjudged" } } }, { value: { pageState: { kind: "content" } } }, { value: evalData }] });
  expect(evalData).not.toHaveProperty("pageState");
  expect(evalData.page).not.toHaveProperty("pageState");
});


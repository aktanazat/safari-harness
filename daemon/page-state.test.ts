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
    name: "a JSON answer that asks for a sign-in",
    facts: { ...article, text: '{"ok":false,"requiresLogin":true}', contentType: "application/json" },
    kind: "login_wall",
  },
  {
    name: "a GraphQL answer with data beside a partial error",
    facts: { ...article, text: '{"data":{"user":{"name":"Ada"}},"errors":[{"message":"field x failed"}]}', contentType: "application/json" },
    kind: "content",
  },
  {
    name: "a JSON list with no items beside its pager counts",
    facts: { ...article, text: '{"items":[],"total":0,"page":1}', contentType: "application/json" },
    kind: "empty",
  },
  {
    name: "a JSON record with an empty list beside its own fields",
    facts: { ...article, text: '{"tags":[],"name":"x"}', contentType: "application/json" },
    kind: "content",
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

// Pages as agents' reads met them between 11-09 and 11-16 (the audit of
// 11-16; each name ends with the call that read it), with the state each
// should have had: walls and pages still loading were judged content and
// counted as read. A real article, a page not found, and a short robots.txt
// keep their state.
const audited: { name: string; facts: PageFacts; kind: PageKind }[] = [
  {
    name: "ServiceNow's docs before their app loads, saved by map (LOCK#1312)",
    facts: { url: "https://www.servicenow.com/docs/", title: "Docs | ServiceNow", text: "Loading application...\n\niframe:\nready" },
    kind: "loading",
  },
  {
    name: "Slack's interstitial on the way to its app, the workspace's name changed (LOCK#563)",
    facts: { url: "https://acme.slack.com/archives/C0000000000/p1787602975173769", title: "Redirecting… | Slack", text: "Launching Acme\n\nYou will be redirected in a few moments.\nYou can also open this link in your browser." },
    kind: "loading",
  },
  {
    name: "Type Network's font page with its styles still loading (BERK#185)",
    facts: { url: "https://store.typenetwork.com/foundry/djr/fonts/input-mono", title: "Input · DJR · Buy Fonts · DJR · Buy Fonts · Type Network", text: "Fonts Stories\nShow filters\n\nLoading styles...\nAbout Type Network Help and Support\n\n© Copyright Type Network 2026. All Rights Reserved." },
    kind: "loading",
  },
  {
    name: "SAP's sign-in page, whose field no rule knew (LOCK#1284)",
    facts: { url: "https://accounts.sap.com/oauth2/authorize?client_id=a25bb10e-9f04-4def-8bb7-75fce5390b8c&response_type=code&scope=email+openid+profile", title: "SAP Business Accelerator Hub: Sign In", text: "Sign In\nSAP Business Accelerator Hub\nEmail, User ID or Login Name\n\nDon't have a SAP ID?\nRegister\n\nContinue" },
    kind: "login_wall",
  },
  {
    name: "RapidAPI's sign-in page (LOCK#1865)",
    facts: { url: "https://rapidapi.com/auth/login?referral=%2Fuser%2Fherosapi", title: "API Hub", text: "Log in to your account\nLogin with Github\nLogin with Google\nBy pressing the button you agree to our Terms of Service and to our Privacy Policy, and you certify that the information provided is complete and correct.\nor\nEmail\nPassword*\nForgot Password\nLog in\n\nDon't have an account? Sign Up\n\nHaving trouble? Contact support" },
    kind: "login_wall",
  },
  {
    name: "Exa's sign-in page beside a JSON sample (LOCK#1875)",
    facts: { url: "https://auth.exa.ai/?callbackUrl=https%3A%2F%2Fdashboard.exa.ai%2Fbilling", title: "Exa Login", text: "Start building with Exa\n\nSign in, or create a free account in seconds.\n\nContinue with Google\nOR\nContinue with email\n\nBy using Exa, you agree to Exa's Terms of Service and Privacy Policy.\n\nSign in with SSO\n\nIf you are part of a team, please contact your team's administrator for an invite link.\n\nresults = exa.search(\n\"recent breakthroughs in nuclear fusion\"\n)\n{\n\"results\": [\n{\n\"id\": \"https://interestingengineering.com/energy/chinese-tokamak-achieves-hydrogen-boron-fusion-with-100-million-reactions-a-second\",\n\"title\": \"China reaches 100 million hydrogen-boron fusion reactions per second\",\n\"url\": \"https://interestingengineering.com/energy/chinese-tokamak-achieves-hydrogen-boron-fusion-with-100-million-reactions-a-second\",\n\"publishedDate\": \"2026-09-30T01:02:51.000Z\",\n\"author\": \"Georgina Jedikovska\"\n},\n{\n\"id\": \"https://energyinnovationreview.com/2026/09/24/diii-d-fusion-team-cracks-the-heat-wall-puzzle/\",\n\"title\": \"DIII-D fusion team cracks the heat-wall puzzle - Energy Innovation Review\",\n\"url\": \"https://energyinnovationreview.com/2026/09/24/diii-d-fusion-team-cracks-the-heat-wall-puzzle/\",\n\"publishedDate\": \"2026-09-24T00:00:00.000Z\",\n\"author\": \"Isaac Turner\"\n}\n]\n}" },
    kind: "login_wall",
  },
  {
    name: "Keenable's sign-in page with only provider buttons (LOCK#1876)",
    facts: { url: "https://app.keenable.ai/login?redirect=%2Fconsole%2Foverview", title: "Console | Keenable", text: "Search\nfor AI agents\n\nLog in to Keenable\n\nUse the same method you signed up with.\n\nContinue with Google\nContinue with GitHub\nor\nContinue with email\n\nNew to Keenable? Create an account\n\nCookie settings" },
    kind: "login_wall",
  },
  {
    name: "Tako's sign-in page (LOCK#1876)",
    facts: { url: "https://tako.com/login?redirect=%2Fconsole", title: "Tako Login", text: "Get started with Tako\nContinue with Google\n\nContinue with email\nSign in with password\n\nBy logging in, you agree to our Terms of Service and Privacy Policy." },
    kind: "login_wall",
  },
  {
    name: "Perplexity's API console sign-in page (LOCK#1877)",
    facts: { url: "https://console.perplexity.ai/auth/login?redirectUrl=%2Fproject%2Fbilling", title: "API Platform", text: "API Platform\n\nLogin or sign up for free\n\nContinue with Google\nContinue with Apple\nSingle sign-on (SSO)\nContinue with email" },
    kind: "login_wall",
  },
  {
    name: "You.com's sign-in page (LOCK#1877)",
    facts: { url: "https://you.com/signin?redirectUrl=%2Fplatform%2Fbilling", title: "You.com | Search and inference for AI", text: "Sign in\n\nContinue\n\nor\n\nSign in with Google\n\nContinue with Github\n\nContinue with Apple\n\nContinue with Single Sign-On\n\nBy using you.com, you agree to our Terms & Privacy Policy" },
    kind: "login_wall",
  },
  {
    name: "UKG's firewall rate limit, the address it named changed (LOCK#1363)",
    facts: { url: "https://developer.ukg.com/wfm/reference/retrieve-timecards-as-employee", title: "You’ve been rate limited", text: "You’ve been rate limited\n\nYour requests have been rate limited by our firewall! This should almost never happen, so email our support and we can help out.\n\nYour IP: 2001:db8::1\nRay ID: a59b46288e1c7c8f" },
    kind: "error",
  },
  {
    name: "Harvard's firewall under heavy load (RSI#747)",
    facts: { url: "https://dash.harvard.edu/bitstreams/7312037c-eb3a-6bd4-e053-0100007fdf3b/download", title: "", text: "WEB FIREWALL · 429\nThe service is under heavy load\n\nOur protection has temporarily kicked in, so this request could not be served right now.\n\nTo reach the resource, you can:\n\nLog in, then open the item again, or\ngo back to the home page and search for the item from there, without opening a new tab.\n\nPlease avoid reloading this page repeatedly: it keeps the protection active." },
    kind: "error",
  },
  {
    name: "Oxford Academic's offer of an article with no abstract (RSI#869)",
    facts: { url: "https://academic.oup.com/ajcl/article-abstract/51/1/163/2571697", title: "Transplant Effect | The American Journal of Comparative Law | Oxford Academic", text: "Article Navigation\nJOURNAL ARTICLE\nThe Transplant Effect Get access\nDaniel Berkowitz , Katharina Pistor , Jean-Francois Richard\nThe American Journal of Comparative Law, Volume 51, Issue 1, Winter 2003, Pages 163–204, https://doi.org/10.2307/3649143\nPublished: 01 January 2003\nCite\nPermissions\nArticle PDF first page preview\n\nThis content is only available as a PDF.\n© 2003 by The American Society of Comparative Law, Inc.\nIssue Section: Articles\nYou do not currently have access to this article.\nSign in\nGet help with access\nPersonal account\nSign in with email/username & password\nGet email alerts\nSave searches\nPurchase content\nActivate your purchase/trial code\nAdd your ORCID iD\nSign in\nRegister\nInstitutional access\nSign in through your institution\nSign in through your institution\nSign in with a library card\nSign in with username/password\nRecommend to your librarian\nInstitutional account management\nSign in as administrator\nPurchase\nSubscription prices and ordering for this journal\nPurchasing options for books and journals across Oxford Academic\nShort-term Access\n\nTo purchase short-term access, please sign in to your personal account above.\n\nDon't already have a personal account? Register\n\nThe Transplant Effect - 24 Hours access\nEUR €39.00 GBP £33.00 USD $43.00\nRental\n\nThis article is also available for rental through DeepDyve." },
    kind: "paywall",
  },
  {
    name: "The Lancet's abstract beside its Get Access button, as far as the read kept it (RSI#829)",
    facts: { url: "https://www.thelancet.com/journals/lancet/article/PIIS0140-6736(96)05122-7/abstract", title: "The discrepancy in discrepant analysis - The Lancet", text: "ARTICLESVolume 348, Issue 9027P592-593August 31, 1996\n\nDownload Full Issue\nThe discrepancy in discrepant analysis\nAlula Hadgu, DPha\nAffiliations & Notes\n\na\n\nCenters for Disease Control and Prevention, Center for HIV, STD, and TB prevention, Division of STD Prevention, 1600 Clifton Road, Mailstop E63, Atlanta, GA 30333\n\nArticle Info\n\nPublication History:\n\nPublished August 31, 1996\n\nDOI: 10.1016/S0140-6736(96)05122-7\n\nAlso available on ScienceDirect\n\nCopyright: © 1996 Elsevier Ltd. Published by Elsevier Ltd.\n\nGet Access\nOutline\n\nShare\nMore\nSummary\nDiscrepant analysis is a widely used technique that attempts to provide estimates of sensitivity and specificity in the presence of an imperfect gold-standard. This technique has been applied by many researchers to estimate the sensitivity and specificity of DNA-amplification tests for Chlamydia trachomatis such as the plasmid-based ligase chain-reaction and polymerase chain-reaction tests. However, the sensitivity and specificity estimates obtained by discrepant analysis are upwardly biased, and this bias remains even when a perfect test is used to resolve the discrepant results. " },
    kind: "content",
  },
  {
    name: "dokumen.tips's 199-character robots.txt (LOCK#1715, #1719)",
    facts: { url: "https://dokumen.tips/robots.txt", title: "", text: "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n\nSitemap: https://dokumen.tips/wp-sitemap.xml\n\nSitemap: https://dokumen.tips/sitemap.xml\nSitemap: https://dokumen.tips/sitemap.html\n" },
    kind: "content",
  },
  {
    name: "Grilli Type's page not found (BERK#185)",
    facts: { url: "https://www.grillitype.com/typeface/gt-america/buy", title: "GT – 404 Page Not Found", text: "Grilli Type\nMenuClose\nTypefaces\nFree Trials\nCommissions\nBlog\nInformation\nAbout\nLogin\nSorry, we couldn’t find the page you were looking for.\nInformation\nAbout us\nCustom fonts\nRetail fonts\nLicensing\nPayment\nFree trial fonts\nFonts in use\nPrivacy Policy\nContact\nEmail\nInstagram\nTwitter\nFacebook\nNewsletter\nTypefaces\nGT Mechanik\nGT Canon\nGT Era\nGT Standard\nGT Flaire\nGT Pantheon\nGT America Intl\nGT Pressura\nGT Planar\nGT Ultra\nGT Maru\nGT Flexa\nGT Alpina\nGT Zirkon\nGT Super\nGT Walsheim\nGT America\nGT Eesti\nGT Cinetype\nGT Haptik\nGT Sectra\nAbout us\nGrilli Type\noffers original retail and custom typefaces with a contemporary aesthetic in the Swiss tradition." },
    kind: "error",
  },
  {
    name: "a host's 503 page in place of a robots.txt (LOCK#1717)",
    facts: { url: "https://ukgdocs.sisaacson.io/robots.txt", title: "Site not available", text: "503 Service Unavailable\n\nThis site is not available at the moment\n\nukgdocs.sisaacson.io cannot answer your request right now. Please try again later.\n\nAre you the site owner?\nThe domain is not configured on a resource in Coolify, or its DNS points to another server.\nThe application is stopped, still deploying, or has crashed.\nThe application health check is failing.\nRead the troubleshooting guide" },
    kind: "error",
  },
  {
    name: "a reference page about a status code, headed by it",
    facts: { url: "https://docs.example/http/status/503", title: "503 Service Unavailable - HTTP | Example Docs", text: `h1 "503 Service Unavailable"\n${articleText}` },
    kind: "content",
  },
  {
    name: "a help article on an accounts host",
    facts: { ...article, url: "https://accounts.example/help/recover", title: "Recovering your account" },
    kind: "content",
  },
  {
    name: "a short article on a sign-in path that names signing in",
    facts: { url: "https://docs.example/auth/login", title: "Login | Example Docs", text: `h1 "Login"\n${articleText}\n[1] button "Continue"` },
    kind: "content",
  },
  // False positives the pre-ship review of these rules reproduced.
  {
    name: "a coming-soon page that says it is launching",
    facts: { url: "https://acme.example/", title: "Acme", text: "Acme\nLaunching soon\nThe calendar that plans itself.\nJoin the waitlist" },
    kind: "content",
  },
  {
    name: "a page that names the year it launches",
    facts: { url: "https://acme.example/", title: "Acme", text: "Acme\nLaunching 2027\nContact" },
    kind: "content",
  },
  {
    name: "a leaving-our-site page that asks before it redirects",
    facts: { url: "https://bank.example/leaving?to=https%3A%2F%2Fpartner.example%2F", title: "Leaving our site", text: "You will be redirected to a third-party website…\nContinue\nCancel" },
    kind: "content",
  },
  {
    name: "a short docs page on signing in, with a nav sign-in link and a Continue button",
    facts: { url: "https://docs.example.com/guides/auth", title: "Authentication | Acme Docs", text: 'navigation\n  [1] link "Docs"\n  [2] link "Sign in"\nh1 "Authentication"\nUse an API key or OAuth.\nSee the token guide.\n[3] button "Continue"' },
    kind: "content",
  },
  {
    name: "an API reference page on its login call, judged by its title alone as map judges an eval's page",
    facts: { url: "https://docs.example.com/reference/login", title: "Login - API Reference", text: "Login - API Reference" },
    kind: "content",
  },
];

test.each(audited.map(({ name, ...fixture }) => [name, fixture] as const))("%s has the state it should have had", (_name, { facts, kind }) => {
  expect(classifyPage(facts)).toMatchObject({ kind, next: expect.stringMatching(/\S/) });
});

test("a page that says the site rate-limited this browser says to wait before reading it again", () => {
  const ukg = audited.find((fixture) => fixture.name.includes("LOCK#1363"));
  expect(ukg && classifyPage(ukg.facts)).toEqual({ kind: "error", next: "the site rate-limited this browser; wait a few minutes before reading it again, then read its pages one at a time." });
  expect(classifyPage({ url: "https://api.example/", title: "", status: 429 }).next).toStartWith("the site rate-limited this browser");
});

test("a browser block does not pretend a human can clear it", () => {
  expect(classifyPage({ url: "https://news.example/", title: "Blocked", challenge: { kind: "cloudflare", where: "block" } })).toMatchObject({ kind: "error", next: expect.stringMatching(/report the block.*do not bypass/i) });
});

test("a consent wall's next step names its reject choice by ref, leaving the choice to the user", () => {
  const text = 'main\n  h1 "Morning briefing"\ndialog "We value your privacy"\n  We use cookies to remember your choices.\n  [1] button "Accept all"\n  [2] button "Reject all"\n  [3] button "Manage preferences"';
  expect(classifyPage({ url: "https://news.example/", title: "News", text })).toEqual({ kind: "consent", next: 'ask the user to choose unless their consent choice is already authorized; the reject choice is [2] button "Reject all".' });
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


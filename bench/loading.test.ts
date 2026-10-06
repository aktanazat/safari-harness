import { benchRows } from "./bench.ts";

// On 10-05 Cvent's textless spinner and its next page, "Signing In", both
// answered open's loaded check before sending the tab on. Ask the real
// content script in WebKit, with no time for the page to change: an
// unfinished page must say it is still loading, not that it is ready.
benchRows("open readiness in WebKit", [
  {
    name: "a page showing only a progress indicator is still loading",
    page: "opening.html",
    steps: [{ op: "loaded", args: [0], answer: { value: { loading: true } } }],
  },
  ...[
    { name: "a page showing only a native progress indicator is still loading", html: "<progress></progress>", loading: true },
    { name: "a hidden progress indicator does not hold an otherwise empty page", html: '<div hidden><progress></progress></div>', loading: false },
    { name: "an invisible progress indicator does not hold an otherwise empty page", html: '<progress style="opacity: 0"></progress>', loading: false },
    { name: "a progress indicator inside a transparent parent does not hold the page", html: '<div style="opacity: 0"><progress></progress></div>', loading: false },
    { name: "a progress indicator inside a clipped-away parent does not hold the page", html: '<div style="width: 0; height: 0; overflow: hidden"><progress></progress></div>', loading: false },
    { name: "a blank page without a progress indicator is ready", html: "", loading: false },
    { name: "a progress indicator beside real content does not hold the page", html: "<h1>Account</h1><progress></progress>", loading: false },
    { name: "a spinner in an empty main region does not hold a page with text elsewhere", html: "<header>Account</header><main><progress></progress></main>", loading: false },
    { name: "a page showing only Signing In is still loading", html: "<h1>Signing In</h1>", loading: true },
    { name: "a page showing only Redirecting is still loading", html: "<p>Redirecting…</p>", loading: true },
    { name: "a page showing only Please wait is still loading", html: "<p>Please wait...</p>", loading: true },
    { name: "a sign-in form is ready rather than an interstitial", html: '<h1>Sign in</h1><label>Email<input></label>', loading: false },
    { name: "Signing In beside other visible words is not an interstitial", html: "<h1>Signing In</h1><p>Use your work account.</p>", loading: false },
    { name: "Signing In in main does not hold a page with text elsewhere", html: "<header>Account</header><main><h1>Signing In</h1></main>", loading: false },
  ].map(({ name, html, loading }) => ({
    name,
    page: "opening.html",
    steps: [
      { op: "eval", args: [`(document.body.innerHTML = ${JSON.stringify(html)}, true)`] },
      { op: "loaded", args: [0], answer: { value: { loading } } },
    ],
  })),
]);

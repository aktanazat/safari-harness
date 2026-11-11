import { afterAll, expect } from "bun:test";
import { basename, join } from "node:path";
import { benchRows } from "./bench.ts";

// Serves spa-shell.html and the topic its script asks for; ?ms= holds the
// topic back. The delay is real: the read under test runs on the web
// view's own clock.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/topic.json") {
      await Bun.sleep(Number(url.searchParams.get("ms") ?? 0));
      return Response.json({ title: "URLSession", abstract: "An object that coordinates a group of related network data transfer tasks." });
    }
    return new Response(Bun.file(join(import.meta.dir, "fixtures", basename(url.pathname))));
  },
});
afterAll(() => server.stop(true));

const shell = `http://127.0.0.1:${server.port}/spa-shell.html`;
const TOPIC = "An object that coordinates a group of related network data transfer tasks.";

// On 11-08 a read of Apple's developer docs came back with only their
// navigation and footer, and Zoom's API docs with "Search ⌃ L Powered by
// Scalar": both draw the page itself from data their script asks for.
benchRows("a read of a page its script draws", [
  {
    name: "extract of a page showing only its navigation and footer waits for the topic its script is still fetching",
    page: shell,
    steps: [{ op: "extract", answer: { value: { text: expect.stringContaining(TOPIC) } } }],
  },
  {
    name: "extract of a short page with nothing out answers at once",
    page: `${shell}#done`,
    steps: [{ op: "extract", timeout: 1000, answer: { value: { text: expect.stringContaining("Developer") } } }],
  },
  {
    name: "extract of a short page under its own heading answers at once, though a request is out",
    page: `${shell}?ms=15000#signin`,
    steps: [{ op: "extract", timeout: 1000, answer: { value: { text: expect.stringContaining("Use your work email.") } } }],
  },
  {
    name: "extract of a page whose topic never comes answers at its bound and says the page showed little else",
    page: `${shell}?ms=15000`,
    steps: [{ op: "extract", timeout: 8000, answer: { value: { text: expect.not.stringContaining(TOPIC), note: expect.stringContaining("little beyond") } } }],
  },
]);

benchRows("a read of sections a click opens", [
  {
    name: "extract reads closed details and collapsed panels in place, without opening them, and leaves menus, share sheets, navigation and hidden words out",
    page: "collapsed.html",
    steps: [
      {
        op: "extract",
        answer: {
          value: {
            text: "Savings rates\n\nRates change with the market and are set each Monday.\n\nFees\nShow fees\n\nWire transfer: $25.\n\nOverdraft\n\nOverdraft fee: $0 with alerts on.\n\nCertificate rates below apply to new deposits.\n\nCertificate rates\n\nTerm APY\n12 months 4.10%\n24 months 3.85%\n\nSort\nShare\nBranch hours\n\nOpen 9 to 5 on weekdays.",
            note: expect.stringContaining("3 collapsed sections"),
          },
        },
      },
      { op: "eval", args: ["[document.querySelector('details').open, document.body.dataset.toggled ?? 'none', document.getElementById('fees').hidden]"], answer: { value: { ok: true, result: [false, "none", true] } } },
    ],
  },
  {
    name: "an extract query finds a rate in a closed section",
    page: "collapsed.html",
    steps: [{ op: "extract", args: [{ query: "24 months" }], answer: { value: { text: "24 months 3.85%" } } }],
  },
]);

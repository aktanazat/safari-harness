import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type * as CallModule from "../daemon/call.ts";
import type * as RpcModule from "../daemon/rpc.ts";
import type * as EvidenceModule from "../daemon/evidence.ts";
import type * as ReplModule from "../daemon/repl.ts";

const root = process.env.SAFARI_RESEARCH_ROOT ?? join(homedir(), ".local/share/safari-harness/current");
const { invoke } = await import(join(root, "daemon/call.ts")) as typeof CallModule;
const { ownCalls, daemonHttp } = await import(join(root, "daemon/rpc.ts")) as typeof RpcModule;
ownCalls();
const headers = { "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" };
const baseline = process.argv.includes("--baseline");
const dir = await mkdtemp(join(tmpdir(), "safari-research-check-"));
const failures: string[] = [];
let checks = 0;
const tabs: number[] = [];
const ocrPaths = new Set<string>();
const sourceReceipts = new Map<string, EvidenceModule.Evidence>();
let driving = false;
let pictures = false;
const sentinels = ["FictionalMint36_XyZ", "731692", "4111111111111111", "928374", "583241"];
const encodedCode = [...sentinels[1]].map((digit) => `%${digit.charCodeAt(0).toString(16)}`).join("");
const exposesCode = (text: string) => text.includes(sentinels[1]) || text.includes(encodedCode);
function check(name: string, pass: boolean, detail?: unknown) {
  checks++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${!pass && detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`);
  if (!pass) failures.push(name);
}
const plain = `<!doctype html><html><head><title>Research fixture ${sentinels[1]}</title><style>body{font:24px system-ui;margin:32px;color:#111;background:white}input{display:block;font:24px system-ui;margin:12px 0;width:440px;height:44px}section{height:580px;border-top:3px solid #333;padding:12px}iframe{display:block;width:500px;height:100px}svg{display:block;max-width:100%;height:auto}</style></head><body><h1>PUBLIC CONTROL CHECK</h1><p>Displayed revenue: 120 USD</p><svg id="revenue-chart" width="560" height="220" viewBox="0 0 560 220" role="img" aria-label="Quarterly revenue chart"><text x="20" y="32" font-size="24">Quarterly revenue</text><path d="M20 160H500" stroke="#333"/><path d="M20 70H380V159H20Z" fill="#3464a8"/><text x="390" y="120" font-size="24">120 USD</text><text x="20" y="198" font-size="20">Reported quarter</text></svg><button id="increment" onclick="window.count++;this.textContent='Count '+window.count">Count 0</button><label>Password<input type="text" autocomplete="current-password" value="${sentinels[0]}"></label><label>Verification code<input autocomplete="one-time-code" value="${sentinels[1]}"></label><label>Card number<input autocomplete="cc-number" value="${sentinels[2]}"></label><p id="echo">${sentinels[0]}</p><div id="shadow"></div><iframe src="/inner" title="same-site code"></iframe><iframe id="opaque" title="other-site code"></iframe>${Array.from({ length: 5 }, (_, i) => `<section><h2>Coverage marker ${i + 1}</h2><p>Readable evidence stays at its original size.</p></section>`).join("")}<script>window.count=0;window.researchData={revenue:118,unit:'USD'};document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<label>Security code<input autocomplete="one-time-code" value="${sentinels[3]}"></label>';const inner=new URL('/inner',location.href);inner.hostname='localhost';document.querySelector('#opaque').src=inner.href;</script></body></html>`;
const walls: Record<string, string> = {
  "/paywall": "<h1>Subscribe to continue reading</h1><p>This article is available to subscribers only.</p><button>Subscribe now</button>",
  "/login": '<h1>Sign in to continue</h1><form><label>Email<input autocomplete="username"></label><label>Password<input type="password" autocomplete="current-password"></label><button>Sign in</button></form>',
  "/consent": '<h1>Before you continue</h1><p>We use cookies. Accept all cookies or reject optional cookies to continue.</p><button>Accept all cookies</button><button>Reject optional cookies</button>',
  "/region": "<h1>Not available in your region</h1><p>This service is not available in your country.</p>",
};
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/plain") return new Response(plain, { headers: { "content-type": "text/html" } });
  if (path === "/inner") return new Response(`<style>#offset-secret{width:1px;white-space:nowrap;font:24px system-ui}#offset-secret::before{content:"${sentinels[4]}";position:relative;left:180px}</style><label>Code<input autocomplete="one-time-code" value="${sentinels[4]}"></label><div id="offset-secret"></div>`, { headers: { "content-type": "text/html" } });
  if (walls[path]) return new Response(`<!doctype html><title>${path.slice(1)}</title>${walls[path]}`, { headers: { "content-type": "text/html" } });
  return new Response("not found", { status: 404 });
} });
const base = `http://127.0.0.1:${server.port}`;
async function open(path: string) {
  const result = await invoke("open", { url: `${base}${path}`, background: true, new: true }) as { id: number };
  tabs.push(result.id);
  return result.id;
}
async function state(tab: number, expression: string) {
  return (await invoke("eval", { tab, expression, page: true }) as { result: unknown }).result;
}
async function control(action: string) {
  let capability: { secret: string; mission?: string };
  if (baseline) {
    const page = await (await fetch(`${daemonHttp()}/agents`, { headers })).text();
    const secret = /data-secret="([^"]+)"/.exec(page)?.[1];
    if (!secret) throw new Error("mission control did not return its own control capability");
    capability = { secret };
  } else {
    const listing = await (await fetch(`${daemonHttp()}/agents.json`, { headers })).json() as { agents: { owner: number; id: string; controlSecret?: string }[] };
    const live = listing.agents.find((agent) => agent.owner === process.pid && agent.controlSecret);
    if (!live?.controlSecret) throw new Error("mission control did not return this task's control capability");
    capability = { secret: live.controlSecret, mission: live.id };
  }
  const response = await fetch(`${daemonHttp()}/agents/control`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ...capability, owner: process.pid, action }) });
  if (!response.ok) throw new Error(`mission control refused its test owner: HTTP ${response.status}`);
  return response.json();
}
async function until(ready: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  do { if (await ready()) return; await Bun.sleep(25); } while (Date.now() < deadline);
  throw new Error("the requested test state did not arrive");
}
try {
  const tab = await open(`/plain?token=FictionalSignedTokenValue&review=${encodedCode}`);
  await invoke("activate", { tab });
  await invoke("wait", { tab, selector: "#opaque", ms: 3000 });
  await state(tab, `document.querySelector('input[autocomplete="one-time-code"]').setAttribute("aria-label", ${JSON.stringify(`Verification code ${sentinels[1]}`)})`);
  const extracted = await invoke("extract", { tab }) as { controls?: { role: string; label: string }[] };
  check("a user-filled sign-in code stays out of control labels", extracted.controls?.some((control) => control.label === "Verification code ...") === true && extracted.controls.some((control) => control.role === "button" && control.label === "Count 0") && !JSON.stringify(extracted.controls).includes(sentinels[1]), extracted.controls);
  await invoke("keep_secret", { tab, texts: [sentinels[0], "2026"] });
  const beforeCapture = await state(tab, "JSON.stringify({children:[...document.documentElement.children].map(e=>e.tagName),x:scrollX,y:scrollY,focus:document.activeElement.tagName})");
  const shot = await invoke("shot", { tab, fullPage: true, ...(baseline ? {} : { tiles: true, tileHeight: 1000 }), out: join(dir, "full.png") }) as Partial<EvidenceModule.CaptureResult> & Pick<EvidenceModule.CaptureResult, "path">;
  check("captures include a saved evidence receipt", !!shot.evidence);
  const evidence = shot.evidence;
  if (evidence) {
    sourceReceipts.set("full-page", evidence);
    const manifest = JSON.parse(await readFile(evidence.path, "utf8")) as Record<string, unknown>;
    check("capture source removes signed URL values", !JSON.stringify(manifest).includes("FictionalSignedTokenValue") && !JSON.stringify(evidence).includes("FictionalSignedTokenValue"));
    check("the saved original matches its cited hash", createHash("sha256").update(await readFile(shot.path)).digest("hex") === evidence.sha256);
    check("sensitive fields, echoes and opaque frames were masked", evidence.privacy.masked >= 6, evidence.privacy);
    const pieces = evidence.tiles ?? [];
    let covered = 0;
    let continuous = pieces.length > 1;
    for (const [i, piece] of pieces.entries()) {
      continuous &&= piece.region.x === 0 && piece.region.width === evidence.width && piece.region.height <= 1000 && piece.region.y <= covered && (i === 0 || piece.region.y < covered);
      covered = Math.max(covered, piece.region.y + piece.region.height);
      continuous &&= createHash("sha256").update(await readFile(piece.path)).digest("hex") === piece.sha256;
    }
    check("overlapping pieces cover the retained original without shrinking it", continuous && covered === evidence.height, { pieces: pieces.length, covered, height: evidence.height });
    const immutable = await readFile(evidence.path, "utf8");
    const replacement = await invoke("shot", { tab, out: shot.path }) as EvidenceModule.CaptureResult;
    sourceReceipts.set("reused output", replacement.evidence);
    const { verifyEvidence } = await import(join(root, "daemon/evidence.ts")) as typeof EvidenceModule;
    const prior = await verifyEvidence(evidence.path);
    ocrPaths.add(prior.path);
    for (const piece of evidence.tiles ?? []) ocrPaths.add(piece.path);
    check("a reused output path preserves the earlier cited capture", prior.evidence.sha256 === evidence.sha256 && await readFile(evidence.path, "utf8") === immutable);
  }
  const afterCapture = await state(tab, "JSON.stringify({children:[...document.documentElement.children].map(e=>e.tagName),x:scrollX,y:scrollY,focus:document.activeElement.tagName})");
  const unchanged = await state(tab, `(() => { const inputs=[...document.querySelectorAll('input')];return inputs.map(x=>x.value).join('|')===${JSON.stringify(sentinels.slice(0, 3).join("|"))} && document.querySelector('#shadow').shadowRoot.querySelector('input').value===${JSON.stringify(sentinels[3])};})()`);
  check("capturing restores focus, scroll, field values and temporary layers", unchanged === true && beforeCapture === afterCapture);
  const otherTakeoverTab = await open("/plain");
  await invoke("info", { tab });
  await control("drive");
  driving = true;
  const queued = invoke("click", { tab, ref: "#increment" }).then(() => ({ code: "ran" }), (error: unknown) => ({ code: error && typeof error === "object" && "code" in error ? error.code : "error" }));
  await until(async () => {
    const view = await (await fetch(`${daemonHttp()}/agents.json`, { headers })).json() as { agents: { owner: number; last?: { held?: boolean } }[] };
    return view.agents.some((agent) => agent.owner === process.pid && agent.last?.held === true);
  });
  await control("giveback");
  driving = false;
  const released = await queued;
  check("a queued action needs a fresh view after giveback", released.code === "stale_view", released);
  await invoke("snapshot", { tab });
  const before = await state(tab, "window.count");
  await invoke("click", { tab, ref: "#increment" });
  check("the action works after a fresh view", typeof before === "number" && await state(tab, "window.count") === before + 1);
  const otherAttempt = await invoke("click", { tab: otherTakeoverTab, ref: "#increment" }).then(() => ({ code: "ran" }), (error: unknown) => ({ code: error && typeof error === "object" && "code" in error ? error.code : "error" }));
  check("takeover protects the other task tab too", otherAttempt.code === "stale_view", otherAttempt);
  await invoke("snapshot", { tab: otherTakeoverTab });
  const otherBefore = await state(otherTakeoverTab, "window.count");
  await invoke("click", { tab: otherTakeoverTab, ref: "#increment" });
  check("only its own fresh view releases the other tab", otherBefore === 0 && await state(otherTakeoverTab, "window.count") === 1);
  if (!baseline && evidence) {
    const expected: Record<string, string> = { "/paywall": "paywall", "/login": "login_wall", "/consent": "consent", "/region": "region_block" };
    for (const [path, kind] of Object.entries(expected)) {
      const wall = await open(path);
      const read = await invoke("extract", { tab: wall }) as { pageState?: { kind: string } };
      check(`a ${kind} is not reported as requested content`, read.pageState?.kind === kind, read.pageState);
    }
    const values = await state(tab, "window.researchData") as { revenue: number; unit: string };
    const chart = await invoke("shot", { tab, ref: "#revenue-chart", out: join(dir, "chart.png") }) as EvidenceModule.CaptureResult;
    sourceReceipts.set("chart", chart.evidence);
    ocrPaths.add(chart.path);
    const report = await invoke("report", {
      out: join(dir, "report"), title: "Safari research smoke", answer: "the displayed revenue differs from the page's published value. the subscriber-only page was not checked.",
      findings: [{ claim: "the chart displays 120 USD while its published data says 118 USD", evidence: chart.evidence.path, comparison: { visual: 120, data: values.revenue, unit: values.unit, tolerance: 0.5 } }],
      unchecked: [{ url: `${base}/paywall`, reason: "a subscriber-only wall stood in for the article" }],
    }) as { path: string; html: string; findings: number; unchecked: number; mismatches: number };
    check("the report retains evidence, the mismatch and the unread page", report.findings === 1 && report.unchecked === 1 && report.mismatches === 1, report);
    const reportFiles = await Promise.all([report.path, report.html].map((path) => readFile(path, "utf8")));
    check("both report formats protect the user-filled code in source metadata", reportFiles.every((text) => !exposesCode(text)));
    console.log(`report_html=${report.html}`);
    console.log(`report_markdown=${report.path}`);
    const learningSite = `safari-research-${crypto.randomUUID()}.invalid`;
    const fact = "Synthetic research verification note.";
    await invoke("learn", { site: learningSite, fact, source: `https://${learningSite}/check?token=FictionalSignedTokenValue` });
    const learningHistory = String(await invoke("learn", { site: learningSite, history: true }));
    const edit = /^- ([0-9a-f-]{36}) /m.exec(learningHistory)?.[1];
    try {
      check("learned facts retain a source without signed URL values", !!edit && learningHistory.includes(`https://${learningSite}/check`) && !learningHistory.includes("FictionalSignedTokenValue"));
    } finally {
      await invoke("learn", edit ? { site: learningSite, undo: edit } : { site: learningSite, forget: 1 });
    }
    const reversed = String(await invoke("learn", { site: learningSite }));
    const reversedHistory = String(await invoke("learn", { site: learningSite, history: true }));
    check("reversing a learned fact removes it and preserves its history", !reversed.includes(fact) && reversedHistory.includes("; undone "));
    const { verifyEvidence } = await import(join(root, "daemon/evidence.ts")) as typeof EvidenceModule;
    for (const [name, options] of [["viewport", {}], ["live", { live: true }], ["cropped", { ref: "#increment" }], ["annotated", { annotate: true }]] as const) {
      const capture = await invoke("shot", { tab, ...options, out: join(dir, `${name}.png`) }) as EvidenceModule.CaptureResult;
      sourceReceipts.set(name, capture.evidence);
      const verified = await verifyEvidence(capture.evidence.path);
      check(`${name} capture has verifiable protected pixels`, verified.evidence.privacy.masked > 0 && (name !== "cropped" || !!verified.evidence.crop));
      ocrPaths.add(verified.path);
    }
    const batch = await invoke("shots", { urls: [`${base}/plain`], widths: [390, 1000], out: join(dir, "batch") }) as { files: (EvidenceModule.CaptureResult | { error: string })[] };
    check("batch captures retain protected evidence at both requested widths", batch.files.length === 2 && batch.files.every((capture) => "evidence" in capture && capture.evidence.privacy.masked > 0), batch);
    for (const capture of batch.files) {
      if ("error" in capture) continue;
      sourceReceipts.set(capture.path, capture.evidence);
      const verified = await verifyEvidence(capture.evidence.path);
      ocrPaths.add(verified.path);
    }
    const { ReplSession } = await import(join(root, "daemon/repl.ts")) as typeof ReplModule;
    const session = new ReplSession("research-capture-check", { cwd: dir, invoke });
    try {
      const page = await session.attachBrowserTab(tab);
      const beforeTakeover = await state(tab, "window.count");
      await control("drive");
      driving = true;
      await control("giveback");
      driving = false;
      const stale = await page.locator("#increment").click().then(() => false, (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "stale_view");
      await session.snapshot(page);
      await page.locator("#increment").click();
      check("the REPL's default snapshot restores safe action after takeover", stale && typeof beforeTakeover === "number" && await state(tab, "window.count") === beforeTakeover + 1);
      const captured = await page.capture({ path: "repl.png" });
      const annotated = await session.annotatedScreenshot(page, { path: "repl-annotated.png" });
      const bytes = await page.screenshot({ path: "repl-buffer.png" });
      const bufferReceipt = await readFile(join(dir, "repl-buffer.png"));
      check("REPL captures preserve receipts and the existing PNG byte interface", !!captured.evidence && !!annotated.evidence && bytes.equals(bufferReceipt));
      for (const capture of [captured, annotated]) {
        sourceReceipts.set(capture.path, capture.evidence);
        ocrPaths.add((await verifyEvidence(capture.evidence.path)).path);
      }
      ocrPaths.add(join(dir, "repl-buffer.png"));
    } finally {
      await session.close();
    }
    const expression = "window.uncertainRuns=(window.uncertainRuns||0)+1;throw new Error('fictional result lost after action')";
    const first = await invoke("eval", { tab, expression, page: true }).then(() => undefined, (error: unknown) => error);
    const second = await invoke("eval", { tab, expression, page: true }).then(() => undefined, (error: unknown) => error);
    check("an uncertain action is marked unsafe to retry", !!first && typeof first === "object" && "effect" in first && first.effect === "possibly_effected");
    check("an uncertain identical action is blocked before dispatch", !!second && typeof second === "object" && "code" in second && second.code === "effect_unknown");
    await invoke("snapshot", { tab });
    check("the uncertain action happened only once", await state(tab, "window.uncertainRuns") === 1);
    const invalid = await invoke("click", { tab }).then(() => undefined, (error: unknown) => error);
    check("argument failures state that no action happened", !!invalid && typeof invalid === "object" && "code" in invalid && invalid.code === "invalid_argument" && "effect" in invalid && invalid.effect === "none");
    const nativeBefore = await state(tab, "window.count");
    await control("pictures_on");
    pictures = true;
    await invoke("real_input", { tab, do: "click", ref: "#increment" });
    await control("pictures_off");
    pictures = false;
    check("trusted native input still acts exactly once", typeof nativeBefore === "number" && await state(tab, "window.count") === nativeBefore + 1);
    const retained = await (await fetch(`${daemonHttp()}/agents/history.json`, { headers })).json() as { missions: { id: string; owner: number; controls: boolean; calls: { picture?: { id: string; mission: string; capture?: { sha256: string } } }[] }[] };
    const own = retained.missions.find((mission) => mission.owner === process.pid);
    const picture = own?.calls.find((call) => call.picture?.capture)?.picture;
    const image = own && picture ? await fetch(`${daemonHttp()}/agents/picture?id=${own.id}&picture=${picture.id}`, { headers }) : undefined;
    const imageBytes = image?.ok ? Buffer.from(await image.arrayBuffer()) : undefined;
    check("opt-in history retains only its verified local picture", own?.controls === false && !!imageBytes && createHash("sha256").update(imageBytes).digest("hex") === picture?.capture?.sha256);
    if (imageBytes) { const path = join(dir, "action-picture.png"); await writeFile(path, imageBytes); ocrPaths.add(path); }
  }
  if (!baseline) {
    const exposed: string[] = [];
    for (const [name, evidence] of sourceReceipts) {
      const manifest = JSON.parse(await readFile(evidence.path, "utf8")) as { source: EvidenceModule.CaptureSource };
      if ([evidence.url, evidence.title, manifest.source.url, manifest.source.title].some(exposesCode)) exposed.push(name);
    }
    check("all capture responses and saved receipts protect an unremembered field value", exposed.length === 0, { checked: sourceReceipts.size, exposed });
    console.log(`protected_source_metadata_captures=${sourceReceipts.size}`);
    const ocr = join(dir, "ocr.swift");
    await writeFile(ocr, `import Foundation\nimport AppKit\nimport Vision\nvar out:[String:String]=[:]\nfor path in CommandLine.arguments.dropFirst(){let url=URL(fileURLWithPath:path);let req=VNRecognizeTextRequest();req.recognitionLevel = .accurate;req.usesLanguageCorrection=false;try VNImageRequestHandler(url:url).perform([req]);out[path]=(req.results ?? []).compactMap{$0.topCandidates(1).first?.string}.joined(separator:"\\n")}\nlet bytes=try JSONSerialization.data(withJSONObject:out);FileHandle.standardOutput.write(bytes)\n`);
    const scan = Bun.spawn(["swift", ocr, ...ocrPaths], { stdout: "pipe", stderr: "pipe" });
    const [text, errors, code] = await Promise.all([new Response(scan.stdout).text(), new Response(scan.stderr).text(), scan.exited]);
    if (code !== 0) throw new Error(`image text scan failed: ${errors}`);
    const recognized = Object.values(JSON.parse(text) as Record<string, string>).join("\n");
    check("pixel inspection sees the public control text", recognized.includes("PUBLIC CONTROL CHECK"));
    check("fictional secrets are absent from every saved image consumer", sentinels.every((secret) => !recognized.replace(/[ -]/g, "").includes(secret)), { scanned: ocrPaths.size });
  }
} catch (error) {
  check("the live scenario completes", false, error instanceof Error ? error.message : String(error));
} finally {
  if (driving) await control("giveback").catch(() => {});
  if (pictures) await control("pictures_off").catch(() => {});
  for (const tab of tabs) await invoke("close", { tab }).catch(() => {});
  await server.stop(true);
  console.log(`artifacts=${dir}`);
}
console.log(`research live checks: ${checks - failures.length} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

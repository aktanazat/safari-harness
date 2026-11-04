// PDF output and input through scripts/pdfkit (WebKit printing and PDFKit).
// Rendering prints a page's HTML the way Safari's Export as PDF does: letter
// pages, images loaded against the page's own address. Neither direction
// touches a privacy-protected resource, so this runs inside the daemon.

import { execFile } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PDFKIT = join(import.meta.dir, "..", "scripts", "pdfkit");

// Runs the helper and parses its one JSON line; failures carry its stderr.
async function pdfkit(args: string[], timeout: number): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(PDFKIT, args, { timeout, maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    const stderr = typeof e === "object" && e !== null && "stderr" in e ? String(e.stderr).trim() : "";
    throw new Error(`pdfkit ${args[0]} failed: ${stderr || (e instanceof Error ? e.message : String(e))}`);
  }
}

// Prints html (resolved against baseUrl) to a paginated PDF at out.
export async function renderPdf(html: string, baseUrl: string, out: string): Promise<{ path: string; pages: number; bytes: number }> {
  const src = `${out}.${process.pid}.${Date.now()}.html`;
  await writeFile(src, html);
  try {
    const r = await pdfkit(["render", src, baseUrl, out], 70000);
    return r as { path: string; pages: number; bytes: number };
  } finally {
    await unlink(src).catch(() => {});
  }
}

// Text of every page of the PDF at path, pages separated by "\n\f\n",
// clipped to maxBytes (default 200000).
export async function pdfText(path: string, maxBytes = 200000): Promise<{ pages: number; text: string; truncated: boolean }> {
  const r = await pdfkit(["text", path, "--max-bytes", String(maxBytes)], 30000);
  return r as { pages: number; text: string; truncated: boolean };
}

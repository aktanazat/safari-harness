// Whether an extension socket comes from a Safari that Apple's safaridriver
// launched for WebDriver (the safari-clean MCP server, safaridriver --mcp).
// That Safari is a second process, started with --automation, and it runs
// its own copy of the extension, which sees none of the user's windows and
// answers the daemon's ping like the real one. On 10-17 one stayed up for
// 70 minutes behind an agent's clean-lane session; whenever the user's copy
// was slow to answer under load, the copy took the connection, and every
// tab request timed out until Safari was quit. navigator.webdriver is false
// in that copy, so the extension cannot tell; the process can.
//
// The socket's client end belongs to the WebKit networking process of its
// Safari (lsof); macOS names the Safari responsible for that process; and
// that Safari's arguments say whether it was launched for automation. A
// step that fails answers false, and the copy is judged by its ping alone.

import { dlopen, FFIType } from "bun:ffi";

const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
  responsibility_get_pid_responsible_for_pid: { args: [FFIType.i32], returns: FFIType.i32 },
});

// lsof answers in about 70 ms; under the 10-17 load a connect still must
// not wait on it for long.
const LOOKUP_MS = 3000;

async function run(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", timeout: LOOKUP_MS });
  return new Response(child.stdout).text();
}

// port: the client end of a socket on 127.0.0.1.
export async function fromAutomation(port: number): Promise<boolean> {
  try {
    const listed = await run(["/usr/sbin/lsof", "-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:ESTABLISHED", "-Fp"]);
    const client = listed.split("\n").filter((l) => l.startsWith("p")).map((l) => Number(l.slice(1))).find((pid) => pid !== process.pid);
    if (client === undefined) return false;
    const safari = symbols.responsibility_get_pid_responsible_for_pid(client);
    if (safari <= 0) return false;
    return /\s--automation(\s|$)/.test(await run(["/bin/ps", "-o", "args=", "-p", String(safari)]));
  } catch {
    return false;
  }
}

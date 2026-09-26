// safari host: drive another Mac's Safari from this one. That Mac's daemon
// listens only on its own 127.0.0.1, so the way in is an ssh tunnel: a
// free port here forwards to the other Mac's 127.0.0.1:37334, and every
// tool call goes through it as if the daemon were local. Nothing new
// listens on the network; ssh keys and the other Mac's sshd decide who may
// connect. The tools that run in the caller's own process (Messages,
// browsing history, real input) run on that Mac over ssh.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HOST_FILE = join(homedir(), ".local/share/safari-harness/host.json");
const DAEMON_PORT = 37334;
// How the other Mac runs its CLI when its shell has not set PATH (ssh runs
// commands without a login shell).
const REMOTE_SAFARI = "~/.bun/bin/bun ~/.bun/bin/safari";

export type HostConfig = { default?: string; hosts?: Record<string, { safari?: string }> };

export async function readHostConfig(): Promise<HostConfig> {
  try {
    return JSON.parse(await readFile(HOST_FILE, "utf8")) as HostConfig;
  } catch {
    return {};
  }
}

async function saveHostConfig(cfg: HostConfig): Promise<void> {
  await mkdir(dirname(HOST_FILE), { recursive: true });
  await writeFile(HOST_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
}

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;
    srv.close(() => resolve(port));
  });
  return promise;
}

export type Tunnel = { url: string; close: () => void };

// ssh -L from a free local port to the host's daemon. The remote side runs
// `cat`, which ends when this process's end of the pipe closes, so the
// tunnel cannot outlive this process even if it is killed outright.
export async function openTunnel(host: string): Promise<Tunnel> {
  if (!/^[A-Za-z0-9_.@-]+$/.test(host)) throw new Error(`not an ssh host name: ${host}`);
  const port = await freePort();
  const ssh = Bun.spawn([
    "ssh", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30",
    "-L", `127.0.0.1:${port}:127.0.0.1:${DAEMON_PORT}`, host, "cat",
  ], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  const close = () => { try { ssh.kill(); } catch { /* already gone */ } };
  process.once("exit", close);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (ssh.exitCode !== null) {
      const why = (await new Response(ssh.stderr).text()).trim();
      throw new Error(`ssh ${host} failed${why ? `: ${why}` : ""}`);
    }
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, close };
    } catch { /* tunnel not up yet, or no daemon behind it */ }
    await Bun.sleep(250);
  }
  close();
  throw new Error(`no safari daemon answered on ${host}'s 127.0.0.1:${DAEMON_PORT}; on that Mac run: safari daemon install`);
}

// Points this process at a host: the --host flag, else an address already
// in SAFARI_HARNESS_HTTP, else the saved default, else this Mac. For
// another Mac, tool calls go through a tunnel to its daemon, and the tools
// that run in the caller run there over ssh. Returns the host's name.
export async function connectHost(flag?: string): Promise<string> {
  const host = flag ?? (process.env.SAFARI_HARNESS_HTTP ? "local" : (await readHostConfig()).default ?? "local");
  if (host === "local") return host;
  const tunnel = await openTunnel(host);
  process.env.SAFARI_HARNESS_HTTP = tunnel.url;
  process.env.SAFARI_HARNESS_REMOTE = host;
  return host;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

// One of the tools that must run on the Mac itself (Messages, history,
// real input), run there by its own CLI over ssh.
export async function remoteCall(host: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (!/^[a-z_]+$/.test(tool)) throw new Error(`unknown tool ${tool}`);
  const safari = (await readHostConfig()).hosts?.[host]?.safari ?? REMOTE_SAFARI;
  const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, `${safari} call ${tool} ${shellQuote(JSON.stringify(args))} --json --host local`], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.trim().replace(/^error: /, "") || `ssh ${host} exited ${code}`);
  return JSON.parse(out) as unknown;
}

// The hosts to choose from: this Mac, the hosts named in ~/.ssh/config
// (not patterns), and any host with settings in host.json.
export async function listHosts(): Promise<{ name: string; default: boolean }[]> {
  const cfg = await readHostConfig();
  let sshConfig = "";
  try { sshConfig = await readFile(join(homedir(), ".ssh/config"), "utf8"); } catch { /* no ssh config */ }
  const named = [...sshConfig.matchAll(/^\s*Host\s+(.+)$/gim)].flatMap((m) => m[1].trim().split(/\s+/)).filter((h) => !/[*?!]/.test(h));
  const names = [...new Set(["local", ...named, ...Object.keys(cfg.hosts ?? {}), ...(cfg.default ? [cfg.default] : [])])];
  const chosen = cfg.default ?? "local";
  return names.map((name) => ({ name, default: name === chosen }));
}

// The host's daemon health, through a tunnel when it is another Mac.
export async function hostHealth(host: string): Promise<unknown> {
  if (host === "local") return (await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`)).json();
  const tunnel = await openTunnel(host);
  try {
    return await (await fetch(`${tunnel.url}/health`)).json();
  } finally {
    tunnel.close();
  }
}

// Saves host as the default after checking its daemon answers; "local"
// goes back to this Mac.
export async function setDefaultHost(host: string): Promise<unknown> {
  const cfg = await readHostConfig();
  if (host === "local") {
    delete cfg.default;
    await saveHostConfig(cfg);
    return { default: "local" };
  }
  const health = await hostHealth(host);
  cfg.default = host;
  await saveHostConfig(cfg);
  return { default: host, health };
}

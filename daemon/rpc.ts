// Client for the daemon's HTTP RPC port, for code that runs outside the
// daemon: the MCP server, the REPL, and the tools that run in the calling
// process. The address is read on each call, so a process that opens a
// tunnel to another Mac (safari host) can point here after it starts.

export function daemonHttp(): string {
  return process.env.SAFARI_HARNESS_HTTP ?? "http://127.0.0.1:37334";
}

export async function rpc(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const base = daemonHttp();
  let res: Response;
  try {
    res = await fetch(`${base}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
  } catch {
    throw new Error(`safari daemon not reachable at ${base}; run: safari daemon install`);
  }
  const body = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
  if (!body.ok) throw new Error(body.error ?? "rpc failed");
  return body.value;
}

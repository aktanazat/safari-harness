// Client for the daemon's HTTP RPC port, for code that runs outside the
// daemon: the MCP server and the tools that run in the calling process.

export const DAEMON_HTTP = process.env.SAFARI_HARNESS_HTTP ?? "http://127.0.0.1:37334";

export async function rpc(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${DAEMON_HTTP}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
  } catch {
    throw new Error(`safari daemon not reachable at ${DAEMON_HTTP}; run: safari daemon install`);
  }
  const body = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
  if (!body.ok) throw new Error(body.error ?? "rpc failed");
  return body.value;
}

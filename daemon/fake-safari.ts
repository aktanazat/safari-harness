// Connecting a test's fake Safari to the daemon's bridge. bun test runs
// every file against the same modules, so one bridge serves them all, and it
// keeps the extension that connected first. A test's fake Safari stands for
// a Safari that started again: the socket of the one before it, this file's
// or another's, closes first.
import { bridge, type ExtSocket } from "./bridge.ts";

let connected: ExtSocket | undefined;

export function connect(sock: ExtSocket) {
  if (connected) bridge.detach(connected);
  connected = sock;
  bridge.attach(sock);
}

// Safari Harness passwords bridge. It runs in a hidden Helium: macOS starts
// Apple's password helper only under a short list of approved browsers, and
// Helium is on it. The helper also answers only Apple's own extension ids, so
// the manifest carries the public key of Apple's Chrome extension, which gives
// this bridge that id.
//
// The bridge only relays. The daemon holds the pairing and does all of the
// encryption, so no password is readable here. The pairing lives in the
// helper, whose port stays open while the daemon restarts: the bridge dials
// the new daemon and hands it the session the last one left here, sealed
// with a key the bridge never sees. A daemon that stays away longer than a
// pairing outlasts its last user ends the pairing here.
//
//   bridge -> daemon  {hello: {helper, stash}}  on connecting: whether the
//                                     helper runs, and the session kept
//   daemon -> bridge  {helper: message}   passed to the helper
//   daemon -> bridge  {stash: sealed}     kept for the next daemon; null
//                                         forgets it
//   bridge -> daemon  {helper: message}   a message from the helper
//   bridge -> daemon  {closed: reason}    the helper exited

const HOST = "com.apple.passwordmanager";
const ORPHAN_MS = 5 * 60 * 1000;
let ws = null;
let helper = null;
let stash = null;
let orphaned = null;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function toHelper(message) {
  if (!helper) {
    helper = chrome.runtime.connectNative(HOST);
    helper.onMessage.addListener((m) => send({ helper: m }));
    helper.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message ?? "the helper exited";
      helper = null;
      stash = null;
      send({ closed: reason });
    });
  }
  helper.postMessage(message);
}

// Closing the port ends the helper's pairing.
function forget() {
  orphaned = null;
  if (helper) helper.disconnect();
  helper = null;
  stash = null;
}

async function connect() {
  const { port } = await (await fetch(chrome.runtime.getURL("port.json"))).json();
  ws = new WebSocket(`ws://127.0.0.1:${port}/passwords`);
  ws.onopen = () => {
    clearTimeout(orphaned);
    orphaned = null;
    send({ hello: { helper: helper !== null, stash } });
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.helper) toHelper(msg.helper);
    if ("stash" in msg) stash = msg.stash;
  };
  ws.onclose = () => {
    orphaned ??= setTimeout(forget, ORPHAN_MS);
    setTimeout(connect, 1000);
  };
}

connect();

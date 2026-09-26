// Safari Harness passwords bridge. It runs in a hidden Helium: macOS starts
// Apple's password helper only under a short list of approved browsers, and
// Helium is on it. The helper also answers only Apple's own extension ids, so
// the manifest carries the public key of Apple's Chrome extension, which gives
// this bridge that id.
//
// The bridge only relays. The daemon holds the pairing and does all of the
// encryption, so no password is readable here.
//
//   daemon -> bridge  {helper: message}   passed to the helper
//   bridge -> daemon  {helper: message}   a message from the helper
//   bridge -> daemon  {closed: reason}    the helper exited

const HOST = "com.apple.passwordmanager";
let ws = null;
let helper = null;

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
      send({ closed: reason });
    });
  }
  helper.postMessage(message);
}

async function connect() {
  const { port } = await (await fetch(chrome.runtime.getURL("port.json"))).json();
  ws = new WebSocket(`ws://127.0.0.1:${port}/passwords`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.helper) toHelper(msg.helper);
  };
  // The pairing lives in the daemon, so a lost daemon ends the helper session.
  ws.onclose = () => {
    if (helper) helper.disconnect();
    helper = null;
    setTimeout(connect, 1000);
  };
}

connect();

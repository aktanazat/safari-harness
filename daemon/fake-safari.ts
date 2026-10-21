// Connecting a test's fake Safari to the daemon's bridge. bun test runs
// every file against the same modules, so one bridge serves them all, and it
// keeps the extension that connected first. A test's fake Safari stands for
// a Safari that started again: the socket of the one before it, this file's
// or another's, closes first.
import { bridge, type ExtSocket } from "./bridge.ts";
import { crc32, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { Capture } from "./evidence.ts";

let connected: ExtSocket | undefined;

export function connect(sock: ExtSocket) {
  if (connected) bridge.detach(connected);
  connected = sock;
  bridge.attach(sock);
}

export function captureFixture(url: string, width = 1, height = 1): Capture {
  const chunk = (name: string, body: Buffer) => {
    const label = Buffer.from(name);
    const encoded = Buffer.alloc(body.length + 12);
    encoded.writeUInt32BE(body.length);
    label.copy(encoded, 4);
    body.copy(encoded, 8);
    encoded.writeUInt32BE(crc32(Buffer.concat([label, body])), body.length + 8);
    return encoded;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const color = createHash("sha256").update(url).digest();
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }
  const data = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
  return {
    data,
    source: {
      url,
      title: "Fixture",
      capturedAt: "2026-10-21T00:00:00.000Z",
      width,
      height,
      viewport: { width, height, devicePixelRatio: 1 },
      privacy: { masked: 0 },
    },
  };
}

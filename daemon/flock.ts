let flock: Promise<(fd: number, operation: number) => number> | undefined;

// Takes an exclusive flock(2) on fd without waiting: true once this
// process holds it. The kernel releases it on the descriptor's last close,
// including after a crash. bun:ffi is platform-specific, so libSystem is
// loaded only on first use, on macOS.
export async function tryLock(fd: number): Promise<boolean> {
  flock ??= import("bun:ffi").then(({ dlopen, FFIType }) => dlopen("/usr/lib/libSystem.B.dylib", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols.flock);
  return (await flock)(fd, 6) === 0;
}

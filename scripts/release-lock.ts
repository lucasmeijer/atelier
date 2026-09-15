import { dlopen, read } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

// Both systems provide flock(2), but macOS does not ship the flock CLI.
export function acquireReleaseLock(path: string): (() => void) | undefined {
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux") throw new Error("Release locking requires macOS or Linux");
  const errnoSymbol = mac ? "__error" : "__errno_location";
  const library = dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    [errnoSymbol]: { args: [], returns: "ptr" },
  });
  let fd: number;
  try {
    fd = openSync(path, "a");
  } catch (error) {
    library.close();
    throw error;
  }
  // LOCK_EX | LOCK_NB. Keep the file: unlinking it would allow competing inodes.
  if (library.symbols.flock!(fd, 2 | 4) !== 0) {
    const errno = read.i32(library.symbols[errnoSymbol]!()!);
    closeSync(fd);
    library.close();
    if (errno === (mac ? 35 : 11)) return undefined; // EWOULDBLOCK
    throw new Error(`Cannot lock ${path}: errno ${errno}`);
  }
  library.close();
  // Closing the descriptor (including on process death) releases the kernel lock.
  return () => closeSync(fd);
}

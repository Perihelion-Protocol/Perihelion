// SPDX-License-Identifier: MIT

/**
 * Crash-safe file helpers for the relayer's local state files.
 *
 * A rename is only durable once the renamed data and the directory entry have
 * reached disk, so writes go: temp file write -> fsync(temp) -> close ->
 * rename -> fsync(directory). The filesystem is injectable so the ordering can
 * be verified without touching a real disk.
 */
import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "@perihelion/node-common";

/** Minimal open-file surface used by the durable writer. */
export interface FileSink {
  write(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Minimal filesystem surface used by the durable writer and quarantine. */
export interface DurableFs {
  mkdir(dir: string): Promise<void>;
  openFile(path: string, flags: "w" | "r"): Promise<FileSink>;
  rename(from: string, to: string): Promise<void>;
}

/** Real filesystem implementation. */
export const nodeDurableFs: DurableFs = {
  async mkdir(dir) {
    await mkdir(dir, { recursive: true });
  },
  async openFile(path, flags) {
    const handle = await open(path, flags);
    return {
      write: async (data) => {
        await handle.writeFile(data, "utf8");
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  rename,
};

/** Directory fsync is unsupported on some platforms; these codes mean "skip". */
const UNSUPPORTED_DIR_SYNC_CODES = new Set(["EISDIR", "EPERM", "EINVAL"]);

/**
 * Atomically and durably replace `path` with `data`.
 *
 * A crash at any point leaves either the old file or the new file, never a
 * partially written one.
 */
export async function writeFileDurably(
  path: string,
  data: string,
  fs: DurableFs = nodeDurableFs,
): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir);

  const tmpPath = `${path}.tmp`;
  const file = await fs.openFile(tmpPath, "w");
  try {
    await file.write(data);
    await file.sync();
  } finally {
    await file.close();
  }

  await fs.rename(tmpPath, path);
  await syncDirectory(dir, fs);
}

async function syncDirectory(dir: string, fs: DurableFs): Promise<void> {
  const handle = await fs.openFile(dir, "r");
  try {
    await handle.sync();
  } catch (err) {
    if (!UNSUPPORTED_DIR_SYNC_CODES.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
  } finally {
    await handle.close();
  }
}

/**
 * Move a corrupt state file aside so the relayer can start instead of
 * crashing on every restart. The original bytes are kept for inspection.
 *
 * @returns the path the corrupt file was moved to.
 */
export async function quarantineCorruptFile(
  path: string,
  reason: string,
  log?: Logger,
  fs: Pick<DurableFs, "rename"> = nodeDurableFs,
): Promise<string> {
  const quarantinedTo = `${path}.corrupt-${Date.now()}`;
  await fs.rename(path, quarantinedTo);
  log?.error("corrupt relayer state file quarantined; continuing without it", {
    path,
    quarantinedTo,
    reason,
  });
  return quarantinedTo;
}

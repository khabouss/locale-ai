import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Writes `data` to `file` via a temp file in the same directory, then an atomic
 * rename, so a reader (or this process, re-run after being killed) never sees a
 * partially-written file — `file` itself is untouched until the rename succeeds.
 * Used for the lock file and target locale files, both of which fail loudly on
 * invalid/truncated content rather than silently treating it as empty.
 *
 * Carries over `file`'s own permissions (a rename replaces the directory entry
 * with the temp file's, which would otherwise silently reset any custom mode back
 * to the process' default), and removes the temp file on a failed rename — e.g. an
 * `EPERM`/`EBUSY` on Windows when an editor or antivirus scan has `file` open —
 * rather than leaving it behind forever.
 */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tmp, data);
  try {
    const mode = fs.statSync(file, { throwIfNoEntry: false })?.mode;
    if (mode !== undefined) fs.chmodSync(tmp, mode);
  } catch {
    // best-effort — a mode we can't read or set is no worse than the default
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Synchronously blocks the calling thread for `ms` — Node allows `Atomics.wait` on its main thread (unlike a browser's UI thread), so this needs no extra dependency and no event-loop callback. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serializes concurrent *processes* (not just callers in this one) around `fn`,
 * which must itself re-read whatever it's protecting fresh from disk before
 * writing it back — the lock only prevents two processes from doing that
 * read-modify-write at the same moment, which is what actually stops one
 * process's write from silently discarding another's (e.g. two `locale-ai
 * translate` runs for different locales racing on the same
 * `locale-ai.lock.json`, each overwriting the other's history for the locale
 * it didn't itself just translate).
 *
 * Exclusive file creation (`wx`) is the mutex primitive: atomic across
 * processes on every platform Node supports, so no extra dependency is
 * needed. A lock file older than `staleMs` is assumed abandoned by a process
 * that crashed while holding it, and is taken over rather than waited on
 * forever.
 */
export function withFileLock<T>(lockFile: string, fn: () => T, opts: { staleMs?: number; timeoutMs?: number } = {}): T {
  const staleMs = opts.staleMs ?? 30_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const mtimeMs = fs.statSync(lockFile, { throwIfNoEntry: false })?.mtimeMs;
      if (mtimeMs !== undefined && Date.now() - mtimeMs > staleMs) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock file ${lockFile} (held longer than ${opts.timeoutMs ?? 60_000}ms).`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

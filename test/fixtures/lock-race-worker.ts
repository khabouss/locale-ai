/**
 * Standalone script spawned as a separate OS process by the "lock: two concurrent
 * processes" test in unit.test.ts — simulates one locale of a `locale-ai translate`
 * run: load the lock (as `translate` does at the start of a run), do some "work"
 * (standing in for the seconds a real translation takes, during which another
 * process can race on the same lock file), then record this locale's entry and
 * persist it via `mergeAndSaveLock`.
 *
 * Usage: node lock-race-worker.ts <lockPath> <localeTag> <delayMs>
 */
import { loadLock, mergeAndSaveLock, recordEntries, type LockFile } from "../../src/lock.ts";

const [lockPath, localeTag, delayMs] = process.argv.slice(2);
loadLock(lockPath!);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(delayMs));
const pending: LockFile = { version: 3, entries: {} };
recordEntries(pending, "en.json", localeTag!, [{ path: "greeting", source: "Hello", written: `Hello-${localeTag}` }]);
mergeAndSaveLock(lockPath!, pending);

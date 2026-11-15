import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "./fs-atomic.ts";

/**
 * Tracks, per source file, key path and TARGET LOCALE, the source string last
 * translated for that locale and the output last written there — so a rerun
 * can tell a source edit (re-translate) apart from a translator edit (flag as
 * a conflict, never silently overwrite) apart from "nothing changed" (skip),
 * instead of treating any non-empty target string as done forever. Source and
 * written hashes are kept per locale (not shared across locales translated at
 * different times) so that translating "es" today doesn't make a stale "fr"
 * look up to date tomorrow.
 *
 * Flat by design (one `"<fileKey>#<path>"` entry per key, rather than nested
 * `files[fileKey][path].mt[locale]` objects spread across many lines): a
 * project with thousands of keys and a dozen locales produced a multi-megabyte,
 * six-levels-deep lock file under the old (version 2) shape, where every run
 * touched lines scattered all over the file — a dedicated source of merge
 * conflicts for teams committing it. Flattening the path, and shortening each
 * hash to 8 hex characters (still 4 billion-to-one odds of a false match,
 * plenty for change detection rather than cryptographic integrity), keeps the
 * whole record for one key on one line, so two translators editing different
 * keys touch different lines.
 */
export interface LockFile {
  version: 3;
  /** `entries["<fileKey>#<path>"][targetTag]` = `"<sourceHash8>:<writtenHash8>"`. */
  entries: Record<string, Record<string, string>>;
}

/** Shape written by locale-ai 0.7.0–0.7.x (version 2): nested per file/path/locale, 16-char hashes. */
interface LockFileV2 {
  files: Record<string, Record<string, { mt: Record<string, { source: string; written: string }> }>>;
}

/** Shape written by locale-ai < 0.7.0 (version 1): one source hash shared by every locale, 16-char hashes. */
interface LockFileV1 {
  files: Record<string, Record<string, { source: string; mt: Record<string, string> }>>;
}

export const LOCK_FILENAME = "locale-ai.lock.json";

const entryKey = (fileKey: string, path: string) => `${fileKey}#${path}`;

export function hashOf(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
}

/** Splits a stored `"<source>:<written>"` pair back into its two hashes. */
function parsePair(pair: string | undefined): { source: string; written: string } | undefined {
  if (pair === undefined) return undefined;
  const i = pair.indexOf(":");
  return i === -1 ? undefined : { source: pair.slice(0, i), written: pair.slice(i + 1) };
}

/**
 * Loads the lock, migrating an older file in memory. Version 1's one shared
 * `source` hash becomes that path's `source` for every locale it had already
 * written a hash for — an approximation (the real per-locale source hash at
 * the time each locale was last translated isn't recoverable), but it only
 * risks one extra re-translation per locale, never a missed one, and never a
 * silent overwrite. Both older versions' 16-character hashes are truncated to
 * the 8 characters `hashOf` now produces — the same prefix of the same SHA-256
 * digest, so every existing hash still compares equal to a freshly computed
 * one; nothing needs re-translating just because of the migration itself.
 *
 * A file that doesn't exist yet starts fresh silently (first run, or the lock
 * was never committed). A file that exists but fails to parse — most commonly
 * unresolved `<<<<<<<` merge-conflict markers, since the README tells teams to
 * commit this file — throws instead: silently treating it as "missing" would
 * discard every edit/staleness record with no warning, and the next save
 * would overwrite the conflict with a lock that looks cleanly resolved.
 */
export function loadLock(file: string): LockFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { version: 3, entries: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${file} exists but isn't valid JSON — possibly an unresolved merge conflict. ` +
        `Fix or delete it before continuing; translate/check won't guess at a broken lock. (${(e as Error).message})`,
    );
  }
  if (!parsed || typeof parsed !== "object") return { version: 3, entries: {} };
  if ((parsed as { version?: unknown }).version === 3) {
    const entries = (parsed as { entries?: unknown }).entries;
    return { version: 3, entries: entries && typeof entries === "object" ? (entries as LockFile["entries"]) : {} };
  }
  const entries: LockFile["entries"] = {};
  if ((parsed as { version?: unknown }).version === 2) {
    const v2 = parsed as LockFileV2;
    for (const [fk, paths] of Object.entries(v2.files ?? {})) {
      for (const [p, entry] of Object.entries(paths ?? {})) {
        const mt: Record<string, string> = {};
        for (const [tag, state] of Object.entries(entry?.mt ?? {})) {
          mt[tag] = `${state.source.slice(0, 8)}:${state.written.slice(0, 8)}`;
        }
        if (Object.keys(mt).length) entries[entryKey(fk, p)] = mt;
      }
    }
    return { version: 3, entries };
  }
  const v1 = parsed as LockFileV1;
  for (const [fk, paths] of Object.entries(v1.files ?? {})) {
    for (const [p, entry] of Object.entries(paths ?? {})) {
      const mt: Record<string, string> = {};
      for (const [tag, written] of Object.entries(entry?.mt ?? {})) {
        mt[tag] = `${entry.source.slice(0, 8)}:${written.slice(0, 8)}`;
      }
      if (Object.keys(mt).length) entries[entryKey(fk, p)] = mt;
    }
  }
  return { version: 3, entries };
}

/**
 * Re-keys every entry's file key (relative to the lock's own directory) from
 * `fromDir` to `toDir`, for a lock whose location moved — adding a
 * `locale-ai.config.json` moves it next to the config file. Without this, moving
 * the file alone still wouldn't match: `en/home.json` relative to `src/locales/`
 * is `src/locales/en/home.json` relative to the project root.
 */
export function rebaseLock(lock: LockFile, fromDir: string, toDir: string): LockFile {
  const entries: LockFile["entries"] = {};
  for (const [key, tagMap] of Object.entries(lock.entries)) {
    const i = key.indexOf("#");
    const fk = path.relative(toDir, path.resolve(fromDir, key.slice(0, i))).split(path.sep).join("/");
    entries[`${fk}${key.slice(i)}`] = tagMap;
  }
  return { version: 3, entries };
}

/** One JSON object, but one entry per line (sorted for a stable diff) rather than `JSON.stringify`'s nested, multi-line-per-field layout — so a change to one key never shifts lines belonging to another. */
export function saveLock(file: string, lock: LockFile): void {
  const keys = Object.keys(lock.entries).sort();
  const body = keys.length ? keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(lock.entries[k])}`).join(",\n") : "";
  writeFileAtomic(file, `{\n  "version": 3,\n  "entries": {\n${body}\n  }\n}\n`);
}

/**
 * Reverses `locales.ts`'s `joinPath` dot-escaping (`\.` → `.`, `\\` → `\`) to recover
 * the path a pre-0.7.24 lock file would have stored for the same key — before a
 * literal `.` within a key got escaped there to stop colliding with a nested key of
 * the same dotted name. A path with no escaped character round-trips unchanged.
 */
function legacyPathFor(path: string): string {
  return path.replace(/\\(.)/g, "$1");
}

/**
 * Looks up `path`'s recorded pair, falling back to the pre-0.7.24 unescaped path when
 * the (now-escaped) path itself has no entry — so upgrading from an older lock doesn't
 * make every flat key with a literal `.` in its name look never-translated-but-already-
 * filled (existing non-empty text, no staleness record) and silently stop tracking
 * further source edits. On a fallback hit, the entry is copied onto the new, escaped
 * key so later lookups (and the next save) find it directly; the old key is left for
 * `pruneDeletedKeys` to drop on its own, since it no longer matches any current path.
 */
function lookupPair(lock: LockFile, fileKey: string, path: string, targetTag: string): { source: string; written: string } | undefined {
  const key = entryKey(fileKey, path);
  const direct = parsePair(lock.entries[key]?.[targetTag]);
  if (direct) return direct;
  const legacyPath = legacyPathFor(path);
  if (legacyPath === path) return undefined;
  const legacyValue = lock.entries[entryKey(fileKey, legacyPath)]?.[targetTag];
  if (legacyValue === undefined) return undefined;
  (lock.entries[key] ??= {})[targetTag] = legacyValue;
  return parsePair(legacyValue);
}

/**
 * True when `path`'s source string in `fileKey` has changed, for `targetTag`
 * specifically, since that locale was last translated — meaning the existing
 * target text is stale and needs redoing even though it's non-empty. False
 * for a path/locale the lock has never seen (new adoption, or a brand-new
 * key, both already handled by the empty-target check).
 */
export function isSourceStale(lock: LockFile, fileKey: string, path: string, targetTag: string, source: string): boolean {
  const pair = lookupPair(lock, fileKey, path, targetTag);
  return pair !== undefined && pair.source !== hashOf(source);
}

/**
 * True when the text currently on disk at `path` for `targetTag` doesn't
 * match what this tool itself last wrote there — i.e. a translator (or
 * anyone else) edited it since. Only reported; the edit is never silently
 * overwritten, and a source change alone never clears this (see
 * `editedPaths`'s caller, which treats stale + edited as a conflict rather
 * than re-translating) — until `locale-ai accept` records the current text
 * as approved.
 */
export function isEdited(lock: LockFile, fileKey: string, path: string, targetTag: string, currentValue: string): boolean {
  const pair = lookupPair(lock, fileKey, path, targetTag);
  return pair !== undefined && pair.written !== hashOf(currentValue);
}

/** Key paths whose existing target text for `targetTag` was edited since this tool last wrote it (see `isEdited`). */
export function editedPaths(
  lock: LockFile,
  fileKey: string,
  targetTag: string,
  entries: Array<{ path: string; value: string }>,
): string[] {
  const out: string[] = [];
  for (const { path, value } of entries) if (isEdited(lock, fileKey, path, targetTag, value)) out.push(path);
  return out;
}

/**
 * Records, for every path given, the current source hash and the hash of
 * `written`, for `targetTag` — called both for every path actually
 * (re)translated this run, and by `locale-ai accept` to approve a hand edit
 * (where `written` is simply the text already on disk, left untouched).
 */
export function recordEntries(
  lock: LockFile,
  fileKey: string,
  targetTag: string,
  entries: Array<{ path: string; source: string; written: string }>,
): void {
  for (const { path, source, written } of entries) {
    const key = entryKey(fileKey, path);
    const entry = (lock.entries[key] ??= {});
    entry[targetTag] = `${hashOf(source)}:${hashOf(written)}`;
  }
}

/**
 * Every leaf path this tool has previously written a translation to, for `fileKey`
 * and `targetTag` specifically — i.e. what the lock recorded as of the START of this
 * run, before anything it does this run can have changed it. Used to recognize a
 * target-only key as one THIS TOOL put there for a source key that's since been
 * deleted or renamed (see `locales.ts`'s `buildTarget`), rather than one added some
 * other way (by hand, by another tool) that was never this tool's to prune.
 */
export function lockedPathsFor(lock: LockFile, fileKey: string, targetTag: string): Set<string> {
  const prefix = entryKey(fileKey, "");
  const out = new Set<string>();
  for (const key of Object.keys(lock.entries)) {
    if (key.startsWith(prefix) && lock.entries[key][targetTag] !== undefined) out.add(key.slice(prefix.length));
  }
  return out;
}

/**
 * Removes lock entries (for every locale) whose key path no longer exists in the current source — so a deleted key doesn't linger forever.
 *
 * A pre-0.7.24 entry for a flat key with a literal `.` in its name (`"menu.save"`, now
 * the escaped `"menu\.save"`) matches no current path either, but it isn't deleted: it's
 * renamed onto the escaped path instead. `lookupPair`'s fallback only migrates it in the
 * lock loaded at the start of a run, and `mergeAndSaveLock` prunes a copy re-read fresh
 * from disk — so without this, a run that never looked the key up (nothing to translate)
 * deleted the old entry with nothing written in its place, losing that key's change
 * tracking for good. An entry already recorded under the escaped path wins per locale,
 * and a legacy path that's ambiguous (two current escaped paths unescape to it) is
 * pruned as before rather than guessed at.
 */
export function pruneDeletedKeys(lock: LockFile, fileKey: string, currentPaths: Iterable<string>): void {
  const keep = new Set(currentPaths);
  const byLegacy = new Map<string, string | null>();
  for (const p of keep) {
    const legacy = legacyPathFor(p);
    if (legacy !== p) byLegacy.set(legacy, byLegacy.has(legacy) ? null : p);
  }
  const prefix = entryKey(fileKey, "");
  for (const key of Object.keys(lock.entries)) {
    if (!key.startsWith(prefix)) continue;
    const p = key.slice(prefix.length);
    if (keep.has(p)) continue;
    const escaped = byLegacy.get(p);
    if (escaped) lock.entries[entryKey(fileKey, escaped)] = { ...lock.entries[key], ...lock.entries[entryKey(fileKey, escaped)] };
    delete lock.entries[key];
  }
}

/**
 * Persists `pending`'s entries (built with `recordEntries` against an initially
 * empty `LockFile`, never against the one `translate`/`accept` loaded at the
 * start of the run) by merging them into a copy of the lock re-read fresh from
 * disk right before writing, rather than writing back the in-memory snapshot
 * loaded at the start of a possibly-long translation run.
 *
 * Without this, two `locale-ai` runs started close together — e.g. separate
 * `translate --to fr` and `translate --to es` processes, both racing on the
 * same project's lock file — each load the same starting snapshot, and
 * whichever finishes and calls `saveLock` last overwrites the other's
 * history entirely: translating "es" would silently erase the lock's record
 * of "fr" ever having been translated (the translated files on disk are
 * unaffected — only the lock's edit/staleness tracking is lost). The merge
 * itself is wrapped in `withFileLock` so the "read the current file, merge
 * in, write it back" sequence is also atomic across processes, not just the
 * final write.
 *
 * `pruneSpecs` re-applies this run's `pruneDeletedKeys` calls against that
 * fresh copy too — safe to redo because which paths still exist in the
 * current source is a plain fact of this run, independent of what any
 * concurrent process wrote.
 */
export function mergeAndSaveLock(lockPath: string, pending: LockFile, pruneSpecs: Array<{ fileKey: string; currentPaths: Iterable<string> }> = []): void {
  withFileLock(`${lockPath}.mutex`, () => {
    const fresh = loadLock(lockPath);
    for (const { fileKey: fk, currentPaths } of pruneSpecs) pruneDeletedKeys(fresh, fk, currentPaths);
    for (const [key, tagMap] of Object.entries(pending.entries)) Object.assign((fresh.entries[key] ??= {}), tagMap);
    saveLock(lockPath, fresh);
  });
}

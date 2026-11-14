/**
 * Programmatic entry point: the same translate/check/accept pipeline `src/cli.ts`
 * drives, usable from code instead of a shell — a build script that translates
 * locale files as part of its own pipeline, or a test that runs `check` in-process
 * rather than via `execFileSync`. `src/cli.ts` itself imports `translate`/`check`/
 * `accept`/`ensureInstalled` from here, but still owns its own argv parsing,
 * interactive prompts and terminal progress bars on top; this file should never
 * import `cli.ts`, whose top-level `main()` call would otherwise run on import.
 */
import fs from "node:fs";
import path from "node:path";
import { CATALOG, customEntries, reachableTargets, resolveRoute, type Hop, type ModelEntry } from "./catalog.ts";
import { translateStrings, type Issue } from "./engine.ts";
import { writeFileAtomic } from "./fs-atomic.ts";
import { glossaryLookup, loadConfig, protectRegex, type ProjectConfig } from "./glossary.ts";
import { extractIcu, isIcuComplex } from "./icu.ts";
import { intlCode, parseLocale, type Locale } from "./lang.ts";
import { editedPaths, isEdited, isSourceStale, LOCK_FILENAME, loadLock, mergeAndSaveLock, recordEntries, type LockFile } from "./lock.ts";
import {
  addNestedPluralForms,
  addPluralForms,
  buildTarget,
  detectLayout,
  existingTargets,
  flattenStrings,
  keyPathProtect,
  pendingEntries,
  pluralOneStrings,
  readLocaleDoc,
  sourceFiles,
  targetFile,
  usesI18nextPlurals,
  type Layout,
  type LocaleDoc,
} from "./locales.ts";
import { install, isInstalled, loadTranslator, localModelProblem, planInstall, type InstallPlan, type Translator } from "./models.ts";
import { hasTranslatableText, mask } from "./placeholders.ts";

/** Built-in models plus the project's own config (which take priority) — same resolution `cli.ts` uses. */
export function fullCatalog(config: ProjectConfig, cwd: string): ModelEntry[] {
  return [...customEntries(config.models, config.dir ?? cwd), ...CATALOG];
}

/** Portable lock-file key: forward slashes, relative to `base` (the lock file's own directory). */
export const fileKey = (p: string, base: string) => path.relative(base, p).split(path.sep).join("/");

function staleNotEdited(lock: LockFile, lockKey: string, existing: unknown, targetTag: string): (p: string, s: string) => boolean {
  const existingFlat = new Map(flattenStrings(existing).map((e) => [e.path, e.value]));
  return (p, s) => {
    if (!isSourceStale(lock, lockKey, p, targetTag, s)) return false;
    const current = existingFlat.get(p);
    return current === undefined || !isEdited(lock, lockKey, p, targetTag, current);
  };
}

function positiveIntOrThrow(n: number | undefined, name: string, fallback: number): number {
  if (n === undefined) return fallback;
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid ${name} ${JSON.stringify(n)}: expected a positive integer.`);
  return n;
}

/** One model download `translate` needs before it can proceed. */
export interface DownloadPlan {
  modelId: string;
  bytes: number;
  /** The Hugging Face repo id, or local path, this model installs from. */
  source: string;
}

export type TranslateEvent =
  | { type: "found"; layout: Layout; fromTag: string; fileCount: number }
  | { type: "route-missing"; locale: string; sourceLang: string; targetLang: string; available: string[] }
  | {
      type: "dry-run-locale";
      locale: string;
      pending: number;
      models: Array<{ id: string; installed: boolean }>;
      files: Array<{ target: string; pending: number }>;
    }
  | { type: "checking-models" }
  | { type: "download-plan"; plans: DownloadPlan[]; totalBytes: number }
  | { type: "download-progress"; modelId: string; done: number; total: number }
  | { type: "download-done"; modelId: string }
  | { type: "loading-model"; locale: string; modelId: string }
  | { type: "translate-progress"; locale: string; done: number; total: number }
  | {
      type: "locale-done";
      locale: string;
      stringsTranslated: number;
      filesWritten: number;
      pluralsAdded: number;
      issues: number;
      durationMs: number;
      route: string[];
    }
  | { type: "lock-created"; path: string };

export interface TranslateOptions {
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  /** Source locale, e.g. "en". Default: "en". */
  from?: string;
  /** Target locale(s) to translate to, e.g. "fr" or ["fr", "es", "pt-BR"]. */
  to: string | string[];
  /** Folder/file to translate from — same meaning as the CLI's `--input`. */
  input?: string;
  /** Re-translate strings that already have a translation. */
  overwrite?: boolean;
  /** Compute what would be translated without downloading a model or writing anything. */
  dryRun?: boolean;
  /** Greedy decoding: faster, slightly lower quality. */
  fast?: boolean;
  /** Beam width for decoding (default: 4, or 1 with `fast`). */
  beams?: number;
  /** Strings translated per model batch (default: 32). */
  batchSize?: number;
  /** For `.po`/`.pot`: flag every entry this run (re)translated as `#, fuzzy`. */
  fuzzy?: boolean;
  /** Project config file path (default: `./locale-ai.config.json` if present, same lookup as the CLI). */
  config?: string;
  /** Allow downloading any model this run needs, with no further confirmation. */
  yes?: boolean;
  /**
   * Called once, before downloading, when `yes` isn't set — return (or resolve to)
   * `true` to proceed. With neither this nor `yes`, a needed download throws instead.
   */
  confirmDownload?: (plans: DownloadPlan[], totalBytes: number) => boolean | Promise<boolean>;
  /** Fires throughout the run — the same information the CLI renders as progress bars and log lines. */
  onEvent?: (event: TranslateEvent) => void;
}

export interface TranslateLocaleResult {
  locale: string;
  /** The model(s) used, in routing order (more than one for a pivot translation via a third language). */
  route: string[];
  /** Strings actually (re)translated this run (shared across this locale's files, so not a per-file sum). */
  stringsTranslated: number;
  filesWritten: number;
  pluralsAdded: number;
  durationMs: number;
}

export interface TranslateDryRunLocale {
  locale: string;
  pending: number;
  models: Array<{ id: string; installed: boolean }>;
  files: Array<{ target: string; pending: number }>;
}

export interface TranslateResult {
  /** False when any requested locale failed (no route) — never thrown, since the other locales may still have succeeded. */
  ok: boolean;
  failures: Array<{ locale: string; reason: string }>;
  locales: TranslateLocaleResult[];
  issues: Array<Issue & { locale: string }>;
  /** Present only when `dryRun` was set; `locales`/`issues` are then empty. */
  dryRun?: TranslateDryRunLocale[];
  lockFile: string;
  lockCreated: boolean;
}

interface FileJob {
  source: string;
  target: string;
  doc: LocaleDoc;
  existing: unknown;
  pending: string[];
  pendingPaths: string[];
}

interface TargetJob {
  locale: Locale;
  route: Hop[];
  files: FileJob[];
  unique: number;
}

export async function ensureInstalled(
  models: ModelEntry[],
  opts: Pick<TranslateOptions, "yes" | "confirmDownload" | "onEvent">,
): Promise<void> {
  for (const m of new Set(models)) {
    const problem = localModelProblem(m);
    if (problem) throw new Error(`Model ${m.id}: ${problem}`);
  }
  const missing = [...new Set(models)].filter((m) => !m.path && !isInstalled(m));
  if (!missing.length) return;
  opts.onEvent?.({ type: "checking-models" });
  const plans: InstallPlan[] = [];
  for (const m of missing) plans.push(await planInstall(m));
  const totalBytes = plans.reduce((s, p) => s + p.bytes, 0);
  const downloadPlans: DownloadPlan[] = plans.map((p) => ({ modelId: p.model.id, bytes: p.bytes, source: p.model.repo ?? p.model.path ?? "" }));
  opts.onEvent?.({ type: "download-plan", plans: downloadPlans, totalBytes });
  const allowed = opts.yes === true || (await opts.confirmDownload?.(downloadPlans, totalBytes)) === true;
  if (!allowed) {
    throw new Error(
      `Download declined: ${Math.round(totalBytes / 1e6)} MB needed for ${missing.map((m) => m.id).join(", ")}. ` +
        `Pass { yes: true } or a confirmDownload hook to allow it.`,
    );
  }
  for (const p of plans) {
    await install(p, (done, total) => opts.onEvent?.({ type: "download-progress", modelId: p.model.id, done, total }));
    opts.onEvent?.({ type: "download-done", modelId: p.model.id });
  }
}

/**
 * Translates a project's locale files to one or more target locales — the same
 * pipeline `locale-ai translate` runs, as a plain async function: load the source
 * files, resolve a model route per target, translate whatever's pending, and write
 * each target file, recording what was written in `locale-ai.lock.json` alongside it.
 *
 * Unlike the CLI, this never prompts: a download either proceeds (`yes: true` or a
 * `confirmDownload` hook that returns `true`) or the call rejects. Progress and status
 * that the CLI renders as a bar is instead reported through `onEvent`, if given.
 */
export async function translate(opts: TranslateOptions): Promise<TranslateResult> {
  const cwd = opts.cwd ?? process.cwd();
  if (!opts.to || (Array.isArray(opts.to) && opts.to.length === 0)) throw new Error('translate: "to" is required (a locale tag, or an array of them).');
  const from = parseLocale(opts.from ?? "en");
  const targets = (Array.isArray(opts.to) ? opts.to : [opts.to]).map((t) => parseLocale(t));
  const batchSize = positiveIntOrThrow(opts.batchSize, "batchSize", 32);
  const beams = positiveIntOrThrow(opts.beams, "beams", opts.fast ? 1 : 4);

  const config = loadConfig(cwd, opts.config);
  const catalog = fullCatalog(config, cwd);
  const protect = protectRegex(config);
  const isProtectedKey = keyPathProtect(config.doNotTranslateKeys);
  const layout = detectLayout(cwd, from.tag, opts.input);
  const lockDir = config.configFile ? path.dirname(config.configFile) : layout.root;
  const lockPath = path.resolve(lockDir, LOCK_FILENAME);
  const lockExisted = fs.existsSync(lockPath);
  const lock = loadLock(lockPath);
  const sources = sourceFiles(layout, from.tag).map((f) => ({ file: f, doc: readLocaleDoc(f, from.tag, true, opts.fuzzy ?? false) }));
  const singularHints = new Set(sources.flatMap(({ doc }) => [...pluralOneStrings(doc.data)]));
  opts.onEvent?.({ type: "found", layout, fromTag: from.tag, fileCount: sources.length });

  const failures: TranslateResult["failures"] = [];
  const jobs: TargetJob[] = [];
  for (const locale of targets) {
    const route = resolveRoute(from, locale, catalog);
    if (!route) {
      const available = reachableTargets(from.lang, catalog);
      failures.push({ locale: locale.tag, reason: `No local model for ${from.lang} → ${locale.lang}.` });
      opts.onEvent?.({ type: "route-missing", locale: locale.tag, sourceLang: from.lang, targetLang: locale.lang, available });
      continue;
    }
    const files = sources.map(({ file, doc }): FileJob => {
      const target = targetFile(layout, from.tag, locale.tag, file);
      const existing = fs.existsSync(target) ? readLocaleDoc(target, locale.tag).data : undefined;
      const isStale = staleNotEdited(lock, fileKey(file, lockDir), existing, locale.tag);
      const entries = pendingEntries(doc.data, existing, opts.overwrite ?? false, isProtectedKey, isStale);
      return {
        source: file,
        target,
        doc,
        existing,
        pending: entries.map((e) => e.value),
        pendingPaths: entries.map((e) => e.path),
      };
    });
    const unique = new Set(files.flatMap((f) => f.pending)).size;
    jobs.push({ locale, route, files, unique });
  }

  if (opts.dryRun) {
    const dryRun: TranslateDryRunLocale[] = jobs.map((j) => ({
      locale: j.locale.tag,
      pending: j.unique,
      models: j.route.map((h) => ({ id: h.model.id, installed: isInstalled(h.model) })),
      files: j.files.filter((f) => f.pending.length).map((f) => ({ target: f.target, pending: f.pending.length })),
    }));
    for (const d of dryRun) {
      opts.onEvent?.({
        type: "dry-run-locale",
        locale: d.locale,
        pending: d.pending,
        models: d.models,
        files: d.files,
      });
    }
    return { ok: failures.length === 0, failures, locales: [], issues: [], dryRun, lockFile: lockPath, lockCreated: false };
  }

  const active = jobs.filter((j) => j.unique > 0);
  await ensureInstalled(active.flatMap((j) => j.route.map((h) => h.model)), opts);

  const allIssues: Array<Issue & { locale: string }> = [];
  const localeResults: TranslateLocaleResult[] = [];
  const loaded = new Map<string, Translator>();
  const key = (h: Hop) => `${h.model.id}|${h.prefix ?? ""}`;
  const remainingUses = (repoKey: string, from: number) =>
    active.slice(from).filter((j) => j.route.some((h) => key(h) === repoKey)).length;

  for (const job of jobs) {
    const started = Date.now();
    let translations = new Map<string, string>();
    let unresolved = new Set<string>();
    if (job.unique > 0) {
      const translators: Translator[] = [];
      for (const hop of job.route) {
        if (!loaded.has(key(hop))) {
          opts.onEvent?.({ type: "loading-model", locale: job.locale.tag, modelId: hop.model.id });
          loaded.set(key(hop), await loadTranslator(hop, { beams }));
        }
        translators.push(loaded.get(key(hop))!);
      }
      const strings = job.files.flatMap((f) => f.pending);
      const result = await translateStrings(strings, translators, {
        sourceLang: intlCode(from),
        targetLang: intlCode(job.locale),
        batchSize,
        protect,
        lookup: glossaryLookup(from, job.locale, config),
        singularHints,
        onProgress: (done, total) => opts.onEvent?.({ type: "translate-progress", locale: job.locale.tag, done, total }),
      });
      translations = result.translations;
      unresolved = new Set(result.issues.filter((i) => i.kind === "placeholder-fallback").map((i) => i.source));
      allIssues.push(...result.issues.map((i) => ({ ...i, locale: job.locale.tag })));
      for (const hop of job.route) {
        const k = key(hop);
        if (remainingUses(k, active.indexOf(job) + 1) === 0 && loaded.has(k)) {
          await loaded.get(k)!.dispose();
          loaded.delete(k);
        }
      }
    }

    let written = 0;
    let pluralsAdded = 0;
    const pending: LockFile = { version: 3, entries: {} };
    const pruneSpecs: Array<{ fileKey: string; currentPaths: Iterable<string> }> = [];
    for (const f of job.files) {
      const lockKey = fileKey(f.source, lockDir);
      const srcFlat = flattenStrings(f.doc.data);
      const srcPaths = new Set(srcFlat.map((e) => e.path));
      const isStale = staleNotEdited(lock, lockKey, f.existing, job.locale.tag);
      if (f.existing !== undefined) {
        const srcByPath = new Map(srcFlat.map((e) => [e.path, e.value]));
        for (const editedPath of editedPaths(lock, lockKey, job.locale.tag, flattenStrings(f.existing))) {
          if (!srcPaths.has(editedPath)) continue;
          const srcVal = srcByPath.get(editedPath);
          const alsoStale = srcVal !== undefined && isSourceStale(lock, lockKey, editedPath, job.locale.tag, srcVal);
          allIssues.push({ source: editedPath, kind: alsoStale ? "conflict" : "edited", locale: job.locale.tag });
        }
      }
      const built = buildTarget(f.doc.data, f.existing, (s) => translations.get(s) ?? s, opts.overwrite ?? false, isProtectedKey, isStale);
      const translatedSet = new Set(f.pendingPaths);
      const pluralOpts = {
        otherStale: (p: string) => translatedSet.has(p),
        isEdited: (p: string, v: string) => isEdited(lock, lockKey, p, job.locale.tag, v),
        hasSource: (p: string) => srcPaths.has(p),
      };
      const i18next = usesI18nextPlurals(f.source)
        ? addPluralForms(built, intlCode(job.locale), pluralOpts)
        : { doc: built, added: 0, derived: [], edited: [] };
      const nested = addNestedPluralForms(i18next.doc, intlCode(job.locale), pluralOpts);
      const plural = { doc: nested.doc, added: i18next.added + nested.added };
      const pluralDerived = [...i18next.derived, ...nested.derived];
      const pluralEdited = [...i18next.edited, ...nested.edited];
      pluralsAdded += plural.added;
      for (const { path: p, conflict } of pluralEdited) {
        allIssues.push({ source: p, kind: conflict ? "conflict" : "edited", locale: job.locale.tag });
      }
      const before = fs.existsSync(f.target) ? fs.readFileSync(f.target, "utf8") : undefined;
      const text = f.doc.serialize(plural.doc, job.locale.tag, before);
      if (text !== before) {
        fs.mkdirSync(path.dirname(f.target), { recursive: true });
        writeFileAtomic(f.target, text);
        written++;
      }
      const outFlat = new Map(flattenStrings(plural.doc).map((e) => [e.path, e.value]));
      recordEntries(
        pending,
        lockKey,
        job.locale.tag,
        srcFlat
          .filter(({ path: p, value }) => translatedSet.has(p) && !unresolved.has(value))
          .map(({ path: p, value }) => ({ path: p, source: value, written: outFlat.get(p) ?? "" })),
      );
      recordEntries(pending, lockKey, job.locale.tag, pluralDerived.map(({ path: p, value }) => ({ path: p, source: value, written: value })));
      pruneSpecs.push({
        fileKey: lockKey,
        currentPaths: [...srcFlat.map((e) => e.path), ...pluralDerived.map((d) => d.path), ...pluralEdited.map((e) => e.path)],
      });
    }
    if (jobs.length) mergeAndSaveLock(lockPath, pending, pruneSpecs);
    const durationMs = Date.now() - started;
    const route = job.route.map((h) => h.model.id);
    const issuesForLocale = allIssues.filter((i) => i.locale === job.locale.tag).length;
    opts.onEvent?.({
      type: "locale-done",
      locale: job.locale.tag,
      stringsTranslated: job.unique,
      filesWritten: written,
      pluralsAdded,
      issues: issuesForLocale,
      durationMs,
      route,
    });
    localeResults.push({ locale: job.locale.tag, route, stringsTranslated: job.unique, filesWritten: written, pluralsAdded, durationMs });
  }
  for (const t of loaded.values()) await t.dispose();
  const lockCreated = jobs.length > 0 && !lockExisted;
  if (lockCreated) opts.onEvent?.({ type: "lock-created", path: lockPath });

  return { ok: failures.length === 0, failures, locales: localeResults, issues: allIssues, lockFile: lockPath, lockCreated };
}

export type CheckIssue =
  | { locale: string; kind: "missing-file"; target: string; missingCount: number }
  | { locale: string; kind: "missing-key"; target: string; path: string }
  | { locale: string; kind: "placeholder-mismatch"; target: string; path: string; sourcePlaceholders: string[]; targetPlaceholders: string[] }
  | { locale: string; kind: "icu-structure"; target: string; path: string }
  | { locale: string; kind: "stale"; target: string; path: string }
  | { locale: string; kind: "identical"; target: string; path: string };

export interface CheckLocaleResult {
  locale: string;
  missing: number;
  mismatched: number;
  stale: number;
  identical: number;
  /** False when `missing`, `mismatched` or `stale` is nonzero — `identical` alone never fails a locale. */
  ok: boolean;
}

export interface CheckOptions {
  cwd?: string;
  from?: string;
  input?: string;
  config?: string;
}

export interface CheckResult {
  ok: boolean;
  locales: CheckLocaleResult[];
  issues: CheckIssue[];
}

/**
 * Validates already-translated locales against the source without translating
 * anything: same key structure, the same placeholders in each matching string, and
 * (via `locale-ai.lock.json`, if present) no target string that's gone stale since it
 * was last translated. The same check `locale-ai check` runs, as a plain function.
 */
export async function check(opts: CheckOptions = {}): Promise<CheckResult> {
  const cwd = opts.cwd ?? process.cwd();
  const from = parseLocale(opts.from ?? "en");
  const config = loadConfig(cwd, opts.config);
  const layout = detectLayout(cwd, from.tag, opts.input);
  const lockDir = config.configFile ? path.dirname(config.configFile) : layout.root;
  const lock = loadLock(path.resolve(lockDir, LOCK_FILENAME));
  const sources = sourceFiles(layout, from.tag).map((f) => ({ file: f, doc: readLocaleDoc(f, from.tag, true) }));
  const targetTags = existingTargets(layout, from.tag);

  const issues: CheckIssue[] = [];
  const locales: CheckLocaleResult[] = [];
  for (const to of targetTags) {
    let missing = 0;
    let mismatched = 0;
    let identical = 0;
    let stale = 0;
    for (const { file, doc } of sources) {
      const target = targetFile(layout, from.tag, to, file);
      const lockKey = fileKey(file, lockDir);
      if (!fs.existsSync(target)) {
        const missingCount = flattenStrings(doc.data).length;
        missing += missingCount;
        issues.push({ locale: to, kind: "missing-file", target, missingCount });
        continue;
      }
      const srcFlat = flattenStrings(doc.data);
      const tgtByPath = new Map(flattenStrings(readLocaleDoc(target, to).data).map((e) => [e.path, e.value]));
      for (const { path: p, value: srcVal } of srcFlat) {
        const tgtVal = tgtByPath.get(p);
        if (tgtVal === undefined) {
          missing++;
          issues.push({ locale: to, kind: "missing-key", target, path: p });
          continue;
        }
        // A nested ICU plural/select (`{count, plural, one {...} other {...}}`) isn't
        // matched by the simple-placeholder regex at all, so the token comparison below
        // would pass vacuously even with a dropped mandatory "other" or unbalanced
        // braces — check its structure directly instead.
        if (isIcuComplex(srcVal) && extractIcu(tgtVal) === undefined) {
          mismatched++;
          issues.push({ locale: to, kind: "icu-structure", target, path: p });
          continue;
        }
        const srcMasked = mask(srcVal, "natural");
        const srcTokens = srcMasked.tokens.toSorted();
        const tgtTokens = mask(tgtVal, "natural").tokens.toSorted();
        if (srcTokens.join("\u0001") !== tgtTokens.join("\u0001")) {
          mismatched++;
          issues.push({ locale: to, kind: "placeholder-mismatch", target, path: p, sourcePlaceholders: srcTokens, targetPlaceholders: tgtTokens });
          continue;
        }
        if (isSourceStale(lock, lockKey, p, to, srcVal)) {
          stale++;
          issues.push({ locale: to, kind: "stale", target, path: p });
          continue;
        }
        if (tgtVal === srcVal && hasTranslatableText(srcMasked.text)) {
          identical++;
          issues.push({ locale: to, kind: "identical", target, path: p });
        }
      }
    }
    locales.push({ locale: to, missing, mismatched, stale, identical, ok: !(missing || mismatched || stale) });
  }
  return { ok: locales.every((l) => l.ok), locales, issues };
}

export interface AcceptOptions {
  cwd?: string;
  from?: string;
  /** Target locale(s) to accept into; every locale with an existing target file when omitted. */
  to?: string | string[];
  input?: string;
  config?: string;
  /** Accept only these key paths, unconditionally. Every path the lock currently flags as edited, otherwise. */
  keys?: string[];
}

export interface AcceptResult {
  /** Locales checked (resolved from `to`, or every existing target next to `from` when omitted). */
  locales: string[];
  /** Total keys accepted across all locales. */
  accepted: number;
  lockFile: string;
}

/**
 * Approves the current on-disk target text as this tool's own, so a future
 * `translate`/`check` run stops reporting it under the "edited" issue kind. With
 * explicit `keys`, those keys are accepted unconditionally (an explicit ask always
 * wins). With no keys given, only paths the lock currently flags as edited are
 * accepted — NOT every key the target and source share, which would also silently
 * accept a genuinely outdated (source changed since translated) entry nobody
 * reviewed, defeating `check`'s staleness check. The target file is never touched;
 * only the lock's record of what this tool last wrote there is advanced to match,
 * the same as if it had just (re)written that exact text itself. The same thing
 * `locale-ai accept` runs, as a plain function.
 */
export async function accept(opts: AcceptOptions = {}): Promise<AcceptResult> {
  const cwd = opts.cwd ?? process.cwd();
  const from = parseLocale(opts.from ?? "en");
  const config = loadConfig(cwd, opts.config);
  const layout = detectLayout(cwd, from.tag, opts.input);
  const lockDir = config.configFile ? path.dirname(config.configFile) : layout.root;
  const lockPath = path.resolve(lockDir, LOCK_FILENAME);
  const lock = loadLock(lockPath);
  const tags = opts.to
    ? (Array.isArray(opts.to) ? opts.to : [opts.to]).map((t) => parseLocale(t).tag)
    : existingTargets(layout, from.tag);
  if (!tags.length) return { locales: [], accepted: 0, lockFile: lockPath };
  const wanted = opts.keys?.length ? new Set(opts.keys) : undefined;
  const sources = sourceFiles(layout, from.tag).map((f) => ({ file: f, doc: readLocaleDoc(f, from.tag, true) }));

  let accepted = 0;
  const pending: LockFile = { version: 3, entries: {} };
  for (const to of tags) {
    for (const { file, doc } of sources) {
      const target = targetFile(layout, from.tag, to, file);
      if (!fs.existsSync(target)) continue;
      const lockKey = fileKey(file, lockDir);
      const srcByPath = new Map(flattenStrings(doc.data).map((e) => [e.path, e.value]));
      // A plural-derived path (e.g. "item_few") has no source counterpart at all — the
      // same self-referential source==written convention `translate` records it with
      // is used here too, so accepting one of these actually clears its
      // "conflict"/"edited" status instead of silently matching nothing.
      const entries = flattenStrings(readLocaleDoc(target, to).data)
        .filter((e) => (wanted ? wanted.has(e.path) : isEdited(lock, lockKey, e.path, to, e.value)))
        .map((e) => ({ path: e.path, source: srcByPath.get(e.path) ?? e.value, written: e.value }));
      if (!entries.length) continue;
      recordEntries(pending, lockKey, to, entries);
      accepted += entries.length;
    }
  }
  mergeAndSaveLock(lockPath, pending);
  return { locales: tags, accepted, lockFile: lockPath };
}

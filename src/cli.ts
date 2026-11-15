#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findById, reachableTargets, resolveRoute, type ModelEntry } from "./catalog.ts";
import { accept, check, ensureInstalled, fullCatalog, translate, type DownloadPlan, type TranslateEvent } from "./api.ts";
import { CONFIG_FILE, loadConfig } from "./glossary.ts";
import { parseLocale } from "./lang.ts";
import { cacheRoot, isInstalled, readManifest, uninstall } from "./models.ts";

/** Read from package.json so `npm version` is the single source of truth. */
const VERSION: string = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

const HELP = `locale-ai ${VERSION} — translate i18n locale files locally, on CPU, for free.

Usage:
  locale-ai translate --to <locales> [options]
  locale-ai check [--from <locale>] [--input <dir>] [--config <file>]
                        Validate that already-translated locales have the same keys and
                        placeholders as the source, and (via locale-ai.lock.json, if present)
                        that none has gone stale since it was last translated, without
                        translating anything. Exits non-zero on a mismatch (CI-friendly).
  locale-ai accept [--to <locales>] [--from <locale>] [--input <dir>] [--config <file>] [key...]
                        Approve a translator's hand edit at <key> (or, with no key given,
                        every key currently flagged as edited for the chosen locale(s)) as
                        final: the lock stops flagging it on future runs. Never changes the
                        file itself — only what the lock remembers it last wrote there.
  locale-ai models list [--from <locale>]
  locale-ai models installed
  locale-ai models install <from-to | model-id> [--yes]
  locale-ai models remove <model-id>
  locale-ai models convert <hf-marian-model> --out <dir> [--source en --target ko]
                        Convert any Hugging Face MarianMT model (needs Python, see README)

Translate options:
  --from <locale>       Source locale (default: en)
  --to <locales>        Target locale(s), comma separated: fr,es,pt-BR
  --input <dir>         Folder containing <from>/ or <from>.json/.yaml/.yml/.po/.pot/.arb/.strings
                        /.properties/.js/.mjs/.cjs/.ts, an Android res/ folder
                        (values/strings.xml) (auto-detected), a path straight to a
                        .xcstrings catalog (not auto-detected), or a path straight to
                        a .xlf/.xliff/.resx file (not auto-detected)
  --overwrite           Re-translate strings that already have a translation
  --dry-run             Show what would be translated without downloading or writing
  --fast                Greedy decoding: ~2x faster, slightly lower quality
  --beams <n>           Beam width for decoding (default: 4, or 1 with --fast)
  --batch-size <n>      Strings translated per model batch (default: 32)
  --report <file>       Write a JSON report of strings that need review
  --fuzzy               For .po/.pot: flag every entry this run (re)translated as "#, fuzzy"
  --config <file>       Project config (default: ./${CONFIG_FILE} if present)
  -y, --yes             Download required models without asking

Models are cached in ${cacheRoot()} (override with LOCALE_AI_CACHE).
`;

const isTTY = process.stderr.isTTY;
const log = (msg = "") => process.stderr.write(msg + "\n");
const status = (msg: string) => {
  if (isTTY) process.stderr.write(`\r\x1b[2K${msg}`);
};
const endStatus = () => {
  if (isTTY) process.stderr.write("\r\x1b[2K");
};

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const rel = (p: string) => path.relative(process.cwd(), p) || ".";
/**
 * Portable lock-file key: forward slashes, relative to `base` (the lock
 * file's own directory) rather than the current working directory — so the
 * same source file gets the same key whether this ran from the repo root or
 * from a subdirectory with a relative `--input`.
 */
const fileKey = (p: string, base: string) => path.relative(base, p).split(path.sep).join("/");

/**
 * `Number("abc")` is NaN, and NaN silently poisons everything downstream (an
 * all-garbage translation batch, or a raw ONNX crash deep in the model) instead of
 * a clear error at the CLI boundary where the bad flag value actually came from.
 */
function positiveInt(raw: string | undefined, flag: string, fallback?: number): number {
  if (raw === undefined) {
    if (fallback === undefined) throw new Error(`Missing --${flag}.`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid --${flag} "${raw}": expected a positive integer.`);
  return n;
}

function bar(done: number, total: number, width = 24): string {
  const ratio = total ? Math.min(1, done / total) : 1;
  const filled = Math.round(ratio * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${Math.round(ratio * 100)}%`;
}

/**
 * A long download or translation batch can run for a minute or more. The `\r`-redrawn
 * bar only ever reaches a real terminal, so a non-TTY run (CI logs, piped output) would
 * otherwise print nothing at all between the start and the final result, indistinguishable
 * from a hang. This prints one plain line per 10% there instead.
 */
function makeProgress(render: (done: number, total: number) => string): (done: number, total: number) => void {
  let lastPct = -1;
  return (done, total) => {
    if (isTTY) {
      status(render(done, total));
      return;
    }
    const pct = total ? Math.floor((done / total) * 100) : 100;
    if (pct >= lastPct + 10 || (done >= total && lastPct < 100)) {
      lastPct = done >= total ? 100 : pct;
      log(render(done, total));
    }
  };
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    throw new Error(`Cannot ask "${question.trim()}" in a non-interactive shell. Re-run with --yes to allow downloads.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`${question} (Y/n) `)).trim().toLowerCase();
  rl.close();
  return answer === "" || answer === "y" || answer === "yes";
}

/** The `confirmDownload` hook `ensureInstalled` (src/api.ts) takes when `--yes` wasn't passed. */
async function confirmDownloadPrompt(plans: DownloadPlan[], totalBytes: number): Promise<boolean> {
  log("Models to download (one time, then cached for every project):");
  for (const p of plans) log(`  ${p.modelId.padEnd(12)} ${mb(p.bytes).padStart(7)}  ${p.source}`);
  if (!(await confirm(`Download ${mb(totalBytes)}?`, false))) throw new Error("Download declined.");
  return true;
}

/** Renders the download-related subset of events `ensureInstalled` (src/api.ts) emits. */
function onDownloadEvent(e: TranslateEvent): void {
  switch (e.type) {
    case "checking-models":
      status("Checking model sizes...");
      break;
    case "download-plan":
      endStatus();
      break;
    case "download-progress":
      status(`Downloading ${e.modelId} ${bar(e.done, e.total)} ${mb(e.done)}/${mb(e.total)}`);
      break;
    case "download-done":
      endStatus();
      log(`✓ Installed ${e.modelId}`);
      break;
  }
}

/**
 * Thin CLI wrapper around `translate()` (src/api.ts): parses argv, turns every
 * progress/status event the core pipeline emits back into the same terminal output
 * this command has always produced, and prints the final summary. The core itself
 * never touches stdout/stderr or prompts — see api.ts for the actual pipeline.
 */
async function cmdTranslate(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string", default: "en" },
      to: { type: "string" },
      input: { type: "string" },
      overwrite: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "batch-size": { type: "string", default: "32" },
      fast: { type: "boolean", default: false },
      beams: { type: "string" },
      report: { type: "string" },
      config: { type: "string" },
      fuzzy: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
  });
  if (!values.to) throw new Error("Missing --to. Example: locale-ai translate --from en --to fr,es");
  const fromTag = parseLocale(values.from!).tag;
  const batchSize = positiveInt(values["batch-size"], "batch-size");
  const beams = positiveInt(values.beams, "beams", values.fast ? 1 : 4);

  log(`locale-ai ${VERSION}`);
  const result = await translate({
    cwd: process.cwd(),
    from: values.from,
    to: values.to.split(",").map((t) => t.trim()).filter(Boolean),
    input: values.input,
    overwrite: values.overwrite,
    dryRun: values["dry-run"],
    fast: values.fast,
    beams,
    batchSize,
    fuzzy: values.fuzzy,
    config: values.config,
    yes: values.yes,
    confirmDownload: confirmDownloadPrompt,
    onEvent: (e) => {
      switch (e.type) {
        case "found":
          log(
            e.layout.kind === "xcstrings"
              ? `Found ${e.fromTag} strings in ${rel(e.layout.file!)}`
              : `Found ${e.fileCount} ${e.fromTag} file${e.fileCount === 1 ? "" : "s"} in ${rel(e.layout.root)}/` +
                  (e.layout.kind === "dir" ? `${e.fromTag}${e.layout.dirSuffix ?? ""}/` : ""),
          );
          break;
        case "lock-moved":
          log(`Moved ${rel(e.from)} to ${rel(e.to)}, next to your config file — commit both changes.`);
          break;
        case "route-missing":
          log(`✗ ${e.locale}: no local model for ${e.sourceLang} → ${e.targetLang}.`);
          log(`  Available from ${e.sourceLang}: ${e.available.join(", ") || "(none)"}`);
          break;
        case "dry-run-locale": {
          const models = e.models.map((m) => `${m.id}${m.installed ? "" : " (not installed)"}`).join(" → ");
          log(`${e.locale.padEnd(8)} ${String(e.pending).padStart(5)} strings to translate   model: ${models}`);
          for (const f of e.files) log(`         ${rel(f.target)}  +${f.pending}`);
          break;
        }
        case "checking-models":
        case "download-plan":
        case "download-progress":
        case "download-done":
          onDownloadEvent(e);
          break;
        case "loading-model":
          status(`${e.locale}: loading ${e.modelId}...`);
          break;
        case "translate-progress":
          status(`${e.locale}: translating ${bar(e.done, e.total)} ${e.done}/${e.total}`);
          break;
        case "locale-done": {
          endStatus();
          const secs = (e.durationMs / 1000).toFixed(1);
          const via = e.route.length > 1 ? ` (via ${e.route.join(" → ")})` : "";
          log(
            `✓ ${e.locale.padEnd(7)} ${String(e.stringsTranslated).padStart(5)} strings translated, ${e.filesWritten} file${e.filesWritten === 1 ? "" : "s"} written in ${secs}s${via}` +
              (e.pluralsAdded ? `, ${e.pluralsAdded} plural forms added` : "") +
              (e.issues ? `, ${e.issues} to review` : ""),
          );
          break;
        }
      }
    },
  });

  if (result.dryRun) return result.ok ? 0 : 1;

  if (result.lockCreated) {
    log(`\nCreated ${rel(result.lockFile)} — commit it so other runs (and \`locale-ai check\`) see the same history.`);
  }
  if (result.issues.length) {
    log();
    log(`${result.issues.length} string${result.issues.length === 1 ? "" : "s"} worth a quick review:`);
    for (const i of result.issues.slice(0, 10)) {
      log(`  [${i.locale}] ${i.kind}: ${JSON.stringify(i.source)}${i.output ? ` → ${JSON.stringify(i.output)}` : ""}`);
    }
    if (result.issues.length > 10) log(`  ... and ${result.issues.length - 10} more${values.report ? "" : " (use --report <file>)"}`);
  }
  if (values.report) {
    fs.writeFileSync(values.report, JSON.stringify({ version: VERSION, from: fromTag, issues: result.issues }, null, 2) + "\n");
    log(`Report written to ${values.report}`);
  }
  return result.ok ? 0 : 1;
}

/** Runs scripts/convert-marian.py and prints the config entry for the new model. */
function convertModel(
  model: string | undefined,
  opts: { out?: string; source?: string; target?: string; python?: string },
): number {
  if (!model || !opts.out) throw new Error("Usage: locale-ai models convert <hf-marian-model> --out <dir>");
  const script = fileURLToPath(new URL("../scripts/convert-marian.py", import.meta.url));
  const python = opts.python ?? process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const res = spawnSync(python, [script, model, "--out", opts.out], { stdio: "inherit" });
  if (res.error || res.status !== 0) {
    log(`\nConversion failed. It needs Python 3.10+ with: pip install "optimum-onnx[onnxruntime]" accelerate sentencepiece`);
    log(`(use --python <path> to pick an interpreter, e.g. a virtualenv)`);
    return 1;
  }
  const entry: Record<string, unknown> = {
    source: opts.source ?? "en",
    target: opts.target ?? "<target language code>",
    path: path.relative(process.cwd(), path.resolve(opts.out)) || ".",
  };
  try {
    const vocab = JSON.parse(fs.readFileSync(path.join(opts.out, "vocab.json"), "utf8")) as Record<string, number>;
    const codes = Object.keys(vocab).filter((k) => /^>>[\w-]+<<$/.test(k));
    if (codes.length) {
      entry.prefix = "<one of the target tokens below>";
      log(`\nThis model is multi-target; its target tokens: ${codes.join(" ")}`);
    }
  } catch {
    // vocab.json missing: the script would have failed already.
  }
  log(`\nAdd to ${CONFIG_FILE} under "models":\n${JSON.stringify(entry, null, 2)}`);
  return 0;
}

async function cmdModels(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      from: { type: "string" },
      config: { type: "string" },
      out: { type: "string" },
      source: { type: "string" },
      target: { type: "string" },
      python: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
    },
  });
  const catalog = fullCatalog(loadConfig(process.cwd(), values.config), process.cwd());
  switch (sub) {
    case "list": {
      const filter = values.from ? parseLocale(values.from).lang : undefined;
      for (const m of catalog) {
        if (filter && !m.sources.includes(filter)) continue;
        const state = isInstalled(m) ? "installed" : "";
        log(`${m.id.padEnd(12)} ${m.sources.join(",")} → ${m.targets.join(",").padEnd(22)} ${state}`);
      }
      if (filter) log(`\nReachable from ${filter} (direct or via English): ${reachableTargets(filter, catalog).join(", ")}`);
      return 0;
    }
    case "installed": {
      const list = catalog.map((m) => ({ m, man: readManifest(m) })).filter((x) => x.man);
      if (!list.length) log("No models installed.");
      for (const { m, man } of list) log(`${m.id.padEnd(12)} ${mb(man!.bytes).padStart(7)}  ${man!.installedAt.slice(0, 10)}`);
      return 0;
    }
    case "install": {
      if (!positionals[0]) throw new Error("Usage: locale-ai models install <from-to | model-id>");
      let models: ModelEntry[];
      const byId = findById(positionals[0], catalog);
      if (byId) models = [byId];
      else {
        const [a, ...b] = positionals[0].split("-");
        const route = resolveRoute(parseLocale(a), parseLocale(b.join("-")), catalog);
        if (!route) throw new Error(`No model for ${positionals[0]}. See: locale-ai models list`);
        models = route.map((h) => h.model);
      }
      const already = models.filter(isInstalled);
      already.forEach((m) => log(`✓ ${m.id} already installed`));
      await ensureInstalled(models, { yes: values.yes!, confirmDownload: confirmDownloadPrompt, onEvent: onDownloadEvent });
      return 0;
    }
    case "remove": {
      const m = positionals[0] && findById(positionals[0], catalog);
      if (!m) throw new Error("Usage: locale-ai models remove <model-id>  (see: locale-ai models installed)");
      log((await uninstall(m)) ? `Removed ${m.id}` : `${m.id} is not installed`);
      return 0;
    }
    case "convert":
      return convertModel(positionals[0], values);
    default:
      // Just the models commands, not the whole CLI help.
      if (sub) log(`Unknown models command "${sub}".\n`);
      log(`Usage:\n${HELP.split("\n").filter((l) => l.includes("locale-ai models")).join("\n")}`);
      return sub ? 1 : 0;
  }
}

/**
 * Validates already-translated locales against the source without translating:
 * same key structure, and the same placeholders in each matching string. Meant for
 * CI, so a mismatch (a key a translator dropped, a {name} a translation lost) fails
 * the build instead of shipping silently.
 */
async function cmdCheck(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string", default: "en" },
      input: { type: "string" },
      config: { type: "string" },
    },
  });
  const fromTag = parseLocale(values.from!).tag;
  const result = await check({ cwd: process.cwd(), from: values.from, input: values.input, config: values.config });
  if (!result.locales.length) {
    log(`No translated locales found next to ${fromTag}.`);
    return 0;
  }

  let identicalTotal = 0;
  let orphanedTotal = 0;
  for (const loc of result.locales) {
    for (const issue of result.issues.filter((i) => i.locale === loc.locale)) {
      const target = rel(issue.target);
      if (issue.kind === "missing-file") log(`✗ ${loc.locale}: ${target} is missing entirely`);
      else if (issue.kind === "missing-key") log(`✗ ${loc.locale}: ${target} missing key "${issue.path}"`);
      else if (issue.kind === "placeholder-mismatch") {
        log(
          `✗ ${loc.locale}: ${target} "${issue.path}" placeholders differ: source [${issue.sourcePlaceholders.join(", ")}], target [${issue.targetPlaceholders.join(", ")}]`,
        );
      } else if (issue.kind === "icu-structure") {
        log(`✗ ${loc.locale}: ${target} "${issue.path}" has a broken plural/select — missing "other" or unbalanced braces`);
      } else if (issue.kind === "stale") {
        log(`✗ ${loc.locale}: ${target} "${issue.path}" is stale — the ${fromTag} source changed since this was last translated`);
      } else if (issue.kind === "orphan-key") {
        log(`⚠ ${loc.locale}: ${target} "${issue.path}" has no ${fromTag} source anymore — the key was deleted or renamed`);
      } else {
        log(`⚠ ${loc.locale}: ${target} "${issue.path}" is untouched, identical to the ${fromTag} source`);
      }
    }
    identicalTotal += loc.identical;
    orphanedTotal += loc.orphaned;
    if (loc.ok) log(`✓ ${loc.locale}${loc.identical ? ` (${loc.identical} left identical to ${fromTag})` : ""}`);
  }
  if (identicalTotal) log(`\n${identicalTotal} string${identicalTotal === 1 ? "" : "s"} left identical to the source — not a failure, but worth a look.`);
  if (orphanedTotal) {
    log(`${orphanedTotal} key${orphanedTotal === 1 ? "" : "s"} orphaned by a deleted/renamed source key — not a failure, but consider removing them.`);
  }
  return result.ok ? 0 : 1;
}

/** Thin CLI wrapper around `accept()` (src/api.ts): parses argv, prints the summary. */
async function cmdAccept(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      from: { type: "string", default: "en" },
      to: { type: "string" },
      input: { type: "string" },
      config: { type: "string" },
    },
  });
  const result = await accept({
    cwd: process.cwd(),
    from: values.from,
    to: values.to,
    input: values.input,
    config: values.config,
    keys: positionals,
  });
  if (result.lockMovedFrom) log(`Moved ${rel(result.lockMovedFrom)} to ${rel(result.lockFile)}, next to your config file — commit both changes.`);
  if (!result.locales.length) {
    log(`No translated locales found next to ${parseLocale(values.from!).tag}.`);
    return 0;
  }
  log(
    result.accepted
      ? `✓ Accepted ${result.accepted} key${result.accepted === 1 ? "" : "s"} across ${result.locales.length} locale${result.locales.length === 1 ? "" : "s"} — \`check\`/\`translate\` won't flag ${result.accepted === 1 ? "it" : "them"} as edited again.`
      : `No matching key${positionals.length === 1 ? "" : "s"} found to accept.`,
  );
  return 0;
}

/**
 * Re-runs scripts/trim-onnxruntime.cjs's cleanup on every invocation, not just
 * at install time: npm doesn't guarantee that script (locale-ai's own
 * postinstall) runs after onnxruntime-node's own postinstall has finished
 * downloading the ~260 MB CUDA provider it's meant to remove, so that file
 * can still be sitting there right after `npm install`. This repeat is cheap
 * (a handful of fs checks once the first trim has already run) and catches
 * that race. Best-effort: never allowed to fail a command over this.
 */
function repeatTrim(): void {
  try {
    const script = fileURLToPath(new URL("../scripts/trim-onnxruntime.cjs", import.meta.url));
    (createRequire(import.meta.url)(script) as { trim: () => void }).trim();
  } catch {
    // ignore — best-effort only
  }
}

async function main(): Promise<number> {
  repeatTrim();
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "translate":
      return cmdTranslate(rest);
    case "check":
      return cmdCheck(rest);
    case "accept":
      return cmdAccept(rest);
    case "models":
      return cmdModels(rest);
    case "-v":
    case "--version":
      console.log(VERSION);
      return 0;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      log(HELP);
      return 0;
    default:
      log(`Unknown command "${cmd}".\n`);
      log(HELP);
      return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    endStatus();
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);

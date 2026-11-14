import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Hop, ModelEntry } from "./catalog.ts";
import { MarianModel, type MarianPaths } from "./marian.ts";

/** Bumped when the downloaded file set changes; forces a re-install (files are reused). */
const FORMAT_VERSION = 2;
const MANIFEST = "locale-ai.json";
const HF = (process.env.HF_ENDPOINT ?? "https://huggingface.co").replace(/\/$/, "");
/**
 * Whether `HF` is the real huggingface.co, checked by its parsed hostname rather than
 * `HF.includes("huggingface.co")` — a substring match a hostile `HF_ENDPOINT` can pass
 * while still sending the token somewhere else entirely, e.g.
 * `https://huggingface.co.attacker.example` (a subdomain of attacker.example) or
 * `https://attacker.example/huggingface.co` (the text appears, but only in the path).
 */
const IS_HF_HOST = ((): boolean => {
  try {
    return new URL(HF).hostname === "huggingface.co";
  } catch {
    return false;
  }
})();

const REQUIRED = ["config.json", "vocab.json", "source.spm"];
const OPTIONAL = ["tokenizer_config.json", "generation_config.json", "target_vocab.json"];

/**
 * ONNX weights in order of preference. int8 is ~4x smaller than fp32 with no
 * measurable quality loss (chrF 68.9 vs 69.0 on en-fr, 47.8 vs 47.8 on en-ar).
 */
const ENCODERS = ["encoder_model_quantized.onnx", "encoder_model_int8.onnx", "encoder_model.onnx"];
const DECODERS = ["decoder_model_merged_quantized.onnx", "decoder_model_merged_int8.onnx", "decoder_model_merged.onnx"];

export function cacheRoot(): string {
  if (process.env.LOCALE_AI_CACHE) return path.resolve(process.env.LOCALE_AI_CACHE);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "locale-ai");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "locale-ai");
}

const modelsRoot = () => path.join(cacheRoot(), "models");

/**
 * Where a model's files live: its local folder, or its cache folder. `repo` is
 * validated as a plain "namespace/name" Hugging Face id when it comes from a
 * project config (see catalog.ts's customEntries) — this is a second,
 * independent check that the computed cache folder actually stays inside the
 * cache root, since install() writes there and uninstall() recursively deletes
 * it: a `repo` that somehow smuggled a ".." segment past that first check must
 * never be allowed to touch a path outside the cache.
 */
export function modelDir(m: ModelEntry): string {
  if (m.path) return m.path;
  const root = modelsRoot();
  const dir = path.join(root, ...m.repo!.split("/"));
  const rel = path.relative(root, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${m.id}: "repo" (${m.repo}) resolves outside the model cache.`);
  }
  return dir;
}

export interface Manifest {
  format: number;
  repo: string;
  revision: string;
  installedAt: string;
  bytes: number;
  encoder: string;
  decoder: string;
}

export function readManifest(m: ModelEntry): Manifest | undefined {
  if (m.path) return undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(modelDir(m), MANIFEST), "utf8")) as Manifest;
    return manifest.format === FORMAT_VERSION ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/** Finds the ONNX files in a local model folder (root or onnx/). */
function findLocal(dir: string): MarianPaths | undefined {
  const pick = (names: string[]) => {
    for (const sub of ["onnx", "."]) {
      for (const n of names) {
        const p = path.join(dir, sub, n);
        if (fs.existsSync(p)) return p;
      }
    }
    return undefined;
  };
  const encoder = pick(ENCODERS);
  const decoder = pick(DECODERS);
  if (!encoder || !decoder || !REQUIRED.every((f) => fs.existsSync(path.join(dir, f)))) return undefined;
  return { dir, encoder, decoder };
}

export function modelPaths(m: ModelEntry): MarianPaths | undefined {
  if (m.path) return findLocal(m.path);
  const man = readManifest(m);
  if (!man) return undefined;
  const dir = modelDir(m);
  return { dir, encoder: path.join(dir, man.encoder), decoder: path.join(dir, man.decoder) };
}

export const isInstalled = (m: ModelEntry) => modelPaths(m) !== undefined;

/** Explains why a local model folder cannot be used. */
export function localModelProblem(m: ModelEntry): string | undefined {
  if (!m.path) return undefined;
  if (!fs.existsSync(m.path)) return `folder not found: ${m.path}`;
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(m.path!, f)));
  if (missing.length) return `missing ${missing.join(", ")} in ${m.path}`;
  return findLocal(m.path)
    ? undefined
    : `no encoder/merged decoder ONNX files in ${m.path} (convert it with scripts/convert-marian.py)`;
}

export interface RemoteFile {
  path: string;
  size: number;
  /** sha256 for LFS files. */
  sha256?: string;
  /** git blob sha1 for small, non-LFS files. */
  gitSha1?: string;
}

export interface InstallPlan {
  model: ModelEntry;
  revision: string;
  files: RemoteFile[];
  bytes: number;
  encoder: string;
  decoder: string;
}

/** Connect/response timeout for a single attempt when the caller isn't managing its own signal (planInstall's small JSON calls). A download's own stall timeout (see `download`) covers the whole, potentially long-running, body transfer instead. */
const CONNECT_TIMEOUT_MS = 30_000;

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": "locale-ai" };
  // HF_TOKEN authenticates against huggingface.co's own API — never forward it to a
  // custom HF_ENDPOINT (a self-hosted mirror on a restricted network), which could be
  // any third party, not just the same trust boundary this token was issued for.
  if (process.env.HF_TOKEN && IS_HF_HOST) headers.authorization = `Bearer ${process.env.HF_TOKEN}`;
  return headers;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetchWithRetry(url);
  return res.json();
}

async function fetchWithRetry(url: string, attempts = 3, signal?: AbortSignal): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: requestHeaders(), signal: signal ?? AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      if (res.ok) return res;
      if (res.status === 404) throw new Error(`Not found: ${url}`);
      if (res.status === 401 || res.status === 403) {
        throw new Error(`${url} requires authentication (HTTP ${res.status}). If this is a private or gated model, set HF_TOKEN.`);
      }
      last = new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      if (e instanceof Error && (e.message.startsWith("Not found") || e.message.includes("requires authentication"))) throw e;
      last = e;
    }
    if (signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  // Node's fetch wraps the real network error (ENOTFOUND, blocked by a proxy, ...) in
  // `.cause`, so the generic top-level "fetch failed" message alone — with no host
  // named — is the least useful part of it.
  const cause = last instanceof Error && last.cause instanceof Error ? last.cause : undefined;
  const detail = cause ? `${last instanceof Error ? last.message : ""}: ${cause.message}` : last instanceof Error ? last.message : String(last);
  const mirrorHint = IS_HF_HOST ? ` If ${host} is blocked on this network, set HF_ENDPOINT to a mirror.` : "";
  throw new Error(`Download failed: could not reach ${host} (${detail}).${mirrorHint}`);
}

/** Resolves the exact files, sizes and checksums to download for a model. */
export async function planInstall(m: ModelEntry): Promise<InstallPlan> {
  if (!m.repo) throw new Error(`${m.id} is a local model; nothing to download.`);
  const info = (await getJson(`${HF}/api/models/${m.repo}/revision/${m.revision ?? "main"}`)) as { sha: string };
  const tree = (await getJson(`${HF}/api/models/${m.repo}/tree/${info.sha}?recursive=true`)) as Array<{
    path: string;
    size: number;
    oid: string;
    lfs?: { oid: string; size: number };
  }>;
  const byPath = new Map(tree.map((e) => [e.path, e]));
  const pick = (names: string[]) => {
    for (const sub of ["onnx/", ""]) for (const n of names) if (byPath.has(sub + n)) return sub + n;
    return undefined;
  };
  const encoder = pick(ENCODERS);
  const decoder = pick(DECODERS);
  if (!encoder || !decoder) {
    throw new Error(`${m.repo} has no encoder + merged decoder ONNX files (see scripts/convert-marian.py).`);
  }
  const wanted = [...REQUIRED, ...OPTIONAL.filter((f) => byPath.has(f)), encoder, decoder];
  const files = wanted.map((f): RemoteFile => {
    const entry = byPath.get(f);
    if (!entry) throw new Error(`${m.repo} is missing ${f}; this model cannot be used.`);
    return entry.lfs
      ? { path: f, size: entry.lfs.size, sha256: entry.lfs.oid }
      : { path: f, size: entry.size, gitSha1: entry.oid };
  });
  return { model: m, revision: info.sha, files, bytes: files.reduce((s, f) => s + f.size, 0), encoder, decoder };
}

function newHash(file: RemoteFile): Hash {
  if (file.sha256) return createHash("sha256");
  const h = createHash("sha1");
  h.update(`blob ${file.size}\0`);
  return h;
}

/** True when `p` already holds exactly this file (lets upgrades skip re-downloading). */
async function matches(p: string, file: RemoteFile): Promise<boolean> {
  try {
    if ((await fsp.stat(p)).size !== file.size) return false;
    const h = newHash(file);
    for await (const chunk of fs.createReadStream(p)) h.update(chunk as Buffer);
    return h.digest("hex") === (file.sha256 ?? file.gitSha1);
  } catch {
    return false;
  }
}

/** No bytes (connect included) for this long is treated as a dead connection, not a slow one. */
const STALL_TIMEOUT_MS = 30_000;

export async function download(url: string, dest: string, file: RemoteFile, onBytes: (n: number) => void): Promise<void> {
  const controller = new AbortController();
  let stallTimer: NodeJS.Timeout | undefined;
  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => controller.abort(new Error(`stalled: no data received for ${STALL_TIMEOUT_MS / 1000}s`)),
      STALL_TIMEOUT_MS,
    );
  };
  resetStallTimer();
  try {
    const res = await fetchWithRetry(url, 3, controller.signal);
    if (!res.body) throw new Error(`Empty response for ${url}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const hash = newHash(file);
    const out = fs.createWriteStream(dest);
    // A write-stream error (e.g. ENOSPC on a full disk) is otherwise an unhandled
    // 'error' event: EventEmitter semantics crash the whole process with it, bypassing
    // this function's own try/catch entirely. Capturing it here instead lets the loop
    // below notice and raise it as an ordinary rejection, same as any other failure.
    let streamErr: Error | undefined;
    out.on("error", (err) => (streamErr = err));
    let written = 0;
    try {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        if (streamErr) throw streamErr;
        resetStallTimer();
        hash.update(chunk);
        written += chunk.length;
        onBytes(chunk.length);
        // A stream that has errored (e.g. ENOSPC) never emits 'drain' afterward, so
        // awaiting only 'drain' here hangs forever — with nothing else left running,
        // Node then exits the whole process on its own, silently, with no error and
        // exit code 0 (confirmed: writing to /dev/full this way never throws, logs,
        // or returns; the process just ends). Waiting on 'error' too, and resolving
        // either way, lets the `if (streamErr) throw` right after actually run.
        if (!out.write(chunk)) {
          await new Promise<void>((resolve) => {
            const onSettled = () => {
              out.off("drain", onSettled);
              out.off("error", onSettled);
              resolve();
            };
            out.once("drain", onSettled);
            out.once("error", onSettled);
          });
        }
        if (streamErr) throw streamErr;
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()));
    }
    if (streamErr) throw streamErr;
    if (written !== file.size || hash.digest("hex") !== (file.sha256 ?? file.gitSha1)) {
      throw new Error(`Checksum mismatch for ${file.path} (got ${written} bytes). Please retry.`);
    }
  } finally {
    clearTimeout(stallTimer);
  }
}

/** True when a process with this pid is still running (used to tell a live install's temp dir apart from one a killed process left behind). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes any `.partial-<pid>` dir next to `dir` left by a process that no longer exists — a previous install killed mid-download, which never reaches the `catch` cleanup below. Never removes one whose pid is still alive, so a genuinely concurrent install isn't disturbed. */
export function cleanupStalePartials(dir: string): void {
  const parent = path.dirname(dir);
  const prefix = `${path.basename(dir)}.partial-`;
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(name.slice(prefix.length));
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) continue;
    try {
      fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}

export async function install(plan: InstallPlan, onProgress?: (done: number, total: number) => void): Promise<void> {
  const dir = modelDir(plan.model);
  cleanupStalePartials(dir);
  const tmp = `${dir}.partial-${process.pid}`;
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  let done = 0;
  try {
    for (const f of plan.files) {
      const dest = path.join(tmp, f.path);
      const previous = path.join(dir, f.path);
      if (await matches(previous, f)) {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(previous, dest);
        done += f.size;
        onProgress?.(done, plan.bytes);
        continue;
      }
      const url = `${HF}/${plan.model.repo}/resolve/${plan.revision}/${f.path}`;
      for (let attempt = 0; ; attempt++) {
        const before = done;
        try {
          await download(url, dest, f, (n) => {
            done += n;
            onProgress?.(done, plan.bytes);
          });
          break;
        } catch (e) {
          done = before;
          if (attempt >= 2) throw e;
        }
      }
    }
    const manifest: Manifest = {
      format: FORMAT_VERSION,
      repo: plan.model.repo!,
      revision: plan.revision,
      installedAt: new Date().toISOString(),
      bytes: plan.bytes,
      encoder: plan.encoder,
      decoder: plan.decoder,
    };
    await fsp.writeFile(path.join(tmp, MANIFEST), JSON.stringify(manifest, null, 2));
    // Move the old dir aside (an instant rename) rather than `rm` it before renaming
    // `tmp` into place: `rm`-ing a large directory first leaves a window — however
    // long that takes — where another process (or this one, reading concurrently)
    // sees `dir` missing entirely. Renaming it aside first shrinks that window to the
    // time between two renames, each effectively instantaneous.
    const old = `${dir}.old-${process.pid}`;
    await fsp.rm(old, { recursive: true, force: true });
    try {
      await fsp.rename(dir, old);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await fsp.rename(tmp, dir);
    await fsp.rm(old, { recursive: true, force: true });
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

export async function uninstall(m: ModelEntry): Promise<boolean> {
  if (m.path) throw new Error(`${m.id} is a local model in ${m.path}; remove it from your config instead.`);
  if (!fs.existsSync(modelDir(m))) return false;
  await fsp.rm(modelDir(m), { recursive: true, force: true });
  return true;
}

export interface Translator {
  translate(texts: string[]): Promise<string[]>;
  dispose(): Promise<void>;
}

export interface LoadOptions {
  /** Beam width; 1 = greedy (fastest). */
  beams: number;
  threads?: number;
}

export async function loadTranslator(hop: Hop, opts: LoadOptions): Promise<Translator> {
  const paths = modelPaths(hop.model);
  if (!paths) throw new Error(localModelProblem(hop.model) ?? `${hop.model.id} is not installed.`);
  const model = await MarianModel.load(paths, opts.threads);
  if (hop.prefix && !model.hasToken(hop.prefix)) {
    await model.dispose();
    throw new Error(`${hop.model.id} does not support the target code ${hop.prefix}.`);
  }
  return {
    translate: (texts) => model.translate(texts, hop.prefix, { beams: opts.beams }),
    dispose: () => model.dispose(),
  };
}

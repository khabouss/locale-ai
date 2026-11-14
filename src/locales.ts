import fs from "node:fs";
import path from "node:path";
import { parseLocale } from "./lang.ts";
import { readArbDoc } from "./formats/arb.ts";
import { readAndroidXmlDoc } from "./formats/android-xml.ts";
import { readStringsDoc } from "./formats/apple-strings.ts";
import { readJsModuleDoc } from "./formats/js-module.ts";
import { readJsonDoc, readYamlDoc } from "./formats/json-yaml.ts";
import { readPoDoc } from "./formats/po.ts";
import { readPropertiesDoc } from "./formats/properties.ts";
import { readResxDoc } from "./formats/resx.ts";
import { CATEGORIES, isObj, type LocaleDoc, newObj, type Obj } from "./formats/shared.ts";
import { readXcstringsDoc } from "./formats/xcstrings.ts";
import { readXliffDoc } from "./formats/xliff.ts";

export type { LocaleDoc };

/**
 * Supported layouts:
 *   dir:        <root>/en/common.json, <root>/en/auth/login.json  ->  <root>/fr/...
 *   file:       <root>/en.json                                    ->  <root>/fr.json
 *   android:    <root>/values/strings.xml                         ->  <root>/values-fr/strings.xml
 *   xcstrings:  <file>.xcstrings (every locale, source included, lives inside this one file)
 *   xliff:      <file>.xlf (untagged source)                       ->  <file>.fr.xlf
 *
 * dir and file both accept ".json", ".yaml", ".yml", ".po", ".arb", ".strings" or
 * ".properties" files, independently per file. android is its own thing: the file is
 * always named "strings.xml", and the locale lives in the untagged "values" (source)
 * vs. "values-<qualifier>" (target) directory name instead of the file name. xcstrings
 * and xliff are both only ever reached via an explicit `--input <file>` rather than
 * auto-detected from CANDIDATES: xcstrings because there's no per-locale file to find
 * at all, xliff because its source file carries no locale tag in its name (the source
 * locale lives inside the file, as `source-language`) — only the convention this
 * project writes target files under (`<basename>.<locale>.xlf`) does. .NET's `.resx`
 * (its own kind "resx") is the same shape as xliff — untagged default resource file,
 * `<basename>.fr.resx` satellite resources — just with no source-language metadata
 * inside the file at all to cross-check `--from` against.
 */
export interface Layout {
  kind: "dir" | "file" | "android" | "xcstrings" | "xliff" | "resx";
  root: string;
  /** For kind "file": the source file's extension (e.g. ".json", ".po"). For kind "xliff"/"resx": ".xlf"/".xliff"/".resx". */
  ext?: string;
  /** For kind "file": a filename prefix shared by every locale file (Flutter's "app_en.arb"). */
  prefix?: string;
  /** For kind "dir": a suffix appended to the locale tag to name the directory (Apple's "en.lproj"). */
  dirSuffix?: string;
  /** For kind "xcstrings": the one catalog file every locale (including the source) lives in. For kind "xliff"/"resx": the source file. */
  file?: string;
}

const EXTENSIONS = [".json", ".yaml", ".yml", ".po", ".pot", ".arb", ".strings", ".properties", ".js", ".mjs", ".cjs", ".ts"];

/**
 * Java's `ResourceBundle` convention names a region-qualified `.properties` file
 * "fr_FR", not this project's BCP-47 "fr-FR" everywhere else — so the tag is
 * underscore-joined only at the filename boundary, for this one extension.
 */
const propertiesTag = (ext: string, tag: string) => (ext === ".properties" ? tag.replace("-", "_") : tag);
const tagFromPropertiesQualifier = (ext: string, qualifier: string) => (ext === ".properties" ? qualifier.replace("_", "-") : qualifier);

const CANDIDATES = [
  "locales",
  "src/locales",
  "public/locales",
  "src/i18n/locales",
  "src/i18n",
  "i18n",
  "src/assets/i18n",
  "assets/i18n",
  "src/assets/locales",
  "messages",
  "src/messages",
  "translations",
  "src/translations",
  "lang",
  "src/lang",
  "locale",
  "src/locale",
  "app/i18n",
  "static/locales",
  "config/locales",
  "app/src/main/res",
  "src/main/res",
  "res",
  ".",
];

/** Android's `values-<qualifier>` folder suffix for a locale tag: "fr" -> "fr", "pt-BR" -> "pt-rBR". */
function androidQualifier(tag: string): string {
  const l = parseLocale(tag);
  if (l.script) throw new Error(`Android resource qualifiers for scripts (got "${tag}") aren't supported; use a plain language or language-region tag.`);
  return l.region ? `${l.lang}-r${l.region}` : l.lang;
}

/** Reverse of androidQualifier: "fr" -> "fr", "pt-rBR" -> "pt-BR". Undefined for a qualifier it can't parse (script/BCP-47 "b+..." variants). */
function tagFromAndroidQualifier(qualifier: string): string | undefined {
  const m = /^([a-z]{2,3})(?:-r([A-Za-z]{2}))?$/.exec(qualifier);
  return m ? (m[2] ? `${m[1]}-${m[2].toUpperCase()}` : m[1]) : undefined;
}

const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();
const isFile = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile();

/** The source-locale file's extension, if `<root>/<from><ext>` exists for one of EXTENSIONS. */
function fileExtAt(root: string, from: string): string | undefined {
  return EXTENSIONS.find((ext) => isFile(path.join(root, `${propertiesTag(ext, from)}${ext}`)));
}

/**
 * A prefixed source-locale file, if `<root>/<prefix>_<from><ext>` exists for one of
 * EXTENSIONS — the convention `flutter gen-l10n` uses by default ("app_en.arb"), and
 * also how a Java `ResourceBundle` basename ("messages_en.properties") is found.
 */
function prefixedFileAt(root: string, from: string): { ext: string; prefix: string } | undefined {
  if (!isDir(root)) return undefined;
  for (const entry of fs.readdirSync(root)) {
    if (!isFile(path.join(root, entry))) continue;
    for (const ext of EXTENSIONS) {
      const suffix = `_${propertiesTag(ext, from)}${ext}`;
      if (entry.endsWith(suffix) && entry.length > suffix.length) {
        return { ext, prefix: entry.slice(0, -suffix.length) };
      }
    }
  }
  return undefined;
}

/** Android's default (untagged) `values/strings.xml` resource folder, if present. */
function androidLayoutAt(root: string): Layout | undefined {
  return isFile(path.join(root, "values", "strings.xml")) ? { kind: "android", root } : undefined;
}

function layoutAt(root: string, from: string): Layout | undefined {
  const dir = path.join(root, from);
  if (isDir(dir) && listLocaleFiles(dir).length > 0) return { kind: "dir", root };
  const lprojDir = path.join(root, `${from}.lproj`);
  if (isDir(lprojDir) && listLocaleFiles(lprojDir).length > 0) return { kind: "dir", root, dirSuffix: ".lproj" };
  const android = androidLayoutAt(root);
  if (android) return android;
  const ext = fileExtAt(root, from);
  if (ext) return { kind: "file", root, ext };
  const prefixed = prefixedFileAt(root, from);
  if (prefixed) return { kind: "file", root, ext: prefixed.ext, prefix: prefixed.prefix };
  return undefined;
}

const dirNameFor = (layout: Layout, tag: string) => `${tag}${layout.dirSuffix ?? ""}`;
const fileNameFor = (layout: Layout, tag: string, ext: string) =>
  `${layout.prefix ? `${layout.prefix}_` : ""}${propertiesTag(ext, tag)}${ext}`;

export function detectLayout(cwd: string, from: string, input?: string): Layout {
  if (input) {
    const abs = path.resolve(cwd, input);
    // Accept pointing at the source locale itself: --input locales/en or locales/en.json
    if (path.basename(abs) === from && isDir(abs)) return { kind: "dir", root: path.dirname(abs) };
    if (path.basename(abs) === `${from}.lproj` && isDir(abs)) {
      return { kind: "dir", root: path.dirname(abs), dirSuffix: ".lproj" };
    }
    if (path.basename(abs) === "values" && isFile(path.join(abs, "strings.xml"))) {
      return { kind: "android", root: path.dirname(abs) };
    }
    if (abs.endsWith(".xcstrings") && isFile(abs)) {
      let raw: unknown;
      try {
        raw = JSON.parse(readText(abs));
      } catch (e) {
        throw new Error(`Invalid .xcstrings (JSON) in ${input}: ${(e as Error).message}`);
      }
      const sourceLanguage = (raw as { sourceLanguage?: unknown } | null)?.sourceLanguage;
      if (typeof sourceLanguage === "string" && sourceLanguage !== from) {
        throw new Error(`${input} has sourceLanguage "${sourceLanguage}", not "${from}" — pass --from ${sourceLanguage}.`);
      }
      return { kind: "xcstrings", root: path.dirname(abs), file: abs };
    }
    if ((abs.endsWith(".xlf") || abs.endsWith(".xliff")) && isFile(abs)) {
      const t = readText(abs);
      const fileTag = /<file\b[^>]*>/.exec(t);
      if (!fileTag) throw new Error(`Invalid XLIFF in ${input}: no <file> element found.`);
      const sourceLanguage = /\bsource-language="([^"]*)"/.exec(fileTag[0])?.[1];
      if (sourceLanguage !== undefined && sourceLanguage !== from) {
        throw new Error(`${input} has source-language "${sourceLanguage}", not "${from}" — pass --from ${sourceLanguage}.`);
      }
      return { kind: "xliff", root: path.dirname(abs), file: abs, ext: abs.endsWith(".xliff") ? ".xliff" : ".xlf" };
    }
    if (abs.endsWith(".resx") && isFile(abs)) {
      return { kind: "resx", root: path.dirname(abs), file: abs, ext: ".resx" };
    }
    const base = path.basename(abs);
    const directExt = EXTENSIONS.find((ext) => base === `${propertiesTag(ext, from)}${ext}`);
    if (directExt && isFile(abs)) return { kind: "file", root: path.dirname(abs), ext: directExt };
    const prefixedExt = EXTENSIONS.find((ext) => {
      const suffix = `_${propertiesTag(ext, from)}${ext}`;
      return base.endsWith(suffix) && base.length > suffix.length;
    });
    if (prefixedExt && isFile(abs)) {
      const suffix = `_${propertiesTag(prefixedExt, from)}${prefixedExt}`;
      return { kind: "file", root: path.dirname(abs), ext: prefixedExt, prefix: base.slice(0, -suffix.length) };
    }
    const l = layoutAt(abs, from);
    if (!l) throw new Error(`No "${from}" locale found in ${input} (looked for ${from}/* and ${from}${EXTENSIONS.join("/")}).`);
    return l;
  }
  for (const c of CANDIDATES) {
    const l = layoutAt(path.resolve(cwd, c), from);
    if (l) return l;
  }
  const found = detectAlternateLocale(cwd, from);
  const hint = found ? ` Found "${found}" instead — did you mean --from ${found}?` : "";
  throw new Error(
    `Could not find "${from}" locale files. Use --input <dir> to point at the folder containing ${from}/ or ${from}${EXTENSIONS.join("/")}.${hint}`,
  );
}

/**
 * Scans the same candidate roots `detectLayout` just searched for `from`, for any OTHER
 * tag that looks like a locale and actually has content — so a non-English-source project
 * (the single most common reason this error fires) gets pointed at the right `--from`
 * instead of just being told what wasn't found.
 */
function detectAlternateLocale(cwd: string, from: string): string | undefined {
  for (const c of CANDIDATES) {
    const root = path.resolve(cwd, c);
    if (!isDir(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory()) {
        if (entry.name !== from && looksLikeLocale(entry.name) && listLocaleFiles(path.join(root, entry.name)).length > 0) {
          return entry.name;
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = EXTENSIONS.find((e) => entry.name.endsWith(e));
      if (!ext) continue;
      const tag = tagFromPropertiesQualifier(ext, entry.name.slice(0, -ext.length));
      if (tag !== from && looksLikeLocale(tag)) return tag;
    }
  }
  return undefined;
}

function listLocaleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listLocaleFiles(p));
    else if (e.isFile() && EXTENSIONS.includes(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out.sort();
}

export function sourceFiles(layout: Layout, from: string): string[] {
  if (layout.kind === "android") return [path.join(layout.root, "values", "strings.xml")];
  if (layout.kind === "xcstrings" || layout.kind === "xliff" || layout.kind === "resx") return [layout.file!];
  return layout.kind === "dir"
    ? listLocaleFiles(path.join(layout.root, dirNameFor(layout, from)))
    : [path.join(layout.root, fileNameFor(layout, from, layout.ext!))];
}

/** A translated file is a real PO, never a template, regardless of what the source was. */
const outputExt = (ext: string) => (ext === ".pot" ? ".po" : ext);

export function targetFile(layout: Layout, from: string, to: string, src: string): string {
  if (layout.kind === "android") return path.join(layout.root, `values-${androidQualifier(to)}`, "strings.xml");
  if (layout.kind === "xcstrings") return layout.file!;
  if (layout.kind === "xliff" || layout.kind === "resx") {
    return path.join(layout.root, `${path.basename(layout.file!, layout.ext!)}.${to}${layout.ext!}`);
  }
  if (layout.kind === "file") return path.join(layout.root, fileNameFor(layout, to, outputExt(layout.ext!)));
  const rel = path.relative(path.join(layout.root, dirNameFor(layout, from)), src);
  const ext = path.extname(rel);
  return path.join(layout.root, dirNameFor(layout, to), ext === ".pot" ? `${rel.slice(0, -ext.length)}.po` : rel);
}

/** True when `tag` parses as a locale (e.g. "fr", "pt-BR") — rejects names like "__mocks__" or "schemas". */
function looksLikeLocale(tag: string): boolean {
  try {
    parseLocale(tag);
    return true;
  } catch {
    return false;
  }
}

/** Locale tags already translated alongside `from` in this layout (for `locale-ai check`). */
export function existingTargets(layout: Layout, from: string): string[] {
  if (layout.kind === "xcstrings") {
    let raw: unknown;
    try {
      raw = JSON.parse(readText(layout.file!));
    } catch {
      return [];
    }
    const strings = isObj(raw) && isObj((raw as Obj).strings) ? ((raw as Obj).strings as Obj) : {};
    const tags = new Set<string>();
    for (const entry of Object.values(strings)) {
      if (!isObj(entry) || !isObj(entry.localizations)) continue;
      for (const tag of Object.keys(entry.localizations as Obj)) tags.add(tag);
    }
    tags.delete(from);
    return [...tags].filter(looksLikeLocale).sort();
  }
  if (layout.kind === "xliff" || layout.kind === "resx") {
    const base = path.basename(layout.file!, layout.ext!);
    const prefix = `${base}.`;
    const ext = layout.ext!;
    return fs
      .readdirSync(layout.root)
      .filter((f) => f.startsWith(prefix) && f.endsWith(ext) && f.length > prefix.length + ext.length)
      .map((f) => f.slice(prefix.length, -ext.length))
      .filter((tag) => tag !== from && looksLikeLocale(tag))
      .sort();
  }
  if (layout.kind === "android") {
    return fs
      .readdirSync(layout.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^values-/.test(e.name) && isFile(path.join(layout.root, e.name, "strings.xml")))
      .map((e) => tagFromAndroidQualifier(e.name.slice("values-".length)))
      .filter((tag): tag is string => tag !== undefined && tag !== from)
      .sort();
  }
  if (layout.kind === "file") {
    const ext = layout.ext!;
    const prefix = layout.prefix ? `${layout.prefix}_` : "";
    return fs
      .readdirSync(layout.root)
      .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
      .map((f) => tagFromPropertiesQualifier(ext, f.slice(prefix.length, -ext.length)))
      .filter((tag) => tag !== from && looksLikeLocale(tag))
      .sort();
  }
  const suffix = layout.dirSuffix ?? "";
  return fs
    .readdirSync(layout.root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name.endsWith(suffix))
    .map((e) => (suffix ? e.name.slice(0, -suffix.length) : e.name))
    .filter((name) => name !== from)
    .filter(looksLikeLocale)
    .filter((name) => listLocaleFiles(path.join(layout.root, dirNameFor(layout, name))).length > 0)
    .sort();
}

/**
 * Decodes a locale file's raw bytes to text, detecting a UTF-16 BOM first — Xcode's
 * traditional default for `.strings` files, which `fs.readFileSync(file, "utf8")`
 * would otherwise mangle into unreadable text (and then "no entries found").
 */
function readText(file: string): string {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8").replace(/^﻿/, "");
}

/**
 * `tag` is the locale this file is for (the source tag, or an existing target's own
 * tag). `isSource` marks this as the FROM-locale file being read as the thing to
 * translate (as opposed to an already-existing target) — only then does a `.po`
 * entry's empty `msgstr` fall back to `msgid` as the source text (see readPoDoc).
 * `fuzzy`, for `.po`/`.pot` only, marks every entry this run actually (re)translated
 * with gettext's standard `#, fuzzy` "needs review" flag.
 */
export function readLocaleDoc(file: string, tag: string, isSource = false, fuzzy = false): LocaleDoc {
  const text = readText(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return readYamlDoc(file, text, tag);
  if (ext === ".po" || ext === ".pot") return readPoDoc(file, text, isSource, fuzzy);
  if (ext === ".arb") return readArbDoc(file, text);
  if (ext === ".strings") return readStringsDoc(file, text);
  if (ext === ".properties") return readPropertiesDoc(file, text);
  if (ext === ".xml") return readAndroidXmlDoc(file, text);
  if (ext === ".xcstrings") return readXcstringsDoc(file, text, tag, isSource);
  if (ext === ".xlf" || ext === ".xliff") return readXliffDoc(file, text, isSource);
  if (ext === ".resx") return readResxDoc(file, text);
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts") return readJsModuleDoc(file, text);
  return readJsonDoc(file, text);
}

/**
 * A string needs translating when the target has no non-empty string at the same
 * path — unless the source itself is empty, in which case an empty target already
 * matches it exactly. Without that exception, a legitimately blank source string
 * (`""`) could never be marked done: its target is also always `""`, so every
 * run would re-"translate" it forever, violating the "re-runs are a no-op"
 * guarantee (silently, since there's nothing to actually write either way).
 */
const needsTranslation = (existing: unknown, source: string, overwrite: boolean) =>
  overwrite || typeof existing !== "string" || (existing === "" && source !== "");

/** Flattens a locale tree into key-path -> string-value pairs (for `locale-ai check`). */
export function flattenStrings(
  data: unknown,
  prefix = "",
  out: Array<{ path: string; value: string }> = [],
): Array<{ path: string; value: string }> {
  if (typeof data === "string") out.push({ path: prefix || "(root)", value: data });
  else if (Array.isArray(data)) data.forEach((v, i) => flattenStrings(v, `${prefix}[${i}]`, out));
  else if (isObj(data)) for (const k of Object.keys(data)) flattenStrings(data[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/**
 * True when `path` is, or is nested under, one of `doNotTranslateKeys` — the same
 * dot/`[i]` notation flattenStrings produces (e.g. "brand.name", "config.statusEnum").
 * Protecting a path that points at an object or array protects every string nested
 * under it too, which is what makes an enum array ("statusEnum": ["ACTIVE", ...])
 * protectable without enumerating each value as a doNotTranslate term.
 */
export function keyPathProtect(doNotTranslateKeys: string[] | undefined): ((path: string) => boolean) | undefined {
  const keys = (doNotTranslateKeys ?? []).filter(Boolean);
  if (!keys.length) return undefined;
  return (path: string) => keys.some((k) => path === k || path.startsWith(`${k}.`) || path.startsWith(`${k}[`));
}

/** A leaf string that needs (re)translation this run, with its key path. */
export interface PendingEntry {
  path: string;
  value: string;
}

/**
 * Walks `source` against `existing`, collecting every leaf string that needs
 * (re)translation this run: not protected, and either not-yet-translated (or
 * overwrite-forced) or stale. Also the key paths `buildTarget` will call
 * `translate` for, given the same inputs — used to limit lock-file updates to
 * paths actually (re)translated this run, so a path left untouched (already
 * translated, not stale) never has its recorded "last written" hash
 * overwritten with text buildTarget didn't itself write — which is what let a
 * translator's hand edit be silently adopted as this tool's own baseline on a
 * prior run. One shared walk for both needs, rather than running it twice.
 */
export function pendingEntries(
  source: unknown,
  existing: unknown,
  overwrite: boolean,
  isProtected?: (path: string) => boolean,
  isStale?: (path: string, source: string) => boolean,
): PendingEntry[] {
  const out: PendingEntry[] = [];
  const visit = (s: unknown, e: unknown, path: string): void => {
    if (typeof s === "string") {
      if (!isProtected?.(path) && (needsTranslation(e, s, overwrite) || !!isStale?.(path, s))) out.push({ path, value: s });
    } else if (Array.isArray(s)) {
      s.forEach((v, i) => visit(v, Array.isArray(e) ? e[i] : undefined, `${path}[${i}]`));
    } else if (isObj(s)) {
      for (const k of Object.keys(s)) visit(s[k], isObj(e) ? e[k] : undefined, path ? `${path}.${k}` : k);
    }
  };
  visit(source, existing, "");
  return out;
}

/** Just the values from {@link pendingEntries} — the strings sent to the translator. */
export function pendingStrings(
  source: unknown,
  existing: unknown,
  overwrite: boolean,
  isProtected?: (path: string) => boolean,
  isStale?: (path: string, source: string) => boolean,
): string[] {
  return pendingEntries(source, existing, overwrite, isProtected, isStale).map((e) => e.value);
}

/**
 * Builds the target document: source structure and key order, existing
 * translations kept (unless overwrite or stale), new strings from `translate`,
 * and keys that only exist in the target preserved at the end. A string at a
 * protected path (see keyPathProtect) is always copied from the source
 * verbatim. `isStale` (see the lock module) forces re-translation of a
 * non-empty target when its source string has changed since it was last
 * translated.
 */
export function buildTarget(
  source: unknown,
  existing: unknown,
  translate: (s: string) => string,
  overwrite: boolean,
  isProtected?: (path: string) => boolean,
  isStale?: (path: string, source: string) => boolean,
): unknown {
  const visit = (s: unknown, e: unknown, path: string): unknown => {
    if (typeof s === "string") {
      if (isProtected?.(path)) return s;
      return needsTranslation(e, s, overwrite) || isStale?.(path, s) ? translate(s) : e;
    }
    if (Array.isArray(s)) return s.map((v, i) => visit(v, Array.isArray(e) ? e[i] : undefined, `${path}[${i}]`));
    if (isObj(s)) {
      const out = newObj();
      for (const k of Object.keys(s)) out[k] = visit(s[k], isObj(e) ? e[k] : undefined, path ? `${path}.${k}` : k);
      if (isObj(e)) for (const k of Object.keys(e)) if (!(k in out)) out[k] = e[k];
      return out;
    }
    return s;
  };
  return visit(source, existing, "");
}

const PLURAL_KEY = /^(.+?)(_ordinal)?_(zero|one|two|few|many|other)$/;

/**
 * Source strings at a cardinal i18next "_one" plural key ("itemCount_one": "{{count}}
 * item"). These are grammatically singular in English, but the model sometimes infers
 * the TARGET's plural form anyway because {{count}} reads as an opaque marker rather
 * than a concrete number — the engine uses this set to retranslate with a real "1" in
 * place of {{count}} and recover the correct grammatical number (see engine.ts).
 */
export function pluralOneStrings(data: unknown, out: Set<string> = new Set()): Set<string> {
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (!isObj(v)) return;
    for (const k of Object.keys(v)) {
      const m = PLURAL_KEY.exec(k);
      if (m && !m[2] && m[3] === "one" && typeof v[k] === "string") out.add(v[k] as string);
      visit(v[k]);
    }
  };
  visit(data);
  return out;
}

/**
 * True for the file extensions that use i18next's `key_one`/`key_other` plural-key
 * convention (flat JSON/YAML locale trees). A `.po`, `.arb` or `.strings` file might
 * happen to have a key ending the same way without meaning it as an i18next plural,
 * so addPluralForms should only ever run on these.
 */
export function usesI18nextPlurals(file: string): boolean {
  return /\.(json|ya?ml)$/i.test(file);
}

/**
 * i18next stores plurals as `key_one` / `key_other`. Languages such as Arabic,
 * Russian or Polish need more forms (`_few`, `_many` ...) and i18next does not fall
 * back to `_other` for them, so missing forms are added with the `_other` text.
 * Returns the new document and the number of keys added.
 */
/** Passed by the caller so plural-category sync can tell a stale-and-retranslated
 * "other" apart from an unchanged one, and a hand edit apart from this tool's own
 * previous output — the same distinctions every other key gets, via the lock. */
export interface PluralSyncOptions {
  /** True when this exact path (a group's "other"/wrapper sibling) was (re)translated
   * this run — its derived zero/two/few/many siblings should resync from the new value
   * instead of being left as whatever they were before. */
  otherStale?: (path: string) => boolean;
  /** True when the current on-disk value at this derived path doesn't match what the
   * lock last recorded there — a hand edit that must never be silently overwritten. */
  isEdited?: (path: string, value: string) => boolean;
  /** True when this exact category path is itself a real source key (always "one" and
   * "other" for i18next — a language with a 2-category source already translates both
   * independently; everything else here only ever exists because this function derived
   * it). Such a category is never resynced or edit-tracked by this pass — it's the normal
   * translation pipeline's, not this function's, the same as it always was. */
  hasSource?: (path: string) => boolean;
}

export interface PluralSyncResult {
  doc: unknown;
  /** Count of category keys created because they didn't exist at all before. */
  added: number;
  /** Every derived (newly added or just resynced) category path this pass, with the
   * "other" text it now holds — record a lock entry for each so later runs can tell a
   * hand edit or a source change apart for these too, the same as any other key. */
  derived: Array<{ path: string; value: string }>;
  /** Derived category paths whose current text is a hand edit this pass found but did
   * not overwrite — `conflict` when the "other" it's derived from also changed this run
   * (both a source change and a hand edit, same meaning as elsewhere), `edited` otherwise. */
  edited: Array<{ path: string; conflict: boolean }>;
}

export function addPluralForms(doc: unknown, targetLang: string, opts: PluralSyncOptions = {}): PluralSyncResult {
  let added = 0;
  const derived: Array<{ path: string; value: string }> = [];
  const edited: Array<{ path: string; conflict: boolean }> = [];
  const visit = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => visit(x, `${path}[${i}]`));
    if (!isObj(v)) return v;
    const keys = Object.keys(v);
    const groups = new Map<string, { cats: Map<string, string>; last: string; ordinal: boolean }>();
    for (const k of keys) {
      const m = PLURAL_KEY.exec(k);
      if (!m || typeof v[k] !== "string") continue;
      const id = m[1] + (m[2] ?? "");
      const g = groups.get(id) ?? { cats: new Map(), last: k, ordinal: !!m[2] };
      g.cats.set(m[3], k);
      g.last = k;
      groups.set(id, g);
    }
    // Qualifying groups are written contiguously in canonical order at the
    // position of their first key, so re-runs produce byte-identical files.
    const groupOf = new Map<string, string>();
    const needed = new Map<string, string[]>();
    for (const [id, g] of groups) {
      if (!g.cats.has("other") || g.cats.size < 2) continue;
      try {
        needed.set(
          id,
          new Intl.PluralRules(targetLang, { type: g.ordinal ? "ordinal" : "cardinal" }).resolvedOptions()
            .pluralCategories as string[],
        );
      } catch {
        continue;
      }
      for (const k of g.cats.values()) groupOf.set(k, id);
    }
    const out = newObj();
    const emitted = new Set<string>();
    for (const k of keys) {
      const id = groupOf.get(k);
      if (id === undefined) {
        out[k] = visit(v[k], path ? `${path}.${k}` : k);
        continue;
      }
      if (emitted.has(id)) continue;
      emitted.add(id);
      const g = groups.get(id)!;
      const otherKey = g.cats.get("other")!;
      const other = v[otherKey] as string;
      const otherPath = path ? `${path}.${otherKey}` : otherKey;
      const refresh = opts.otherStale?.(otherPath) ?? false;
      for (const cat of CATEGORIES) {
        const existing = g.cats.get(cat);
        if (existing) {
          out[existing] = v[existing];
          const existingPath = path ? `${path}.${existing}` : existing;
          if (cat === "other" || opts.hasSource?.(existingPath)) continue;
          const current = v[existing] as string;
          if (opts.isEdited?.(existingPath, current)) {
            edited.push({ path: existingPath, conflict: refresh });
            continue; // never silently overwrite a hand edit, flagged either way
          }
          if (!refresh || current === other) continue;
          out[existing] = other;
          derived.push({ path: existingPath, value: other });
        } else if (needed.get(id)!.includes(cat)) {
          const newKey = `${id}_${cat}`;
          out[newKey] = other;
          added++;
          derived.push({ path: path ? `${path}.${newKey}` : newKey, value: other });
        }
      }
    }
    return out;
  };
  return { doc: visit(doc, ""), added, derived, edited };
}

/**
 * Rails and some other frameworks nest plural forms under the key itself
 * (`item:\n  one: "%{count} item"\n  other: "%{count} items"`) instead of i18next's
 * `item_one`/`item_other` suffix convention. A value is treated as a plural group
 * when every one of its keys is a CLDR plural category and "other" (the mandatory
 * fallback) is among them and there's at least one more alongside it — a single
 * `{ other: "..." }` object is too common as an ordinary translation value (e.g. a
 * key literally named "other") to treat as a plural group on its own.
 */
export function addNestedPluralForms(doc: unknown, targetLang: string, opts: PluralSyncOptions = {}): PluralSyncResult {
  let added = 0;
  const derived: Array<{ path: string; value: string }> = [];
  const edited: Array<{ path: string; conflict: boolean }> = [];
  const visit = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => visit(x, `${path}[${i}]`));
    if (!isObj(v)) return v;
    const keys = Object.keys(v);
    const isGroup =
      keys.length >= 2 && keys.includes("other") && keys.every((k) => CATEGORIES.includes(k) && typeof v[k] === "string");
    if (!isGroup) {
      const out = newObj();
      for (const k of keys) out[k] = visit(v[k], path ? `${path}.${k}` : k);
      return out;
    }
    let needed: string[];
    try {
      needed = new Intl.PluralRules(targetLang).resolvedOptions().pluralCategories as string[];
    } catch {
      needed = keys;
    }
    const other = v.other as string;
    const otherPath = path ? `${path}.other` : "other";
    const refresh = opts.otherStale?.(otherPath) ?? false;
    const out = newObj();
    for (const cat of CATEGORIES) {
      if (keys.includes(cat)) {
        out[cat] = v[cat];
        const catPath = path ? `${path}.${cat}` : cat;
        if (cat === "other" || opts.hasSource?.(catPath)) continue;
        const current = v[cat] as string;
        if (opts.isEdited?.(catPath, current)) {
          edited.push({ path: catPath, conflict: refresh });
          continue;
        }
        if (!refresh || current === other) continue;
        out[cat] = other;
        derived.push({ path: catPath, value: other });
      } else if (needed.includes(cat)) {
        out[cat] = other;
        added++;
        derived.push({ path: path ? `${path}.${cat}` : cat, value: other });
      }
    }
    return out;
  };
  return { doc: visit(doc, ""), added, derived, edited };
}

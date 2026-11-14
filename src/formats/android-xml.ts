import { CATEGORIES, finalNewline, isObj, type LocaleDoc, newObj, type Obj, withNewline } from "./shared.ts";
import { XML_TAG_RE } from "./xml.ts";

/**
 * Android's `&entity;` plus its own backslash escapes (`\'`, `\"`, `\n`, `\t`, `\@`,
 * `\?`, `\uXXXX`) and `<![CDATA[...]]>`. `\uXXXX` is decoded to the real character
 * first — a generic "drop the backslash, keep the next char" pass would otherwise
 * turn `Loading…` into the literal text `Loadingu2026`, backslash and all gone,
 * rather than "Loading…".
 */
function unescapeAndroidXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(.)/g, (_m, c: string) => ({ n: "\n", t: "\t" })[c] ?? c);
}
function escapeAndroidXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

/**
 * Like `escapeXmlKeepTags` (xml.ts, reused here), but applying Android's own escaping
 * to the text runs in between — so a value's own real inline markup (Android's
 * widely-used `<xliff:g id="time">%1$s</xliff:g>` placeholder-wrapper tag, same shape
 * as any other tag placeholders.ts protects) survives a write as actual XML instead
 * of coming out HTML-escaped and visible as literal text on screen.
 *
 * A value that starts with a literal `@` or `?` must be re-escaped there (`\@`/`\?`),
 * never written out plain — aapt2 parses an unescaped leading `@`/`?` as a resource or
 * style reference and fails the build, even though it round-trips fine as plain text
 * through everything else in this module.
 */
function escapeAndroidXmlKeepTags(s: string): string {
  const lead = s[0] === "@" || s[0] === "?" ? `\\${s[0]}` : "";
  s = lead ? s.slice(1) : s;
  let out = lead;
  let last = 0;
  for (const m of s.matchAll(XML_TAG_RE)) {
    out += escapeAndroidXml(s.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + escapeAndroidXml(s.slice(last));
}

/** A value that's purely an Android resource reference (`@string/app_name`, `@plurals/x`, ...) — never user-facing text, so never sent to the model. */
const ANDROID_REF_RE = /^@[a-zA-Z_][\w.]*\/[\w.]+$/;

interface AndroidEntry {
  comment?: string;
  name: string;
  translatable: boolean;
  kind: "string" | "array" | "plural";
  /** For kind "string" only: the value was wrapped in a literal `"..."` pair in the source, which Android uses to preserve leading/trailing whitespace that would otherwise be trimmed — kept on write. */
  quoted?: boolean;
}

/**
 * Android `strings.xml`: `<string>`/`<string-array>`/`<plurals>` elements under a
 * single `<resources>` root, each optionally preceded by an `<!-- ... -->` translator
 * comment and marked `translatable="false"` for text that must stay verbatim (an app ID,
 * a format string nobody localizes). A `<plurals>` element's `quantity="one|other|..."`
 * items become a nested one/other/... object — the same shape Rails-style nested
 * plurals use, so `addNestedPluralForms` fills in whatever categories the target
 * language needs with zero format-specific code.
 *
 * Three Android-specific conventions beyond plain XML: inline markup inside a value —
 * most commonly `<xliff:g id="...">...</xliff:g>`, Android's own placeholder-wrapper
 * tag — is read and written as literal, untouched XML rather than HTML-escaped into
 * visible text, the same `escapeXmlKeepTags` treatment XLIFF's own inline `<x>`/`<g>`
 * markup gets. A value that's purely a reference to another resource (`@string/app_name`)
 * is never translatable, regardless of its own `translatable` attribute. A `<string>`
 * value entirely wrapped in a literal `"..."` pair is Android's own convention for
 * preserving leading/trailing whitespace the XML parser would otherwise trim — the
 * quotes are kept (and reapplied around the translated text) rather than treated as
 * ordinary characters.
 *
 * This is a simpler round-trip than YAML/.po/.strings: comments are kept from the
 * source on first write, but a rerun regenerates the whole file from `data` rather
 * than editing an existing target in place (so a translator's own XML comment edits in
 * an already-translated file won't survive a rerun) — the same level of fidelity ARB
 * already has in this project.
 */
/**
 * A `<!-- ... -->` block directly followed by a real `<string>`/`<string-array>`/`<plurals>`
 * tag is captured by `elementRe` below as that element's own translator comment — but one
 * NOT followed by a real tag (a standalone note, or several comments stacked together) isn't,
 * and the regex would otherwise keep scanning character by character into the comment's own
 * text and match any `<string ...>...</string>`-shaped text inside it as if it were live
 * content. Blanking out (same length, newlines kept so later indent detection is unaffected)
 * every comment that isn't immediately attached to a following element closes that gap.
 */
function blankOrphanComments(body: string): string {
  let out = body;
  for (const m of body.matchAll(/<!--[\s\S]*?-->/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (/^\s*\r?\n\s*<(?:string-array|string|plurals)\b/.test(body.slice(end))) continue;
    out = out.slice(0, start) + m[0].replace(/[^\n\r]/g, " ") + out.slice(end);
  }
  return out;
}

export function readAndroidXmlDoc(file: string, text: string): LocaleDoc {
  const openMatch = /<resources\b[^>]*>/.exec(text);
  const closeMatch = /<\/resources>/.exec(text);
  if (!openMatch || !closeMatch) throw new Error(`Invalid Android strings.xml in ${file}: missing a <resources> element.`);
  const before = text.slice(0, openMatch.index + openMatch[0].length);
  const after = text.slice(closeMatch.index);
  const rawBody = text.slice(openMatch.index + openMatch[0].length, closeMatch.index);
  const body = blankOrphanComments(rawBody);

  const data = newObj();
  const entries: AndroidEntry[] = [];
  const elementRe = /(?:(<!--[\s\S]*?-->)\s*\r?\n\s*)?<(string-array|string|plurals)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\2>)/g;
  for (const m of body.matchAll(elementRe)) {
    const [, comment, tag, attrsRaw, inner] = m;
    const nameMatch = /\bname="([^"]*)"/.exec(attrsRaw);
    if (!nameMatch) continue;
    const name = unescapeAndroidXml(nameMatch[1]);
    const translatable = !/\btranslatable\s*=\s*["']false["']/.test(attrsRaw);
    if (tag === "string") {
      const trimmed = (inner ?? "").trim();
      const quoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
      const value = unescapeAndroidXml(quoted ? trimmed.slice(1, -1) : trimmed);
      const isRef = ANDROID_REF_RE.test(value);
      entries.push({ comment, name, translatable: translatable && !isRef, kind: "string", quoted });
      if (translatable && !isRef) data[name] = value;
    } else if (tag === "string-array") {
      entries.push({ comment, name, translatable, kind: "array" });
      const items = [...(inner ?? "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map((im) => unescapeAndroidXml(im[1].trim()));
      if (translatable) data[name] = items;
    } else {
      entries.push({ comment, name, translatable, kind: "plural" });
      if (translatable) {
        const plural = newObj();
        for (const im of (inner ?? "").matchAll(/<item\s+quantity="(\w+)"[^>]*>([\s\S]*?)<\/item>/g)) {
          plural[im[1]] = unescapeAndroidXml(im[2].trim());
        }
        data[name] = plural;
      }
    }
  }
  if (entries.length === 0 && body.trim() !== "") {
    throw new Error(`No <string>/<string-array>/<plurals> entries found in ${file}`);
  }
  const indent = /\r?\n([ \t]+)</.exec(body)?.[1] ?? "    ";
  const keepNewline = finalNewline(text);
  const raw = newObj();
  for (const m of body.matchAll(elementRe)) raw[/\bname="([^"]*)"/.exec(m[3])![1]] = m[0];

  const serialize = (d: unknown): string => {
    const obj = isObj(d) ? d : newObj();
    const blocks: string[] = [];
    for (const e of entries) {
      const attr = e.translatable ? "" : ' translatable="false"';
      let tag: string;
      if (!e.translatable) {
        tag = (raw[e.name] as string).replace(/^<!--[\s\S]*?-->\s*\r?\n\s*/, "");
      } else if (e.kind === "string") {
        const v = typeof obj[e.name] === "string" ? (obj[e.name] as string) : "";
        const escaped = escapeAndroidXmlKeepTags(v);
        tag = `<string name="${escapeAndroidXml(e.name)}"${attr}>${e.quoted ? `"${escaped}"` : escaped}</string>`;
      } else if (e.kind === "array") {
        const items = Array.isArray(obj[e.name]) ? (obj[e.name] as unknown[]) : [];
        const lines = items.map((v) => `${indent}${indent}<item>${escapeAndroidXmlKeepTags(typeof v === "string" ? v : "")}</item>`);
        tag = `<string-array name="${escapeAndroidXml(e.name)}"${attr}>\n${lines.join("\n")}\n${indent}</string-array>`;
      } else {
        const plural = isObj(obj[e.name]) ? (obj[e.name] as Obj) : newObj();
        const lines = CATEGORIES.filter((c) => typeof plural[c] === "string").map(
          (c) => `${indent}${indent}<item quantity="${c}">${escapeAndroidXmlKeepTags(plural[c] as string)}</item>`,
        );
        tag = `<plurals name="${escapeAndroidXml(e.name)}"${attr}>\n${lines.join("\n")}\n${indent}</plurals>`;
      }
      blocks.push(e.comment ? `${indent}${e.comment}\n${indent}${tag}` : `${indent}${tag}`);
    }
    return withNewline(`${before}\n${blocks.join("\n")}\n${after}`, keepNewline);
  };
  return { data, serialize };
}

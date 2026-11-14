import { finalNewline, isObj, type LocaleDoc, newObj, withNewline } from "./shared.ts";
import { escapeXmlKeepTags, setXmlAttr, unescapeXml } from "./xml.ts";

interface XliffUnit {
  id: string;
  translatable: boolean;
  sourceInner: string;
  targetInner?: string;
  /** Raw text of the matched `<target ...>...</target>` element, attributes included — spliced out wholesale on serialize. Undefined when the unit has no `<target>` yet (first translation). */
  targetWhole?: string;
  /** The full, untouched `<trans-unit ...>...</trans-unit>` text — every other child (`<context-group>`, `<alt-trans>`, `<note>`, anything else XLIFF allows there) rides along in this unchanged, since only the `<target>` span within it is ever replaced. */
  whole: string;
  /** The opening `<trans-unit>` tag's own indent, so a newly inserted `<target>` (no prior translation) matches its actual nesting depth, not a single document-wide guess. */
  indent: string;
}
type XliffSegment = { text: string } | { unit: number };

/** Splits XLIFF text into literal passthrough segments and parsed `<trans-unit>` entries, ignoring the surrounding `<file>`/`<body>`/`<group>` nesting (it's never rewritten, just reproduced). */
function parseXliffUnits(text: string): { segments: XliffSegment[]; units: XliffUnit[] } {
  const unitRe = /<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/g;
  const segments: XliffSegment[] = [];
  const units: XliffUnit[] = [];
  let last = 0;
  for (const m of text.matchAll(unitRe)) {
    const before = text.slice(last, m.index);
    segments.push({ text: before });
    const [whole, attrsRaw, inner] = m;
    const idMatch = /\bid="([^"]*)"/.exec(attrsRaw);
    const sourceMatch = /<source\b[^>]*>([\s\S]*?)<\/source>/.exec(inner);
    if (!idMatch || !sourceMatch) {
      segments.push({ text: whole });
    } else {
      // A self-closing `<target/>` (some CAT tools emit one as a placeholder before any
      // translation exists) must still be captured as `targetWhole` — matched only by the
      // alternative with no capture group, so `targetInner` stays undefined — or serialize
      // below has no span to replace in place and inserts a second, duplicate `<target>`.
      const targetMatch = /<target\b[^>]*\/>|<target\b[^>]*>([\s\S]*?)<\/target>/.exec(inner);
      const translatable = !/\btranslate\s*=\s*["']no["']/.test(attrsRaw) && !/<(?:bpt|ept)\b/.test(sourceMatch[1]);
      const lineIndent = /[ \t]*$/.exec(before)![0];
      units.push({
        id: unescapeXml(idMatch[1]),
        translatable,
        sourceInner: sourceMatch[1],
        targetInner: targetMatch?.[1],
        targetWhole: targetMatch?.[0],
        whole,
        indent: before.includes("\n") ? lineIndent : "",
      });
      segments.push({ unit: units.length - 1 });
    }
    last = m.index! + whole.length;
  }
  segments.push({ text: text.slice(last) });
  return { segments, units };
}

/**
 * XLIFF 1.2 (`<xliff version="1.2">`, the default for Qt Linguist, Angular's
 * `ng extract-i18n`, and most CAT tools): each `<trans-unit id="...">` holds a
 * `<source>` (always present) and a `<target>` (present once translated). A unit's
 * inline markup — Angular's `<x id="INTERPOLATION" .../>`, or a generic `<g id="1">
 * ... </g>` — is carried through to translation as literal text rather than stripped:
 * it's exactly the shape `placeholders.ts` already protects for HTML-ish i18n values
 * (`<b>`, `<Trans/>`), so it survives untouched with zero extra code. `translate="no"`
 * units, and the rarer `<bpt>`/`<ept>` paired-tag markup (a different, non-nesting
 * convention XLIFF also allows but modern tools rarely emit), are left completely
 * untouched instead.
 *
 * Unlike Android/ARB/`.xcstrings` (which regenerate the whole entry from the source
 * every run), only the `<target>` element itself is ever replaced — every other child
 * a `<trans-unit>` can have (`<note>`, `<context-group>` recording where the string is
 * used in the app's own source, `<alt-trans>`, ...) rides through completely untouched,
 * in its original position, since the rest of the unit's text is never regenerated. If
 * the target text itself hasn't changed, the `<target>` element isn't touched either —
 * a CAT tool's own `state="final"`/`state="needs-review"` attribute survives a run that
 * didn't retranslate that string. Only an actual retranslation replaces it with a fresh,
 * attribute-less `<target>`.
 *
 * Only reached via `--input <file>.xlf`/`.xliff`: the source file's name carries no
 * locale tag at all (XLIFF puts it in `source-language` instead), so there's no
 * filename convention to auto-detect from.
 */
export function readXliffDoc(file: string, text: string, isSource: boolean): LocaleDoc {
  // XLIFF 2.0 restructured the format entirely — a translatable unit is <unit><segment>
  // <source>/<target></segment></unit>, not a <trans-unit> with <source>/<target> as its
  // direct children, and the file-level language attribute is trgLang, not target-language.
  // parseXliffUnits below only recognizes the 1.2 shape, so a 2.0 file silently matches zero
  // units: translate reports success with 0 strings translated, writes an untouched copy,
  // and sets a target-language attribute that 2.0 tooling doesn't read at all. Caught here
  // instead, with a clear error, rather than passing all of that through as if it worked.
  const versionMatch = /<xliff\b[^>]*\bversion="(\d+)\.\d+"/.exec(text);
  if (versionMatch && versionMatch[1] !== "1") {
    throw new Error(`Invalid XLIFF in ${file}: only XLIFF 1.2 is supported (found version ${versionMatch[1]}.x).`);
  }
  if (!/<file\b[^>]*>/.test(text)) throw new Error(`Invalid XLIFF in ${file}: no <file> element found.`);
  const { segments, units } = parseXliffUnits(text);
  const data = newObj();
  for (const u of units) {
    if (!u.translatable) continue;
    const v = isSource ? u.sourceInner : u.targetInner;
    if (v !== undefined) data[u.id] = unescapeXml(v);
  }
  const step = /\r?\n([ \t]+)</.exec(text)?.[1] ?? "    ";
  const keepNewline = finalNewline(text);
  const serialize = (d: unknown, targetTag: string): string => {
    const obj = isObj(d) ? d : newObj();
    let patchedFileTag = false;
    const parts = segments.map((seg) => {
      if ("text" in seg) {
        if (!patchedFileTag && /<file\b[^>]*>/.test(seg.text)) {
          patchedFileTag = true;
          return seg.text.replace(/<file\b[^>]*>/, (tag) => setXmlAttr(tag, "target-language", targetTag));
        }
        return seg.text;
      }
      const u = units[seg.unit];
      if (!u.translatable) return u.whole;
      const v = typeof obj[u.id] === "string" ? (obj[u.id] as string) : "";
      if (u.targetWhole !== undefined && u.targetInner !== undefined && unescapeXml(u.targetInner) === v) {
        // Text unchanged: leave the <target> element exactly as it is, attributes included
        // (a CAT tool's own state="final"/"needs-review" survives a run that translated nothing).
        return u.whole;
      }
      const newTarget = `<target>${escapeXmlKeepTags(v)}</target>`;
      if (u.targetWhole) return u.whole.replace(u.targetWhole, newTarget);
      // No <target> yet (first translation): insert one right after </source>, at <source>'s own indent.
      return u.whole.replace(/<\/source>/, (m) => `${m}\n${u.indent + step}${newTarget}`);
    });
    return withNewline(parts.join(""), keepNewline);
  };
  return { data, serialize };
}

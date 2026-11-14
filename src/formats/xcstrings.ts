import { CATEGORIES, finalNewline, isObj, type LocaleDoc, newObj, type Obj, withNewline } from "./shared.ts";

/** True when `entry` uses a per-device variant (`variations.iphone`/`.ipad`/...) for `tag`, not just a plural. */
function xcstringsHasDeviceVariant(entry: Obj): boolean {
  const locs = entry.localizations;
  if (!isObj(locs)) return false;
  return Object.values(locs).some(
    (loc) => isObj(loc) && isObj(loc.variations) && Object.keys(loc.variations as Obj).some((k) => k !== "plural"),
  );
}

/** `shouldTranslate: false`, multi-variable `substitutions`, or any per-device variant — left untouched. */
function xcstringsSkip(entry: unknown): boolean {
  return !isObj(entry) || entry.shouldTranslate === false || entry.substitutions !== undefined || xcstringsHasDeviceVariant(entry);
}

/**
 * `JSON.stringify`'s pretty-printer writes `"key": value`; Xcode's own serializer
 * writes `"key" : value` (a space before the colon too), so every entry this tool
 * touches — and, since whitespace is otherwise preserved byte-for-byte, every entry
 * it DOESN'T touch too, once the rest of the file is rewritten around it — showed up
 * in the diff on every single run, translated or not. A pretty-printed key is always
 * the first non-whitespace token on its own line, immediately followed by `:` (a
 * string VALUE at the start of its own line, inside an array, never has a trailing
 * colon) — safe to match and space without touching anything inside a string's own
 * text.
 */
function xcodeColonSpacing(s: string): string {
  return s.replace(/^(\s*"(?:[^"\\]|\\.)*")(:)/gm, "$1 $2");
}

/** An entry's value for one locale: a plain string, a `{zero,one,...}` plural object, or undefined if untranslated. */
function xcstringsValue(entry: Obj, tag: string): unknown {
  const loc = (entry.localizations as Obj | undefined)?.[tag] as Obj | undefined;
  if (!loc) return undefined;
  const plural = (loc.variations as Obj | undefined)?.plural as Obj | undefined;
  if (plural) {
    const out = newObj();
    for (const cat of CATEGORIES) {
      const v = ((plural[cat] as Obj | undefined)?.stringUnit as Obj | undefined)?.value;
      if (typeof v === "string") out[cat] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  const v = (loc.stringUnit as Obj | undefined)?.value;
  return typeof v === "string" ? v : undefined;
}

/**
 * Apple's `.xcstrings` String Catalog (Xcode 15+'s default, replacing `.strings`):
 * unlike every other format here, ALL locales — source included — live in ONE JSON
 * file, keyed by the string's own identifier under `strings`. Each entry's
 * `localizations.<tag>` holds either a plain `stringUnit` or, for a plural string, a
 * `variations.plural` object whose zero/one/two/few/many/other categories are exactly
 * the shape `addNestedPluralForms` already understands (see Android/Rails), so it's
 * reused unchanged. An entry with no `localizations.<sourceLanguage>` at all falls
 * back to its own key as the source text, matching Xcode's own convention for a
 * string that was never given explicit source content.
 *
 * `shouldTranslate: false`, Xcode's per-device variants (`variations.iphone`/`.ipad`),
 * and multi-variable strings (`substitutions`, used with `%#@name@`-style format
 * references) are all left completely untouched rather than mistranslated — a bigger
 * matrix than a single cardinal plural isn't supported yet.
 *
 * `targetFile`/`sourceFiles` point every locale at this same one file, so each
 * locale's turn re-reads it fresh (via `existingText`) before writing — the same
 * read-then-write-fresh sequencing the CLI already does per locale, which is what
 * lets several locales share one file safely in a single run without clobbering each
 * other. A key's translated value is only ever replaced, never its `state`/metadata,
 * when the value hasn't actually changed — so a translator's own "needs_review" flag
 * on an untouched entry survives a rerun.
 */
export function readXcstringsDoc(file: string, text: string, tag: string, isSource: boolean): LocaleDoc {
  let raw: Obj;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid .xcstrings (JSON) in ${file}: ${(e as Error).message}`);
  }
  const strings = isObj(raw.strings) ? (raw.strings as Obj) : {};
  const data = newObj();
  for (const key of Object.keys(strings)) {
    const entry = strings[key];
    if (xcstringsSkip(entry)) continue;
    const v = xcstringsValue(entry as Obj, tag);
    if (v !== undefined) data[key] = v;
    else if (isSource) data[key] = key;
  }
  const indent = /^\{\r?\n([ \t]+)/.exec(text)?.[1] ?? 2;
  const keepNewline = finalNewline(text);

  const serialize = (d: unknown, targetTag: string, existingText?: string): string => {
    const obj = isObj(d) ? d : newObj();
    let out: Obj = raw;
    if (existingText !== undefined) {
      try {
        out = JSON.parse(existingText);
      } catch {
        out = raw;
      }
    }
    const outStrings = isObj(out.strings) ? (out.strings as Obj) : (out.strings = newObj());
    for (const key of Object.keys(obj)) {
      const entry = outStrings[key];
      if (xcstringsSkip(entry)) continue;
      const newVal = obj[key];
      const curVal = xcstringsValue(entry as Obj, targetTag);
      if (JSON.stringify(curVal) === JSON.stringify(newVal)) continue;
      const locs = isObj((entry as Obj).localizations) ? ((entry as Obj).localizations as Obj) : ((entry as Obj).localizations = newObj());
      if (isObj(newVal)) {
        const plural = newObj();
        for (const cat of CATEGORIES) {
          if (typeof (newVal as Obj)[cat] === "string") {
            plural[cat] = { stringUnit: { state: "translated", value: (newVal as Obj)[cat] } };
          }
        }
        locs[targetTag] = { variations: { plural } };
      } else if (typeof newVal === "string") {
        locs[targetTag] = { stringUnit: { state: "translated", value: newVal } };
      }
    }
    return withNewline(xcodeColonSpacing(JSON.stringify(out, null, indent)), keepNewline);
  };
  return { data, serialize };
}

import { isObj, type LocaleDoc, newObj, type Obj } from "./shared.ts";

/**
 * True for a value with a `{0}`-style numbered placeholder — the one reliable sign
 * that whatever loads this key also runs it through `java.text.MessageFormat`:
 * plain `ResourceBundle.getString()` does no substitution at all, so a bare `{0}`
 * with nothing to interpolate it would otherwise just show up literally.
 */
const MESSAGE_FORMAT_PLACEHOLDER = /\{\d+\}/;

/** Java `.properties`: `\n`, `\t`, `\r`, `\f`, `\\` and `\uXXXX` escapes, plus an escaped separator/leading-space. */
function unescapeProperties(s: string): string {
  const out = s.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_m, esc: string) => {
    if (esc[0] === "u" && esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
    return ({ n: "\n", t: "\t", r: "\r", f: "\f" } as Record<string, string>)[esc] ?? esc;
  });
  // MessageFormat's own `''` → `'` unescaping (see escapeProperties) — a separate,
  // upstream layer from .properties' own backslash escapes above, so undone here as
  // its own pass rather than folded into the replace above.
  return MESSAGE_FORMAT_PLACEHOLDER.test(out) ? out.replace(/''/g, "'") : out;
}
function escapeProperties(s: string): string {
  // MessageFormat treats a bare `'` as the start of a quoted (literal-braces) run
  // wherever `{N}` syntax appears in the same pattern, so "don't" next to "{0}"
  // either eats the placeholder or corrupts the text depending on where the next
  // `'` falls; `''` is MessageFormat's own documented escape for one literal `'`.
  // Skipped for a value with no `{N}` at all — nothing here can tell whether THAT
  // string is also fed through MessageFormat, so doubling its apostrophes would be
  // as likely to put a visible `''` in front of someone as to fix anything.
  let out = MESSAGE_FORMAT_PLACEHOLDER.test(s) ? s.replace(/'/g, "''") : s;
  out = out.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r");
  if (out[0] === " ") out = `\\${out}`;
  return out;
}

/**
 * Like `escapeProperties`, but also escaping every non-ASCII UTF-16 code unit as
 * `\uXXXX` (an astral character's surrogate pair becomes two such escapes, matching
 * how Java's own `native2ascii` encodes one) — for a key whose source value used
 * `\uXXXX` escapes rather than literal UTF-8, so the project's own escaping
 * convention for that key is kept instead of switching it to raw UTF-8 on write.
 */
function escapePropertiesUnicode(s: string): string {
  const escaped = escapeProperties(s);
  let out = "";
  for (let i = 0; i < escaped.length; i++) {
    const code = escaped.charCodeAt(i);
    out += code > 0x7e ? `\\u${code.toString(16).padStart(4, "0")}` : escaped[i];
  }
  return out;
}

/** True when `s` ends in an odd run of backslashes — Java's line-continuation rule. */
const endsWithContinuation = (s: string) => (/\\*$/.exec(s)![0].length % 2 === 1);

/** Splits `key<ws>?[=:]<ws>?value` at the first unescaped `=`/`:`, skipping `\X` pairs. Undefined if there's none (a key-only or malformed line). */
function splitPropertyLine(line: string): { key: string; valueStart: number } | undefined {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "=" || c === ":") {
      const key = unescapeProperties(line.slice(0, i).trimEnd());
      let v = i + 1;
      while (v < line.length && (line[v] === " " || line[v] === "\t")) v++;
      return { key, valueStart: v };
    }
    i++;
  }
  return undefined;
}

type PropBlock = { text: string } | { key: string; prefix: string };

/** Parses `.properties` text into passthrough lines (comments, blank lines, unparsable lines) and key/value entries. */
function parsePropertiesBlocks(text: string): { blocks: PropBlock[]; data: Obj; unicodeKeys: Set<string> } {
  const physical = text.split(/\r?\n/);
  const blocks: PropBlock[] = [];
  const data = newObj();
  const unicodeKeys = new Set<string>();
  let i = 0;
  while (i < physical.length) {
    const line = physical[i];
    const trimmedStart = line.replace(/^[ \t\f]+/, "");
    if (trimmedStart === "" || trimmedStart[0] === "#" || trimmedStart[0] === "!") {
      blocks.push({ text: line });
      i++;
      continue;
    }
    const split = splitPropertyLine(line);
    if (!split) {
      blocks.push({ text: line });
      i++;
      continue;
    }
    let valueRaw = line.slice(split.valueStart);
    while (endsWithContinuation(valueRaw) && i + 1 < physical.length) {
      valueRaw = valueRaw.slice(0, -1) + physical[++i].replace(/^[ \t\f]+/, "");
    }
    data[split.key] = unescapeProperties(valueRaw);
    if (/\\u[0-9a-fA-F]{4}/.test(valueRaw)) unicodeKeys.add(split.key);
    blocks.push({ key: split.key, prefix: line.slice(0, split.valueStart) });
    i++;
  }
  return { blocks, data, unicodeKeys };
}

/**
 * Java `ResourceBundle` `.properties`: a flat `key=value` (or `key: value`) list, one
 * per line, `#`/`!` line comments, `\`-continued multi-line values, and `\uXXXX`/`\n`/
 * `\t` escapes. There's no plural or array convention of its own — a value containing
 * ICU `{count, plural, ...}` syntax is still handled generically by the ICU extractor
 * elsewhere, same as any other format.
 *
 * Unlike Android/ARB/`.xcstrings` (which regenerate the whole file from the source's
 * own structure every run), this edits an existing target file's lines in place, the
 * same as YAML/`.po`: untouched entries, comments and blank lines keep their exact
 * text and position, and a value that didn't change is never rewritten. A multi-line
 * (`\`-continued) value is always collapsed to one line when it's rewritten, though —
 * only an *unchanged* continued value keeps its original multi-line layout. A line
 * with no unescaped `=`/`:` at all (so not a recognizable `key=value` pair) is passed
 * through untouched rather than guessed at. A key whose value used `\uXXXX` escapes
 * (rather than literal UTF-8) keeps using them when rewritten, instead of switching to
 * raw UTF-8.
 */
export function readPropertiesDoc(file: string, text: string): LocaleDoc {
  const { blocks, data, unicodeKeys } = parsePropertiesBlocks(text);
  const serialize = (d: unknown, _targetTag: string, existingText?: string): string => {
    const obj = isObj(d) ? d : newObj();
    const base = existingText !== undefined ? parsePropertiesBlocks(existingText) : { blocks, unicodeKeys };
    const escapeFor = (k: string) => (base.unicodeKeys.has(k) ? escapePropertiesUnicode : escapeProperties);
    const seen = new Set<string>();
    const lines = base.blocks.map((b) => {
      if (!("key" in b)) return b.text;
      seen.add(b.key);
      return `${b.prefix}${escapeFor(b.key)(typeof obj[b.key] === "string" ? (obj[b.key] as string) : "")}`;
    });
    for (const k of Object.keys(obj)) {
      if (seen.has(k) || typeof obj[k] !== "string") continue;
      // Never-before-seen key: no target-side convention to follow, so fall back to the source's own.
      lines.push(`${k}=${(unicodeKeys.has(k) ? escapePropertiesUnicode : escapeProperties)(obj[k] as string)}`);
    }
    return lines.join("\n");
  };
  return { data, serialize };
}

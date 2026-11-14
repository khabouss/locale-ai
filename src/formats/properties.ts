import { isObj, type LocaleDoc, newObj, type Obj } from "./shared.ts";

/**
 * True for a value with a `{0}`-style MessageFormat placeholder — the one reliable
 * sign that whatever loads this key also runs it through `java.text.MessageFormat`:
 * plain `ResourceBundle.getString()` does no substitution at all, so a bare `{0}`
 * with nothing to interpolate it would otherwise just show up literally. Also matches
 * the extended `{0,number,integer}`/`{0,date}`/`{0,date,short}` forms — an
 * ArgumentIndex followed by an optional `,FormatType[,FormatStyle]` — not just a bare
 * `{0}`, since those still mean MessageFormat is in play.
 */
const MESSAGE_FORMAT_PLACEHOLDER = /\{\d+(,[^{}]+)?\}/;

/**
 * Matches MessageFormat's literal-brace quoting idiom — a quote directly touching an
 * opening `{` and another directly touching the matching `}` (`'{0}'`,
 * `'{0,number,integer}'`, `'{name}'`), or a quote wrapping a single stray `{`/`}` on
 * its own (`'{'`, `'}'`) — all of which show the brace(s) as literal text rather than
 * invoking placeholder syntax. Only *these specific quote characters* are left alone
 * on write (unless the same placeholder's VALUE was itself quoted in the source — see
 * `QUOTED_ARG_RE` below); every other apostrophe, including a lone one that merely
 * happens to sit next to an unrelated brace (French elision right before a
 * placeholder, as in `"L'{0} n'existe pas"`), still needs the `''` escape. Requiring
 * direct adjacency to the brace (not just "a brace somewhere between two quotes") is
 * what keeps that case safe: nothing sits between the quote and the brace here, but
 * in `"L'objet {0} n'existe pas"` the first quote is followed by "objet ", not `{`, so
 * it doesn't match and both elisions still get doubled individually.
 */
const LITERAL_BRACE_QUOTE_RE = /'(\{[^{}']*\}|[{}])'/g;

/**
 * Matches MessageFormat's *other* quoting idiom — `''{0}''` — which doubles the
 * apostrophe on each side of a placeholder to show its *substituted value* wrapped in
 * a literal apostrophe (since `''` is always one literal apostrophe and never opens a
 * quoted run, {0} in between is substituted normally). This is the opposite of
 * `LITERAL_BRACE_QUOTE_RE`'s single-quote idiom, which suppresses substitution
 * instead — and once read, the two collapse to the exact same single-quote text
 * (`unescapeProperties`'s `''`→`'` pass can't tell them apart), so which one a given
 * placeholder index used has to be captured straight from the raw source line, before
 * that collapse happens, and carried alongside the key so write-time escaping can
 * reapply the right one.
 */
const QUOTED_ARG_RE = /''\{(\d+)(?:,[^{}]+)?\}''/g;

/** Java `.properties`: `\n`, `\t`, `\r`, `\f`, `\\` and `\uXXXX` escapes, plus an escaped separator/leading-space. */
function unescapeProperties(s: string): string {
  const out = s.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_m, esc: string) => {
    if (esc[0] === "u" && esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
    return ({ n: "\n", t: "\t", r: "\r", f: "\f" } as Record<string, string>)[esc] ?? esc;
  });
  // MessageFormat's own `''` → `'` unescaping (see escapeProperties) — a separate,
  // upstream layer from .properties' own backslash escapes above, so undone here as
  // its own pass rather than folded into the replace above. Unconditional: a `''`
  // pair is always one literal apostrophe per MessageFormat's own rule, and
  // escapeProperties never doubles the two quotes forming an intentional `'{0}'`-style
  // literal-braces idiom in the first place — so there's nothing here that could
  // wrongly undo one.
  return MESSAGE_FORMAT_PLACEHOLDER.test(out) ? out.replace(/''/g, "'") : out;
}
const NO_QUOTED_ARGS: ReadonlySet<number> = new Set();

/**
 * `quotedArgs` is the set of placeholder argument indices (the `N` in `{N}`) whose
 * *value* was wrapped in doubled quotes (`''{N}''`) in this key's own source text —
 * passed in from the source-side scan (`QUOTED_ARG_RE`) that read it, since nothing
 * in the translated text itself can tell that idiom apart from the single-quote
 * literal-braces one once a round-trip through `unescapeProperties` has collapsed
 * both to the same plain `'{N}'` text (see QUOTED_ARG_RE's own comment).
 */
function escapeProperties(s: string, quotedArgs: ReadonlySet<number> = NO_QUOTED_ARGS): string {
  // MessageFormat treats a bare `'` as the start of a quoted (literal-braces) run
  // wherever `{N}` syntax appears in the same pattern, so "don't" next to "{0}"
  // either eats the placeholder or corrupts the text depending on where the next
  // `'` falls; `''` is MessageFormat's own documented escape for one literal `'`.
  // Every apostrophe gets doubled EXCEPT the two forming a genuine literal-braces
  // idiom (see LITERAL_BRACE_QUOTE_RE) — doubling those would turn the intentional
  // literal-braces idiom into live substitution instead, the opposite of what it's
  // there for. An index in `quotedArgs` is the other idiom instead (`''{N}''`,
  // wrapping the *substituted value*, not suppressing it) — its two quotes are
  // doubled, not protected, same as any other apostrophe.
  let out = s;
  if (MESSAGE_FORMAT_PLACEHOLDER.test(s) && s.includes("'")) {
    const kept = new Set<number>();
    LITERAL_BRACE_QUOTE_RE.lastIndex = 0;
    for (let m = LITERAL_BRACE_QUOTE_RE.exec(s); m; m = LITERAL_BRACE_QUOTE_RE.exec(s)) {
      const arg = /^\{(\d+)/.exec(m[1]);
      if (arg && quotedArgs.has(Number(arg[1]))) continue;
      kept.add(m.index);
      kept.add(m.index + m[0].length - 1);
    }
    out = "";
    for (let i = 0; i < s.length; i++) out += s[i] === "'" && !kept.has(i) ? "''" : s[i];
  }
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
function escapePropertiesUnicode(s: string, quotedArgs?: ReadonlySet<number>): string {
  const escaped = escapeProperties(s, quotedArgs);
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
function parsePropertiesBlocks(
  text: string,
): { blocks: PropBlock[]; data: Obj; unicodeKeys: Set<string>; quotedArgKeys: Map<string, Set<number>> } {
  const physical = text.split(/\r?\n/);
  const blocks: PropBlock[] = [];
  const data = newObj();
  const unicodeKeys = new Set<string>();
  const quotedArgKeys = new Map<string, Set<number>>();
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
    const args = new Set([...valueRaw.matchAll(QUOTED_ARG_RE)].map((m) => Number(m[1])));
    if (args.size) quotedArgKeys.set(split.key, args);
    blocks.push({ key: split.key, prefix: line.slice(0, split.valueStart) });
    i++;
  }
  return { blocks, data, unicodeKeys, quotedArgKeys };
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
  const { blocks, data, unicodeKeys, quotedArgKeys } = parsePropertiesBlocks(text);
  const serialize = (d: unknown, _targetTag: string, existingText?: string): string => {
    const obj = isObj(d) ? d : newObj();
    const base = existingText !== undefined ? parsePropertiesBlocks(existingText) : { blocks, unicodeKeys };
    const escapeFor = (k: string) => {
      // Which MessageFormat quoting idiom a placeholder uses is the SOURCE's call, not
      // a per-target formatting preference like \uXXXX vs raw UTF-8 — so this always
      // comes from the source's own quotedArgKeys, never the target's. Using the
      // target's own (an existing bug) meant editing a message to add `''{0}''` and
      // retranslating never actually fixed an already-translated key: the old target
      // line had no `''{0}''` to detect, so the lookup stayed empty and the write
      // path kept defaulting to the literal-braces idiom instead.
      const args = quotedArgKeys.get(k);
      return (v: string) => (base.unicodeKeys.has(k) ? escapePropertiesUnicode(v, args) : escapeProperties(v, args));
    };
    const seen = new Set<string>();
    const lines = base.blocks.map((b) => {
      if (!("key" in b)) return b.text;
      seen.add(b.key);
      return `${b.prefix}${escapeFor(b.key)(typeof obj[b.key] === "string" ? (obj[b.key] as string) : "")}`;
    });
    for (const k of Object.keys(obj)) {
      if (seen.has(k) || typeof obj[k] !== "string") continue;
      // Never-before-seen key: no target-side convention to follow, so fall back to the source's own.
      const args = quotedArgKeys.get(k);
      const esc = unicodeKeys.has(k) ? escapePropertiesUnicode(obj[k] as string, args) : escapeProperties(obj[k] as string, args);
      lines.push(`${k}=${esc}`);
    }
    return lines.join("\n");
  };
  return { data, serialize };
}

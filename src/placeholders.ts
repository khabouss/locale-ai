/**
 * Placeholder protection.
 *
 * Interpolation variables, markup and other non-linguistic spans are replaced by
 * markers before translation and restored afterwards. No single marker shape
 * survives every model and sentence (measured on OPUS-MT), so styles are tried in
 * order until every marker comes back:
 *
 *  - "natural": variables -> `{0}`, tags -> `<1>` `</1>` `<2/>`. Models trained on
 *    software localisation data translate around these most fluently
 *    ("au moins {0} caractères").
 *  - "numeric": everything -> `900`, `901`... Numbers are copied by every model,
 *    including those that mangle braces (en-zh, en-ru), but can change grammar
 *    ("{0} item" -> "900 articles"), hence second.
 *  - "opaque": everything -> `_P0_`.
 */

export type Style = "natural" | "numeric" | "opaque";

const NUMERIC_BASE = 900;
const NUMERIC_RE_SRC = /(?<!\d)9\d\d(?!\d)/.source;

/**
 * A MATCHED pair of curly quotes directly wrapping a placeholder (“{0}” or ‘{0}’).
 * Masking only the placeholder itself and leaving these as ordinary surrounding text
 * works for every other punctuation mark this project has tested against real
 * models — but the Italian and German OPUS-MT models garble this specific
 * quote-against-brace boundary even though they know the characters fine elsewhere
 * in a sentence (seen on a real hop: `“{0}”` → `[55]{0} [56]`, `‘{0}’` → `‘{0} .`).
 * Swallowing a matched pair into the SAME masked span as the placeholder sidesteps
 * the boundary entirely.
 *
 * Only a genuine matched pair qualifies — a quote on just one side is never
 * absorbed. Earlier this project absorbed either side independently, reasoning that
 * restoring the exact matched text verbatim is always safe; it isn't. An unrelated
 * trailing possessive (`{0}’s profile`) got swallowed into the same opaque span as
 * the placeholder, and while the literal text still came back unchanged, the model
 * could no longer see the `’s` as ordinary attachable text and lost the ability to
 * restructure the sentence the way the target language needs
 * (French/Italian/Spanish want "the profile of {0}", not "{0}'s profile").
 * Verbatim-restore safety is not the same thing as translation-quality safety.
 */
const ICU_ARG_SRC = /\{\s*[\w.-]+\s*(?:,[^{}]*)?\}/.source;
const CURLY_QUOTE_PAIR_SRC = `“${ICU_ARG_SRC}”|‘${ICU_ARG_SRC}’`;

/** The exact set of curly quote characters either side of CURLY_QUOTE_PAIR_SRC can use — used by `stripCurlyQuotePair` below to undo that absorption when comparing placeholders across languages. */
const CURLY_QUOTE_SRC = "[“”‘’]";

/**
 * En/em dash. Protected during translation like `©`, but a typographic choice
 * rather than syntax: a translator writing "de {open} à {close}" or a plain "-"
 * is legitimate, so `check` leaves dashes out of its placeholder comparison.
 */
const DASH_SRC = "[–—]";
export const isDash = (token: string) => /^[–—]$/.test(token);

const SOURCES = [
  /_{1,3}\s?[Pp]\s?\d+\s?_{1,3}/.source, // text that looks like our own opaque markers
  /\{\{\{[^{}]*\}\}\}/.source, // {{{raw}}}
  /\{\{[^{}]*\}\}/.source, // {{name}}  i18next / vue / handlebars
  /\$t\([^)]*\)/.source, // $t(key)  i18next nesting
  /\$\{[^{}]*\}/.source, // ${name}
  /%%/.source, // %%  an escaped literal percent in a printf/python-format string (gettext's `#, python-format` "10%% off") — collapsed to one "%" by the model, it reads as a broken directive and msgfmt -c rejects the catalog
  /%\{[^{}]+\}/.source, // %{name}  ruby / polyglot
  /%\([\w.]+\)[sdifr]/.source, // %(name)s  python
  /%(?:\d+\$)?[-+0#]*\d*(?:\.\d+)?[sdifuxXeEgGcpo@](?![A-Za-z])/.source, // %s %d %1$s %.2f %@ (not "100%off")
  /[\w.+-]+\{'@'\}[\w-]+(?:\.[\w-]+)+/.source, // hello{'@'}example.com  an e-mail address written with vue-i18n's literal @ (a bare @ is its linked-message syntax) — masked whole, so the address stays one unit
  /@(?:\.\w+)?:\{'[^']*'\}/.source, // @:{'key'} @.lower:{'key'}  vue-i18n linked message, braced form
  /\{'[^']*'\}/.source, // {'@'} {'{'} {'|'}  vue-i18n literal interpolation: how a special character is written as text
  /@(?:\.\w+)?:\(?[\w.-]+\)?/.source, // @:key @.lower:key  vue-i18n linked messages
  /\{\s*[\w.]+\s*(?:,\s*-?\d+\s*)?:[^{}]*\}/.source, // {0:P0} {0,10:N2} {price:.2f}  .NET composite format / Python str.format with a format spec — "0:P0" without its braces prints literally
  ICU_ARG_SRC, // {name} {0} {count, number}  ICU simple args
  CURLY_QUOTE_PAIR_SRC, // “{0}” or ‘{0}’  a matched pair of curly quotes wrapping a placeholder (see CURLY_QUOTE_PAIR_SRC)
  /'[{}]'/.source, // '{' '}'  MessageFormat's idiom for a literal brace with nothing else inside — too short/unusual on its own for a model to reliably carry through untouched (observed dropped or multiplied on a real hop), unlike '{0}'/'{name}', where the braces' own content is already protected by the ICU-args pattern above
  /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>/.source, // <b> </b> <a href="..."> <Trans/>
  /<\/?\s*\d+\s*\/?>/.source, // <0> </0> <1/>  react-i18next indexed components
  /&lt;\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?&gt;/.source, // &lt;b&gt;  text that documents/displays a tag literally (XLIFF/.resx) rather than embedding it — placed before the generic entity-reference pattern below so the whole span is masked as one unit, not split into "&lt;" + the bare, unprotected tag name + "&gt;"
  /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/.source, // &nbsp; &#39;
  /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/.source, // URLs
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.source, // e-mail addresses
  /(?<![\w.@%])@[A-Za-z_][\w.]*\w(?:\/[\w.]+)?/.source, // @support @string/app_name  a handle or Android resource reference (not an e-mail, not vue-i18n's @:key, not %@) — dropped or mangled otherwise
  /[$€£¥₹₩₽]\s?\d+(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?\s?[€£¥₹₩₽]/.source, // €5 $9.99 5 € £1,299.00  a currency amount — the model "localized" €5 to $5 or 5 yuan
  /(?<=^|[\s(])(?::[a-zA-Z_]\w*)/.source, // :attribute  laravel
  /\$(?![A-Z]{2,}(?![a-zA-Z0-9_]))[A-Za-z_]\w*/.source, // $name (not "$USD", "$CAD" — currency codes)
  /[©®™]/.source, // copyright/registered/trademark symbols — models drop these on a second (pivoted) hop
  DASH_SRC, // – —  en/em dash: the en-it model can't produce one, and drops it or emits garbage ("{0} [49] {1}", "{0} € {1}") — see isDash
];

const PLACEHOLDER_SRC = SOURCES.map((s) => `(?:${s})`).join("|");
const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_SRC, "gu");
const withProtected = new WeakMap<RegExp, RegExp>();

/** Placeholder regex extended with project do-not-translate terms. */
function placeholderRe(protect?: RegExp): RegExp {
  if (!protect) return PLACEHOLDER_RE;
  let re = withProtected.get(protect);
  if (!re) {
    re = new RegExp(`(?:${protect.source})|${PLACEHOLDER_SRC}`, "gu");
    withProtected.set(protect, re);
  }
  return re;
}

/** Any marker of either style, tolerating light damage by the model. */
const MARKER_SRC = /\{\s*\d+\s*\}|<\s*\/?\s*\d+\s*\/?\s*>|_{1,3}\s?[Pp]\s?\d+\s?_{1,3}/.source;
const markerRe = () => new RegExp(MARKER_SRC, "g");

/** Canonical key of a (possibly damaged) marker: "{3}", "<3>", "</3>", "<3/>", "_P3_", "#903". */
function markerKey(m: string): string {
  const compact = m.replace(/\s+/g, "");
  if (/^\d+$/.test(compact)) return `#${compact}`;
  if (compact.startsWith("{")) return compact;
  if (compact.startsWith("<")) return compact;
  return `_P${/\d+/.exec(compact)![0]}_`;
}

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "wbr", "area", "col", "source"]);

type TagKind = { name: string; kind: "open" | "close" | "self" };

/**
 * Lowercased names of every closing tag in `text` — so a tag whose name is an HTML
 * void element but that IS closed in the same string (next-intl's `<link>…</link>`
 * rich-text convention) is read as an open/close pair, not as a self-closing
 * `<link>` plus a stray `</link>`. Masked that way, no model could follow the broken
 * pair (`<0/>return policy</1>`), and the string fell through to the last-resort
 * strategy, which left its text in English.
 */
export const closedTagNames = (text: string) => new Set([...text.matchAll(/<\/\s*([A-Za-z0-9][\w.:-]*)\s*>/g)].map((m) => m[1].toLowerCase()));

export function tagKind(t: string, closed?: Set<string>): TagKind | undefined {
  if (!/^<[^<>]+>$/.test(t)) return undefined; // merged spans are not a single tag
  const close = /^<\/\s*([A-Za-z0-9][\w.:-]*)\s*>$/.exec(t);
  if (close) return { name: close[1], kind: "close" };
  const open = /^<\s*([A-Za-z0-9][\w.:-]*)/.exec(t);
  if (!open || !t.endsWith(">")) return undefined;
  if (t.endsWith("/>") || (VOID_TAGS.has(open[1].toLowerCase()) && !closed?.has(open[1].toLowerCase()))) return { name: open[1], kind: "self" };
  return { name: open[1], kind: "open" };
}

export interface Masked {
  text: string;
  style: Style;
  /** Original placeholder text, by token index. */
  tokens: string[];
  /** Marker key -> token index. */
  keys: Map<string, number>;
}

export function mask(text: string, style: Style = "natural", protect?: RegExp): Masked {
  // Find placeholder spans. In numeric style, adjacent spans ("<b>{count}</b>") are
  // merged into one marker: glued numbers ("901902903") could not be split back.
  const spans: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(placeholderRe(protect))) {
    const last = spans[spans.length - 1];
    if (style === "numeric" && last && last.end === m.index) last.end = m.index + m[0].length;
    else spans.push({ start: m.index, end: m.index + m[0].length });
  }

  const tokens: string[] = [];
  const keys = new Map<string, number>();
  let nextVar = 0;
  let nextTag = 0;
  const openTags: Array<{ name: string; id: number }> = [];
  const closed = closedTagNames(text);
  let masked = "";
  let pos = 0;
  for (const { start, end } of spans) {
    const m = text.slice(start, end);
    const index = tokens.length;
    tokens.push(m);
    let marker: string;
    if (style === "opaque") marker = `_P${index}_`;
    else if (style === "numeric") marker = String(NUMERIC_BASE + index);
    else {
      const tag = tagKind(m, closed);
      if (!tag) marker = `{${nextVar++}}`;
      else if (tag.kind === "self") marker = `<${nextTag++}/>`;
      else if (tag.kind === "open") {
        const id = nextTag++;
        openTags.push({ name: tag.name, id });
        marker = `<${id}>`;
      } else {
        const i = openTags.map((o) => o.name).lastIndexOf(tag.name);
        const id = i >= 0 ? openTags.splice(i, 1)[0].id : nextTag++;
        marker = `</${id}>`;
      }
    }
    keys.set(markerKey(marker), index);
    masked += text.slice(pos, start) + marker;
    pos = end;
  }
  masked += text.slice(pos);
  return { text: masked, tokens, style, keys };
}

/**
 * Strips a leading+trailing curly quote from a placeholder token, if both are
 * present, regardless of their exact style. Used when comparing a source and
 * target's placeholder sets across languages: a translator is free to wrap a
 * placeholder in their own language's quoting convention (German „…“, French
 * « … »), use none at all, or rephrase a possessive away entirely — none of that
 * should count as a different placeholder than the source's "{0}".
 */
export function stripCurlyQuotePair(token: string): string {
  const re = new RegExp(`^${CURLY_QUOTE_SRC}([\\s\\S]*)${CURLY_QUOTE_SRC}$`, "u");
  return re.exec(token)?.[1] ?? token;
}

/** The numeric style can only be used when the text has no numbers that look like markers. */
export const numericStyleSafe = (text: string) => !new RegExp(NUMERIC_RE_SRC).test(text);

/** True when the text contains something worth translating (2+ letters outside markers). */
export function hasTranslatableText(maskedText: string): boolean {
  return (maskedText.replace(markerRe(), "").match(/\p{L}/gu)?.length ?? 0) >= 2;
}

/**
 * Restores placeholders. Returns undefined when the translation lost, duplicated or
 * invented a marker, or put a closing tag before its opening tag.
 */
export function unmask(translated: string, masked: Masked): string | undefined {
  const seen = new Array<number>(masked.tokens.length).fill(0);
  let bad = false;
  const order: number[] = [];
  const re = masked.style === "numeric" ? new RegExp(NUMERIC_RE_SRC, "g") : markerRe();
  const out = translated.replace(re, (m) => {
    const i = masked.keys.get(markerKey(m));
    if (i === undefined) {
      bad = true;
      return "";
    }
    seen[i]++;
    order.push(i);
    return masked.tokens[i];
  });
  if (bad || seen.some((c) => c !== 1)) return undefined;
  if (!tagsInOrder(order, masked.tokens)) return undefined;
  return out;
}

/** For each tag name, the open/close sequence must match the source (no `</b>…<b>`). */
function tagsInOrder(outputOrder: number[], tokens: string[]): boolean {
  const closed = closedTagNames(tokens.join(""));
  const pattern = (order: number[]) => {
    const byName = new Map<string, string>();
    for (const i of order) {
      const k = tagKind(tokens[i], closed);
      if (k && k.kind !== "self") byName.set(k.name, (byName.get(k.name) ?? "") + (k.kind === "open" ? "+" : "-"));
    }
    return [...byName].sort().join("|");
  };
  return pattern(outputOrder) === pattern(tokens.map((_, i) => i));
}

/** Applies `fn` to the text outside markers, leaving markers untouched. */
export function mapOutsideTokens(text: string, fn: (s: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(markerRe())) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}

/** Removes markers (for measuring the real text). */
export const stripMarkers = (text: string) => text.replace(markerRe(), "");

/** Splits a masked string into alternating text / marker pieces (used by the fallback). */
export function splitOnTokens(text: string): Array<{ token: boolean; value: string }> {
  const parts: Array<{ token: boolean; value: string }> = [];
  let last = 0;
  for (const m of text.matchAll(markerRe())) {
    if (m.index > last) parts.push({ token: false, value: text.slice(last, m.index) });
    parts.push({ token: true, value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ token: false, value: text.slice(last) });
  return parts;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes spaces the model put inside tags ("<b> Terms</b>") when the source has none. */
export function fixTagSpacing(source: string, output: string, tokens: string[]): string {
  let r = output;
  const closed = closedTagNames(tokens.join(""));
  for (const t of new Set(tokens)) {
    const kind = tagKind(t, closed)?.kind;
    const e = escapeRe(t);
    if (kind === "open" && new RegExp(`${e}\\S`).test(source)) r = r.replace(new RegExp(`${e}[ \\t]+`, "g"), () => t);
    if (kind === "close" && new RegExp(`\\S${e}`).test(source)) r = r.replace(new RegExp(`[ \\t]+${e}`, "g"), () => t);
  }
  return r;
}

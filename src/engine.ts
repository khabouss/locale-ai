import { extractIcu } from "./icu.ts";
import { extractPipePlural } from "./vue-plural.ts";
import type { Translator } from "./models.ts";
import {
  fixTagSpacing,
  hasTranslatableText,
  mapOutsideTokens,
  mask,
  numericStyleSafe,
  splitOnTokens,
  stripMarkers,
  unmask,
  type Style,
} from "./placeholders.ts";
import { splitSentences } from "./segment.ts";

export interface EngineOptions {
  /** Intl locale codes. */
  sourceLang: string;
  targetLang: string;
  batchSize: number;
  /** Project terms that must be copied verbatim. */
  protect?: RegExp;
  /** Whole-string glossary; a hit skips the model. */
  lookup?: (s: string) => string | undefined;
  /** Source strings at a cardinal "one" plural slot, any format (see locales.ts's pluralOneStrings). */
  singularHints?: Set<string>;
  onProgress?: (done: number, total: number) => void;
}

export type IssueKind = "placeholder-fallback" | "suspicious-length" | "repetition" | "empty-tag" | "untranslated-tag" | "edited" | "conflict";

export interface Issue {
  source: string;
  kind: IssueKind;
  output?: string;
}

export interface EngineResult {
  translations: Map<string, string>;
  issues: Issue[];
}

/** One translatable unit: a whole string, or one text run of an ICU message. */
interface Unit {
  text: string;
  /** The full source string the unit belongs to (for reporting). */
  owner: string;
  result?: string;
}

interface Progress {
  done: number;
  total: number;
}

const letters = (s: string) => stripMarkers(s).replace(/[^\p{L}]/gu, "");

function isAllCaps(s: string): boolean {
  const l = letters(s);
  return l.length >= 2 && l === l.toUpperCase() && l !== l.toLowerCase();
}

/** ALL-CAPS labels translate badly, so they are sent in sentence case and re-uppercased. */
function prepare(src: string): string {
  if (!isAllCaps(src)) return src;
  let first = true;
  return mapOutsideTokens(src, (x) =>
    x.toLowerCase().replace(/\p{L}/u, (c) => {
      if (!first) return c;
      first = false;
      return c.toUpperCase();
    }),
  );
}

/** Scripts written without spaces between words. */
const NO_SPACES = /^(zh|ja|th|lo|km|my)\b/;

const FULLWIDTH: Record<string, string> = { ",": "，", "?": "？", "!": "！", ":": "：", ";": "；", "(": "（", ")": "）" };

/** Chinese typography: full-width punctuation, no stray spaces next to Han characters. */
function fixCjk(r: string): string {
  return r
    .replace(/(?<=\p{Script=Han})\s*([,?!:;])\s*/gu, (_m, c: string) => FULLWIDTH[c])
    .replace(/\s+(?=[。，？！：；])/gu, "")
    .replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, "")
    .replace(/(?<=\p{Script=Han})\.$/u, "。");
}

/** Languages that write counts before the noun ("3 files", "3 fichiers"). */
const COUNT_FIRST = /^(fr|es|pt|it|ca|gl|ro|nl|de|da|sv|no|en)\b/;

/** Keeps "{0} noun" order for languages that put counts first. */
function fixMarkers(src: string, out: string, targetLang: string): string {
  let r = out;
  // "{0} file" -> "Fichier {0}": move a leading count back in front of a short noun phrase.
  const lead = /^\{(\d+)\}\s+\p{L}/u.exec(src);
  if (lead && COUNT_FIRST.test(targetLang)) {
    const tail = new RegExp(`^([^{}<>]+?)\\s+\\{${lead[1]}\\}([.!?]?)$`, "u").exec(r);
    if (tail && tail[1].split(/\s+/).length <= 3) {
      const words = /^de\b/.test(targetLang) ? tail[1] : tail[1].replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLocaleLowerCase(targetLang));
      r = `{${lead[1]}} ${words}${tail[2]}`;
    }
  }
  return r;
}

function postprocess(src: string, out: string, targetLang: string): string {
  let r = fixMarkers(src, out.trim(), targetLang);
  // Punctuation the model doubled ("Konto??", "cuenta?.....") unless the source has it.
  r = r.replace(/([?!])[.?!]+/g, (m, c: string) => (src.includes(m) ? m : c));
  r = r.replace(/([,;:])\1+|(?<!\.)\.{2}(?!\.)/g, (m) => (src.includes(m) ? m : m[0]));
  // Labels like "Settings" must not gain a trailing period.
  if (!/[.。!?！？…]$/.test(src) && /[^.]\.$/.test(r)) r = r.slice(0, -1);
  if (src.endsWith("…") && r.endsWith("...")) r = r.slice(0, -3) + "…";
  if (/^zh\b/.test(targetLang)) r = fixCjk(r);
  if (/^fr\b/.test(targetLang)) {
    // French typography: a non-breaking space before ! ? ; : — the model is inconsistent
    // about adding one at all, and when it does, it's a plain, breakable space, which
    // lets the punctuation wrap onto its own line. [ \t]* replaces that plain space
    // (not just fills in a missing one) with a single U+00A0.
    r = r.replace(/(?<=[^\s!?;:])[ \t]*([!?;:])(?=\s|$)/g, " $1");
  }
  if (isAllCaps(src)) return mapOutsideTokens(r, (x) => x.toLocaleUpperCase(targetLang));
  // Keep the source's leading capital ("Save" -> "Enregistrer", not "enregistrer").
  const s0 = letters(src)[0];
  if (s0 && s0 !== s0.toLowerCase()) {
    let done = false;
    r = mapOutsideTokens(r, (x) =>
      done
        ? x
        : x.replace(/\p{L}/u, (c) => {
            done = true;
            return c.toLocaleUpperCase(targetLang);
          }),
    );
  }
  return r;
}

/** Output the model produces when it gets confused by markers: "{0}_________". */
function isDegenerate(src: string, out: string): boolean {
  if (!stripMarkers(out).trim()) return true;
  for (const re of [/_{3,}/, /(\S)\1{5,}/u, /([^\p{L}\p{N}\s.])\1{3,}/u, /\.{4,}/, /(?:[<>] ?){4,}/, />>\w+<</]) {
    if (re.test(out) && !re.test(src)) return true;
  }
  return false;
}

/** An open/close tag pair — HTML, a rich-text tag like `<link>`, or an indexed `<0>` — and its inner text (no nested tags). */
const TAG_PAIR_RE = /<([A-Za-z][\w.:-]*|\d+)(\s[^<>]*)?>([^<>]*)<\/\1\s*>/g;

/** A capitalized single word or Title Case run ("Trailhead", "Trailhead Gear") — most likely a name, kept as it is. */
const looksLikeName = (s: string) => /^\p{Lu}[\p{L}\p{N}'’-]*(?:\s+\p{Lu}[\p{L}\p{N}'’-]*)*$/u.test(s);

/** Puts a standalone translation in its source text's case: a lowercase phrase mid-sentence stays lowercase ("politique de retour", not "Politique de retour" or "POLITIQUE DE RETOUR"). */
function matchCase(src: string, t: string): string {
  let r = t;
  if (isAllCaps(r) && !isAllCaps(src)) r = r.toLowerCase();
  if (/^\p{Ll}/u.test(src)) r = r.charAt(0).toLowerCase() + r.slice(1);
  else if (/^\p{Lu}/u.test(src)) r = r.charAt(0).toUpperCase() + r.slice(1);
  return r;
}

/**
 * Tag texts the model copied over unchanged while translating the rest of the string
 * ("Immer noch stecken? <strong>Chat with us</strong> oder…") — like an emptied pair,
 * a tag's content seems to read to the model as "keep this as it is", on any marker
 * style. A wholly untouched output isn't counted (that's the ordinary identical-to-
 * source case).
 *
 * Only plain words qualify: a text holding anything the masker protects (a
 * placeholder like `%(title)s`, an e-mail, a URL, a protected term) is skipped. Those
 * come back unchanged because the model got them right — and `fixUntranslatedTagTexts`
 * sends a text to the model raw, unmasked, so it came back as `%(titre)s` or
 * `help@ejemplo.com`, breaking format strings and addresses.
 */
function untranslatedTagTexts(src: string, out: string, protect?: RegExp): string[] {
  if (out.trim() === src.trim()) return [];
  const srcPairs = [...src.matchAll(TAG_PAIR_RE)].map((m) => `${m[1]}\u0000${m[3].trim()}`);
  const found: string[] = [];
  for (const m of out.matchAll(TAG_PAIR_RE)) {
    const inner = m[3].trim();
    if (!srcPairs.includes(`${m[1]}\u0000${inner}`) || letters(inner).length < 3) continue;
    if (mask(inner, "natural", protect).tokens.length === 0) found.push(inner);
  }
  return found;
}

/**
 * Translates each tag text `untranslatedTagTexts` found on its own and puts it back
 * inside its tag — out of its sentence's context, but a phrase like "return policy"
 * or "Chat with us" reads fine alone, and a translated phrase beats an English one.
 * A text that looks like a name is left alone and not reported (sent alone, it would
 * come back translated: "Trailhead" -> "Wegbereiter"). Whatever else is still
 * identical is reported for review.
 */
async function fixUntranslatedTagTexts(units: Unit[], hops: Translator[], opts: EngineOptions, progress: Progress, issues: Issue[]): Promise<void> {
  const found = new Map<Unit, string[]>();
  for (const u of units) {
    const texts = u.result === undefined ? [] : untranslatedTagTexts(u.text, u.result, opts.protect);
    if (texts.length) found.set(u, texts);
  }
  if (!found.size) return;
  const send = new Set([...found.values()].flat().filter((t) => !looksLikeName(t)).map(prepare));
  const alone = await runModels(send, hops, opts, progress);
  for (const [u, texts] of found) {
    let stillUntranslated = false;
    u.result = u.result!.replace(TAG_PAIR_RE, (m: string, _name: string, _attrs: string | undefined, inner: string) => {
      const text = inner.trim();
      if (!texts.includes(text)) return m;
      // A name is kept on purpose, so it's neither sent nor reported.
      if (looksLikeName(text)) return m;
      const raw = alone.get(prepare(text)) ?? "";
      const t = raw && !isDegenerate(text, raw) ? matchCase(text, postprocess(text, raw, opts.targetLang)) : "";
      if (!t || t.toLowerCase() === text.toLowerCase()) {
        stillUntranslated = true;
        return m;
      }
      return m.replace(`>${inner}<`, `>${inner.replace(text, t)}<`);
    });
    if (stillUntranslated) issues.push({ source: u.owner, kind: "untranslated-tag", output: u.result });
  }
}

/** Runs unique inputs through every hop (pivot translation) in length-sorted batches. */
async function runModels(
  inputs: Set<string>,
  hops: Translator[],
  opts: EngineOptions,
  progress: Progress,
): Promise<Map<string, string>> {
  progress.total += inputs.size * hops.length;
  let current = new Map<string, string>([...inputs].map((s) => [s, s]));
  for (const hop of hops) {
    const unique = [...new Set(current.values())].sort((a, b) => a.length - b.length);
    const out = new Map<string, string>();
    for (let i = 0; i < unique.length; i += opts.batchSize) {
      const batch = unique.slice(i, i + opts.batchSize);
      const res = await hop.translate(batch);
      batch.forEach((s, j) => out.set(s, res[j] ?? ""));
      progress.done += batch.length;
      opts.onProgress?.(progress.done, progress.total);
    }
    // Pivot inputs that collapsed to the same intermediate text count once.
    progress.done += inputs.size - unique.length;
    current = new Map([...current].map(([k, v]) => [k, out.get(v) ?? ""]));
  }
  return current;
}

/**
 * Translates units with one marker style. Units whose placeholders do not survive
 * (or whose output is degenerate) are returned for the next strategy.
 */
async function attempt(
  units: Unit[],
  style: Style,
  hops: Translator[],
  opts: EngineOptions,
  progress: Progress,
  issues: Issue[],
): Promise<Unit[]> {
  const failed: Unit[] = [];
  if (style === "numeric") {
    failed.push(...units.filter((u) => !numericStyleSafe(u.text)));
    units = units.filter((u) => numericStyleSafe(u.text));
  }
  // A "natural"-style open/close tag pair (<1>...</1>) whose own numbered id a model
  // seems to learn as its own kind of do-not-translate marker, similar to {0} — the
  // content between them disappearing entirely ("<a href=...>here</a>" -> an empty
  // link) has been observed on a real hop even though the surrounding sentence
  // translates fine. Only flagged when the source itself wasn't already an
  // intentionally empty pair.
  const EMPTY_TAG_RE = /<(\d+)>\s*<\/\1>/;
  const suspicionKind = (src: string, o: string): IssueKind | undefined =>
    o.length > 3 * src.length + 20
      ? "suspicious-length"
      : /(\b\p{L}+\b)(?:\W+\1\b){3,}/u.test(o)
        ? "repetition"
        : EMPTY_TAG_RE.test(o) && !EMPTY_TAG_RE.test(src)
          ? "empty-tag"
          : undefined;

  const jobs = units.map((unit) => {
    const masked = mask(unit.text, style, opts.protect);
    const pieces = hasTranslatableText(masked.text)
      ? splitSentences(masked.text, opts.sourceLang).map((p) =>
          p.translate && !hasTranslatableText(p.value) ? { translate: false, value: p.value } : p,
        )
      : [];
    const sentenceCount = pieces.filter((p) => p.translate).length;
    // The source's own separators (newlines, surrounding whitespace) are kept and
    // reinserted verbatim below rather than sent to the model — flatInput joins just
    // the sentences themselves with a plain space, same as each is already sent on its
    // own. isAllCaps is excluded: prepare()/postprocess() assume a single
    // sentence-initial letter to re-case, which a multi-sentence ALL-CAPS string would break.
    const flatInput = sentenceCount > 1 && !isAllCaps(masked.text) ? pieces.filter((p) => p.translate).map((p) => p.value).join(" ") : undefined;
    return { unit, masked, pieces, sentenceCount, flatInput };
  });

  const inputs = new Set<string>();
  for (const j of jobs) {
    for (const p of j.pieces) if (p.translate) inputs.add(prepare(p.value));
    // OPUS-MT sometimes silently drops a whole sentence from a multi-sentence input
    // (see segment.ts), which is why each sentence is normally translated on its own —
    // but that loses any agreement carried across sentences (a pronoun's gender from an
    // earlier sentence's noun: "Your export is ready. It will be..." -> fr "Elle", not
    // "Il", since "exportation" is feminine). Translate the whole text too, in the same
    // batch, and prefer it below when it doesn't look like anything got dropped.
    if (j.flatInput !== undefined) inputs.add(prepare(j.flatInput));
  }
  const results = await runModels(inputs, hops, opts, progress);

  for (const { unit, masked, pieces, sentenceCount, flatInput } of jobs) {
    if (pieces.length === 0) {
      unit.result = unit.text; // nothing to translate: placeholders, numbers, punctuation
      continue;
    }

    if (flatInput !== undefined) {
      const wholeOut = results.get(prepare(flatInput)) ?? "";
      if (!isDegenerate(flatInput, wholeOut) && suspicionKind(flatInput, wholeOut) === undefined) {
        const wholePost = postprocess(flatInput, wholeOut, opts.targetLang);
        // An exact sentence-count match is required, not just "enough": only then does
        // the original separators/non-translatable pieces below zip back up unambiguously
        // against the model's own sentence boundaries. Anything else (one merged away,
        // one split in two) falls back to the per-sentence path instead of guessing.
        const outSentences = splitSentences(wholePost, opts.targetLang)
          .filter((p) => p.translate)
          .map((p) => p.value);
        if (outSentences.length === sentenceCount) {
          let i = 0;
          const joined = pieces
            .map((p) => (p.translate ? outSentences[i++] : NO_SPACES.test(opts.targetLang) ? p.value.replace(/^[ \t]+$/, "") : p.value))
            .join("");
          const restored = unmask(joined, masked);
          if (restored !== undefined) {
            unit.result = fixTagSpacing(unit.text, restored, masked.tokens);
            continue;
          }
        }
      }
    }

    let ok = true;
    const found: Issue[] = [];
    const parts = await Promise.all(
      pieces.map(async (p) => {
        // No spaces between sentences in Chinese, Japanese, Thai...
        if (!p.translate) return NO_SPACES.test(opts.targetLang) ? p.value.replace(/^[ \t]+$/, "") : p.value;
        let out = results.get(prepare(p.value)) ?? "";
        let degenerate = isDegenerate(p.value, out);
        let kind = degenerate ? undefined : suspicionKind(p.value, out);
        // Quantizing a batched tensor computes scale factors from the whole batch, so one
        // row's output can depend on what else shared its batch. Retrying the same input
        // alone (batch of 1) often clears a hallucination that batch composition caused.
        if (degenerate || kind !== undefined) {
          const retry = await runModels(new Set([prepare(p.value)]), hops, opts, progress);
          const retryOut = retry.get(prepare(p.value)) ?? out;
          const retryDegenerate = isDegenerate(p.value, retryOut);
          if (!retryDegenerate && suspicionKind(p.value, retryOut) === undefined) {
            out = retryOut;
            degenerate = false;
            kind = undefined;
          }
        }
        if (degenerate) ok = false;
        else if (kind) found.push({ source: unit.owner, kind, output: out });
        return postprocess(p.value, out, opts.targetLang);
      }),
    );
    const joined = parts.join("");
    const restored = ok ? unmask(joined, masked) : undefined;
    if (restored === undefined) failed.push(unit);
    else {
      unit.result = fixTagSpacing(unit.text, restored, masked.tokens);
      issues.push(...found);
    }
  }
  return failed;
}

/**
 * Last resort: translate the text between placeholders separately and keep the
 * placeholders in their source positions. Always structurally valid, sometimes clunky.
 */
async function splitFallback(
  units: Unit[],
  hops: Translator[],
  opts: EngineOptions,
  progress: Progress,
  issues: Issue[],
): Promise<void> {
  const jobs = units.map((unit) => ({ unit, masked: mask(unit.text, "natural", opts.protect) }));
  const chunks = new Set<string>();
  for (const { masked } of jobs) {
    for (const part of splitOnTokens(masked.text)) {
      if (!part.token && hasTranslatableText(part.value)) {
        chunks.add(prepare(/^[\s\p{P}]*([\s\S]*?)[\s\p{P}]*$/u.exec(part.value)![1]));
      }
    }
  }
  const results = await runModels(chunks, hops, opts, progress);
  for (const { unit, masked } of jobs) {
    const text = splitOnTokens(masked.text)
      .map((part) => {
        if (part.token || !hasTranslatableText(part.value)) return part.value;
        const [, lead, core, trail] = /^([\s\p{P}]*)([\s\S]*?)([\s\p{P}]*)$/u.exec(part.value)!;
        const out = results.get(prepare(core)) ?? "";
        const text = isDegenerate(core, out) ? core : postprocess(core, out, opts.targetLang);
        return NO_SPACES.test(opts.targetLang)
          ? lead.replace(/\s+/g, "") + text + trail.replace(/\s+/g, "")
          : lead + text + trail;
      })
      .join("");
    const finalText = /^zh\b/.test(opts.targetLang) ? fixCjk(text) : text;
    unit.result = unmask(finalText, masked) ?? unit.text;
    issues.push({ source: unit.owner, kind: "placeholder-fallback", output: unit.result });
  }
}

/**
 * A cardinal "one" slot's source is grammatically singular ("You have {{count}} file",
 * Android's "%d file", gettext's "%d file"), but the masked marker that stands in for
 * its count placeholder ({{count}}, %d, #, ...) carries no number of its own, so the
 * model sometimes still produces the target's PLURAL noun form (confirmed: en→fr
 * "fileCount_one" came back "Vous avez {{count}} fichiers"). Retranslating with a
 * literal "1" in the placeholder's place gives the model the real grammatical cue;
 * only applied when that placeholder is the string's only one (anything else needs the
 * normal masking pipeline to survive), and only kept when exactly one standalone "1"
 * survives translation — a source string that already had its own unrelated literal
 * "1" ("{{count}} of 1 total") would otherwise risk restoring the wrong occurrence if
 * translation reordered the two, silently freezing the actual count as a literal "1"
 * and corrupting the unrelated one into the placeholder instead.
 *
 * All qualifying keys are retranslated in one `runModels` call (which itself batches by
 * `opts.batchSize`), not one model call per key — a project with hundreds of plural keys
 * would otherwise pay for a separate, unbatched beam search per key here.
 */
async function fixSingularGrammar(
  translations: Map<string, string>,
  singularHints: Set<string>,
  remaining: Set<string>,
  hops: Translator[],
  opts: EngineOptions,
  progress: Progress,
): Promise<void> {
  const jobs: Array<{ source: string; pinned: string; prepared: string; marker: string }> = [];
  for (const s of singularHints) {
    if (!remaining.has(s) || translations.get(s) === undefined) continue;
    // Masking (with `opts.protect`) is used only to decide eligibility here: if a
    // doNotTranslate match is present alongside the count placeholder, `tokens`
    // has more than one entry and this retry is skipped, same as any other
    // string too complex for this narrow single-placeholder rewrite. Once eligible,
    // that single token IS the count placeholder, whatever its own shape, and it
    // appears in `s` exactly once (masking would have produced a second token for a
    // second occurrence) — safe to locate with a plain `indexOf` and pin to "1".
    const tokens = mask(s, "natural", opts.protect).tokens;
    if (tokens.length !== 1) continue;
    const marker = tokens[0];
    const index = s.indexOf(marker);
    if (index < 0) continue;
    const pinned = s.slice(0, index) + "1" + s.slice(index + marker.length);
    jobs.push({ source: s, pinned, prepared: prepare(pinned), marker });
  }
  if (!jobs.length) return;
  const outputs = await runModels(new Set(jobs.map((j) => j.prepared)), hops, opts, progress);
  for (const { source: s, pinned, prepared, marker } of jobs) {
    const out = outputs.get(prepared) ?? "";
    if (isDegenerate(pinned, out)) continue;
    const post = postprocess(pinned, out, opts.targetLang);
    const matches = [...post.matchAll(/(?<![\d.])1(?![\d.])/g)];
    if (matches.length !== 1) continue; // no match, or ambiguous: keep the original translation
    const restored = matches[0];
    translations.set(s, post.slice(0, restored.index) + marker + post.slice(restored.index! + 1));
  }
}

const HASH_PLACEHOLDER = "{__HASH__}";

/**
 * The ICU-plural analogue of `fixSingularGrammar`, above: a `plural` argument's
 * "one" option body ("# file") is grammatically singular, but the masked
 * `{__HASH__}` standing in for `#` carries no number of its own, so the model can
 * still produce the target's plural noun there too (confirmed: en→fr "one {# file}"
 * kept the French plural "fichiers" rather than the singular "fichier"). Retranslating
 * with a literal "1" in {__HASH__}'s place gives the model the same real grammatical
 * cue `fixSingularGrammar` already supplies for an i18next "_one" key.
 */
async function fixIcuOneUnits(
  plans: Array<{ oneUnitIndexes: number[]; units: Unit[] }>,
  hops: Translator[],
  opts: EngineOptions,
  progress: Progress,
): Promise<void> {
  const jobs: Array<{ unit: Unit; pinned: string; prepared: string }> = [];
  for (const p of plans) {
    for (const i of p.oneUnitIndexes) {
      const unit = p.units[i];
      // Same reasoning as `fixSingularGrammar`, above: `opts.protect`-aware masking is
      // used only for the eligibility check (a doNotTranslate match present alongside
      // `{__HASH__}` disqualifies this retry), not to build `pinned` — `unit.text` still
      // has the literal `{__HASH__}` text, unlike `masked.text`, whose span is already
      // a generic marker that `HASH_PLACEHOLDER.replace` can never find.
      const tokens = mask(unit.text, "natural", opts.protect).tokens;
      if (tokens.length !== 1 || tokens[0] !== HASH_PLACEHOLDER) continue; // anything else needs the normal masking pipeline to survive
      const pinned = unit.text.replace(HASH_PLACEHOLDER, "1");
      jobs.push({ unit, pinned, prepared: prepare(pinned) });
    }
  }
  if (!jobs.length) return;
  const outputs = await runModels(new Set(jobs.map((j) => j.prepared)), hops, opts, progress);
  for (const { unit, pinned, prepared } of jobs) {
    const out = outputs.get(prepared) ?? "";
    if (isDegenerate(pinned, out)) continue;
    const post = postprocess(pinned, out, opts.targetLang);
    const matches = [...post.matchAll(/(?<![\d.])1(?![\d.])/g)];
    if (matches.length !== 1) continue; // no match, or ambiguous: keep the original translation
    const restored = matches[0];
    unit.result = post.slice(0, restored.index) + HASH_PLACEHOLDER + post.slice(restored.index! + 1);
  }
}

export async function translateStrings(
  strings: string[],
  hops: Translator[],
  opts: EngineOptions,
): Promise<EngineResult> {
  const issues: Issue[] = [];
  const progress: Progress = { done: 0, total: 0 };

  const translations = new Map<string, string>();
  const remaining: string[] = [];
  for (const s of new Set(strings)) {
    const hit = opts.lookup?.(s);
    if (hit !== undefined) translations.set(s, hit);
    else remaining.push(s);
  }

  const plans = remaining.map((s) => {
    const icu = extractIcu(s);
    const split = icu ?? extractPipePlural(s);
    return {
      source: s,
      split,
      oneUnitIndexes: icu?.oneUnitIndexes ?? [],
      units: (split?.units ?? [s]).map((text): Unit => ({ text, owner: s })),
    };
  });
  const units = plans.flatMap((p) => p.units);

  let pending = units;
  for (const style of ["natural", "numeric", "opaque"] as const) {
    if (pending.length) pending = await attempt(pending, style, hops, opts, progress, issues);
  }
  if (pending.length) await splitFallback(pending, hops, opts, progress, issues);
  await fixUntranslatedTagTexts(units, hops, opts, progress, issues);
  if (plans.some((p) => p.oneUnitIndexes.length)) await fixIcuOneUnits(plans, hops, opts, progress);

  for (const p of plans) {
    const parts = p.units.map((u) => u.result ?? u.text);
    translations.set(p.source, p.split ? p.split.rebuild(parts) : parts[0]);
  }
  if (opts.singularHints?.size) await fixSingularGrammar(translations, opts.singularHints, new Set(remaining), hops, opts, progress);
  return { translations, issues };
}

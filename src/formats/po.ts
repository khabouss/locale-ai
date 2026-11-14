import { escapeC, finalNewline, isObj, type LocaleDoc, newObj, unescapeC, withNewline } from "./shared.ts";

/**
 * gettext .po: `msgid` is the stable key (kept identical across locales, as gettext
 * requires); the translatable value is `msgstr`. Plural entries (`msgid_plural` /
 * `msgstr[n]`) and the "" header entry are carried through unchanged (not translated).
 */
interface PoEntry {
  comments: string[];
  msgctxt?: string;
  msgid: string;
  msgidPlural?: string;
  msgstrPlural?: string[];
  msgstr: string;
  isHeader: boolean;
}
const poKey = (e: { msgctxt?: string; msgid: string }) => (e.msgctxt ?? "") + "\u0004" + e.msgid;

/**
 * gettext's well-established Plural-Forms formulas, keyed by language. Copying the
 * source header's line verbatim (as a naive patch does) is wrong whenever the target
 * needs a different count — Arabic needs 6 categories, an English source's line says
 * 2, and anything consuming the .po indexes msgstr[] short or drops forms silently.
 */
const PLURAL_FORMS: Record<string, string> = {
  ja: "nplurals=1; plural=0;",
  zh: "nplurals=1; plural=0;",
  ko: "nplurals=1; plural=0;",
  th: "nplurals=1; plural=0;",
  vi: "nplurals=1; plural=0;",
  id: "nplurals=1; plural=0;",
  ms: "nplurals=1; plural=0;",
  fr: "nplurals=2; plural=(n > 1);",
  pt: "nplurals=2; plural=(n != 1);",
  // Brazilian Portuguese: conventionally only n==1 is singular (unlike pt-PT's n!=1,
  // which also treats 0 as singular) — must be looked up before the bare "pt" entry.
  "pt-br": "nplurals=2; plural=(n > 1);",
  cs: "nplurals=3; plural=(n==1) ? 0 : (n>=2 && n<=4) ? 1 : 2;",
  sk: "nplurals=3; plural=(n==1) ? 0 : (n>=2 && n<=4) ? 1 : 2;",
  pl: "nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2);",
  ru: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2);",
  uk: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2);",
  // Croatian, Serbian, Bosnian: same "Russian-type" rule as pl/ru/uk above.
  hr: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2);",
  sr: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2);",
  bs: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2);",
  // Lithuanian: its own "ends in 1, not 11" rule (the %100 window differs from Slavic).
  lt: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && (n%100<10 || n%100>=20) ? 1 : 2);",
  // Slovenian: one/two/few/other by n%100, not n%10.
  sl: "nplurals=4; plural=(n%100==1 ? 0 : n%100==2 ? 1 : n%100==3 || n%100==4 ? 2 : 3);",
  ro: "nplurals=3; plural=(n==1 ? 0 : (n==0 || (n%100 > 0 && n%100 < 20)) ? 1 : 2);",
  ar: "nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 && n%100<=99 ? 4 : 5);",
};

/**
 * Falls back to CLDR's plural category count (via Intl.PluralRules) for a language
 * not in the table above: not necessarily linguistically exact (it buckets purely by
 * small integer value), but it keeps nplurals correct, which is the part that breaks
 * gettext consumers when wrong.
 */
function pluralFormsHeader(lang: string): string {
  const norm = lang.toLowerCase().replace(/_/g, "-");
  const known = PLURAL_FORMS[norm] ?? PLURAL_FORMS[norm.split("-")[0]];
  if (known) return known;
  let n: number;
  try {
    n = new Intl.PluralRules(norm).resolvedOptions().pluralCategories.length;
  } catch {
    n = 2;
  }
  if (n <= 1) return "nplurals=1; plural=0;";
  if (n === 2) return "nplurals=2; plural=(n != 1);";
  const branches = Array.from({ length: n - 1 }, (_, i) => `n==${i + 1} ? ${i} :`).join(" ");
  return `nplurals=${n}; plural=(${branches} ${n - 1});`;
}

/** The `nplurals=N` count from pluralFormsHeader, for expanding msgstr[] to the right length. */
function pluralCount(lang: string): number {
  return Number(/nplurals=(\d+)/.exec(pluralFormsHeader(lang))![1]);
}

/**
 * Which `msgstr[]` index a language's own Plural-Forms formula resolves to for n==1
 * — almost always 0, but not for Arabic, whose formula puts n==0 ("zero") at index
 * 0 and n==1 ("one") at index 1. Evaluating the formula itself (rather than assuming
 * index 0) keeps this self-consistent with whatever `pluralCount`/`pluralFormsHeader`
 * already wrote for the same language, for every hardcoded and CLDR-derived case.
 */
function singularIndex(lang: string): number {
  const expr = /plural=(.*);\s*$/.exec(pluralFormsHeader(lang))![1];
  try {
    // The expression is always one of this file's own hardcoded/generated strings,
    // never user input, and is just a ternary chain over `n` — safe to evaluate.
    return Number(new Function("n", `return (${expr});`)(1));
  } catch {
    return 0;
  }
}

function parsePo(text: string): { entries: PoEntry[]; leading: string[] } {
  const entries: PoEntry[] = [];
  let leading: string[] = [];
  let cur = { comments: [] as string[] } as Partial<PoEntry> & { comments: string[] };
  let field: string | null = null;
  let buf = "";
  const flushField = () => {
    if (field === null) return;
    const val = unescapeC(buf);
    if (field === "msgctxt") cur.msgctxt = val;
    else if (field === "msgid") cur.msgid = val;
    else if (field === "msgid_plural") cur.msgidPlural = val;
    else if (field === "msgstr") cur.msgstr = val;
    else (cur.msgstrPlural ??= [])[Number(field.slice(7, -1))] = val;
    field = null;
    buf = "";
  };
  const flushEntry = () => {
    flushField();
    if (cur.msgid !== undefined) {
      entries.push({ comments: cur.comments, msgctxt: cur.msgctxt, msgid: cur.msgid, msgidPlural: cur.msgidPlural,
        msgstrPlural: cur.msgstrPlural, msgstr: cur.msgstr ?? "", isHeader: cur.msgid === "" && cur.msgctxt === undefined });
    } else if (entries.length === 0 && cur.comments.length && leading.length === 0) {
      leading = cur.comments;
    }
    cur = { comments: [] };
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      flushEntry();
      continue;
    }
    let m: RegExpExecArray | null;
    if (/^#/.test(line)) {
      flushField();
      cur.comments.push(line);
    } else if ((m = /^msgctxt\s+"((?:\\.|[^"\\])*)"\s*$/.exec(line))) {
      flushField();
      field = "msgctxt";
      buf = m[1];
    } else if ((m = /^msgid_plural\s+"((?:\\.|[^"\\])*)"\s*$/.exec(line))) {
      flushField();
      field = "msgid_plural";
      buf = m[1];
    } else if ((m = /^msgid\s+"((?:\\.|[^"\\])*)"\s*$/.exec(line))) {
      flushField();
      field = "msgid";
      buf = m[1];
    } else if ((m = /^msgstr\[(\d+)\]\s+"((?:\\.|[^"\\])*)"\s*$/.exec(line))) {
      flushField();
      field = `msgstr[${m[1]}]`;
      buf = m[2];
    } else if ((m = /^msgstr\s+"((?:\\.|[^"\\])*)"\s*$/.exec(line))) {
      flushField();
      field = "msgstr";
      buf = m[1];
    } else if ((m = /^"((?:\\.|[^"\\])*)"\s*$/.exec(line))) {
      buf += m[1];
    }
  }
  flushEntry();
  return { entries, leading };
}

/** Synthetic data keys for a plural entry's two translatable forms. */
const pluralOneKey = (e: { msgctxt?: string; msgid: string }) => poKey(e) + "\u0005one";
const pluralOtherKey = (e: { msgctxt?: string; msgid: string }) => poKey(e) + "\u0005other";

/** Adds a `#, fuzzy` gettext flag to a comment block, merging onto an existing `#,` line rather than duplicating it. */
function withFuzzyFlag(comments: string[]): string[] {
  const i = comments.findIndex((c) => /^#,/.test(c));
  if (i === -1) return [...comments, "#, fuzzy"];
  if (/\bfuzzy\b/.test(comments[i])) return comments;
  return comments.map((c, j) => (j === i ? `${c}, fuzzy` : c));
}

export function readPoDoc(file: string, text: string, isSource: boolean, fuzzy: boolean, tag: string): LocaleDoc {
  const { entries, leading } = parsePo(text);
  const data = newObj();
  for (const e of entries) {
    if (e.isHeader) continue;
    if (e.msgidPlural === undefined) {
      // A template (.pot) or a project that keeps the English text in msgid and
      // leaves the source .po's own msgstr empty: fall back to msgid so the source
      // text isn't just "", which would otherwise translate every entry to nothing
      // with no warning. Never done for a target file, where an empty msgstr
      // legitimately means "not translated yet".
      data[poKey(e)] = isSource && e.msgstr === "" ? e.msgid : e.msgstr;
    } else {
      // Like msgstr for a singular entry, msgstrPlural holds this FILE's own text: the
      // English source form in the source .po, the translated forms in a target .po
      // (msgid/msgid_plural are the stable keys, identical across every locale).
      const forms = e.msgstrPlural ?? [];
      const useMsgid = isSource && forms.every((f) => f === "");
      // Which index is the singular ("one") form is this FILE's own language's own
      // call (see singularIndex) — almost always 0, but 1 for Arabic, whose index 0
      // is the "zero" category instead.
      const oneIdx = singularIndex(tag);
      data[pluralOneKey(e)] = useMsgid ? e.msgid : forms[oneIdx] ?? "";
      data[pluralOtherKey(e)] = useMsgid ? e.msgidPlural! : forms[forms.length - 1] ?? forms[oneIdx] ?? "";
    }
  }
  const keepNewline = finalNewline(text);
  const serialize = (d: unknown, targetTag: string, existingText?: string): string => {
    const obj = isObj(d) ? d : newObj();
    const seen = new Set<string>();
    const blocks: string[] = leading.length ? [leading.join("\n")] : [];
    const existingEntries = existingText ? parsePo(existingText).entries : [];
    // A previous run may have left a header a translator then hand-fixed (a corrected
    // Plural-Forms, an added Last-Translator, ...). Keep it as-is rather than
    // regenerating from the source every time; only a brand-new target file gets a
    // freshly computed header.
    const existingHeader = existingEntries.find((e) => e.isHeader);
    // Comments (translator notes, `#, fuzzy` flags, ...) a translator may have added
    // directly to the target file, keyed the same way entries are. Previously
    // serialize always used the SOURCE's own comments for every entry, silently
    // wiping anything a translator had added to the target on the very next run.
    const existingByKey = new Map(existingEntries.filter((e) => !e.isHeader).map((e) => [poKey(e), e]));
    for (const e of entries) {
      if (e.isHeader) {
        const lines = [...e.comments, `msgid ""`];
        const header = existingHeader
          ? existingHeader.msgstr
          : e.msgstr.replace(/^Language:.*$/m, `Language: ${targetTag}`).replace(/^Plural-Forms:.*$/m, `Plural-Forms: ${pluralFormsHeader(targetTag)}`);
        // gettext convention: msgstr "" followed by one continuation-string literal per
        // header field, each still ending in its own "\n" — not every field escaped into
        // a single line, which is valid .po but turns any one field's edit into a
        // whole-header diff instead of a one-line one.
        const fields = header.split("\n");
        if (fields.at(-1) === "") fields.pop();
        if (fields.length > 1) lines.push(`msgstr ""`, ...fields.map((f) => `"${escapeC(f + "\n")}"`));
        else lines.push(`msgstr "${escapeC(header)}"`);
        blocks.push(lines.join("\n"));
        continue;
      }
      const existingEntry = existingByKey.get(poKey(e));
      let comments = existingEntry?.comments ?? e.comments;
      const content: string[] = [];
      if (e.msgctxt !== undefined) content.push(`msgctxt "${escapeC(e.msgctxt)}"`);
      let changed: boolean;
      if (e.msgidPlural !== undefined) {
        content.push(`msgid "${escapeC(e.msgid)}"`, `msgid_plural "${escapeC(e.msgidPlural)}"`);
        const oneKey = pluralOneKey(e);
        const otherKey = pluralOtherKey(e);
        seen.add(oneKey);
        seen.add(otherKey);
        const one = typeof obj[oneKey] === "string" ? (obj[oneKey] as string) : e.msgid;
        const other = typeof obj[otherKey] === "string" ? (obj[otherKey] as string) : e.msgidPlural;
        const n = pluralCount(targetTag);
        const oneIdx = singularIndex(targetTag);
        // Not full grammatical inflection (same simplification as addPluralForms for
        // i18next): the index the target's own formula resolves to for n==1 gets the
        // singular-sourced form (0 for almost every language, but 1 for Arabic, whose
        // index 0 is the "zero" category), every other index the plural-sourced one.
        // A language with only one category (ja, zh, ...) gets just the plural form,
        // since it has no separate singular count.
        for (let i = 0; i < n; i++) content.push(`msgstr[${i}] "${escapeC(n === 1 ? other : i === oneIdx ? one : other)}"`);
        const forms = existingEntry?.msgstrPlural;
        changed = !forms || forms[oneIdx] !== one || forms[forms.length - 1] !== other;
      } else {
        const key = poKey(e);
        seen.add(key);
        const v = typeof obj[key] === "string" ? (obj[key] as string) : "";
        content.push(`msgid "${escapeC(e.msgid)}"`, `msgstr "${escapeC(v)}"`);
        changed = existingEntry?.msgstr !== v;
      }
      if (fuzzy && changed) comments = withFuzzyFlag(comments);
      blocks.push([...comments, ...content].join("\n"));
    }
    for (const k of Object.keys(obj)) {
      if (seen.has(k) || typeof obj[k] !== "string") continue;
      const i = k.indexOf("\u0004");
      const ctx = i === -1 ? undefined : k.slice(0, i);
      const id = i === -1 ? k : k.slice(i + 1);
      const lines = ctx ? [`msgctxt "${escapeC(ctx)}"`] : [];
      lines.push(`msgid "${escapeC(id)}"`, `msgstr "${escapeC(obj[k] as string)}"`);
      blocks.push(lines.join("\n"));
    }
    return withNewline(blocks.join("\n\n"), keepNewline);
  };
  return { data, serialize };
}

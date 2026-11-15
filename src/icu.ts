/**
 * Just enough ICU MessageFormat to translate plural / select messages:
 *
 *   "{count, plural, one {# file} other {# files}} selected"
 *
 * Only the human text is sent to the model: each option body and each text run
 * around complex arguments becomes a separate unit. Simple arguments (`{name}`)
 * stay inline and are protected by the regular placeholder masking; `#` becomes
 * `{__HASH__}` so it is masked too.
 */

type Node =
  | { kind: "text"; value: string }
  | { kind: "choice"; name: string; type: string; offset?: string; options: Array<{ key: string; body: Node[] }> };

const HASH = "{__HASH__}";
const COMPLEX_RE = /\{\s*[\w.]+\s*,\s*(plural|select|selectordinal)\s*,/;

/**
 * Markup tags. An attribute can carry a copy of an ICU message without the string
 * itself being one: Angular's XLIFF leaves `<x id="ICU" equiv-text="{n, plural, …}"/>`
 * in a sentence and extracts the ICU as its own unit. Read as an ICU message, that
 * copy got translated inside the tag, corrupting the XLIFF (invalid XML, or the
 * attribute leaking into the visible text) — so it's detected outside tags only.
 */
const TAG_RE = /<[^<>]*>/g;

export const isIcuComplex = (s: string) => COMPLEX_RE.test(s.replace(TAG_RE, ""));

class Parser {
  pos = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  message(inPlural: boolean, closing: boolean): Node[] {
    const nodes: Node[] = [];
    let text = "";
    const flush = () => {
      if (text) nodes.push({ kind: "text", value: text });
      text = "";
    };
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === "}") {
        if (!closing) throw new Error("Unbalanced }");
        break;
      }
      if (c === "#" && inPlural) {
        text += HASH;
        this.pos++;
        continue;
      }
      if (c === "{") {
        const choice = this.tryChoice();
        if (choice) {
          flush();
          nodes.push(choice);
        } else {
          text += this.balanced();
        }
        continue;
      }
      text += c;
      this.pos++;
    }
    flush();
    return nodes;
  }

  /** Consumes a `{...}` group verbatim (simple argument). */
  balanced(): string {
    const start = this.pos;
    let depth = 0;
    do {
      const c = this.s[this.pos++];
      if (c === undefined) throw new Error("Unbalanced {");
      if (c === "{") depth++;
      else if (c === "}") depth--;
    } while (depth > 0);
    return this.s.slice(start, this.pos);
  }

  tryChoice(): Node | undefined {
    const m = /^\{\s*([\w.]+)\s*,\s*(plural|select|selectordinal)\s*,/.exec(this.s.slice(this.pos));
    if (!m) return undefined;
    this.pos += m[0].length;
    const node: Extract<Node, { kind: "choice" }> = { kind: "choice", name: m[1], type: m[2], options: [] };
    const plural = m[2] !== "select";
    for (;;) {
      this.ws();
      if (this.s[this.pos] === "}") {
        this.pos++;
        break;
      }
      const off = /^offset:\s*(\d+)/.exec(this.s.slice(this.pos));
      if (off) {
        node.offset = off[1];
        this.pos += off[0].length;
        continue;
      }
      const key = /^(=\d+|[\w-]+)/.exec(this.s.slice(this.pos));
      if (!key) throw new Error(`Bad ICU selector at ${this.pos}`);
      this.pos += key[0].length;
      this.ws();
      if (this.s[this.pos] !== "{") throw new Error(`Expected { at ${this.pos}`);
      this.pos++;
      const body = this.message(plural, true);
      if (this.s[this.pos] !== "}") throw new Error("Unbalanced ICU option");
      this.pos++;
      node.options.push({ key: key[0], body });
    }
    if (!node.options.some((o) => o.key === "other")) throw new Error("ICU choice without 'other'");
    return node;
  }

  ws() {
    while (/\s/.test(this.s[this.pos] ?? "")) this.pos++;
  }
}

export interface IcuUnits {
  /** Texts to translate (may contain simple `{args}` and `{__HASH__}`). */
  units: string[];
  /**
   * Index into `units` of each cardinal `plural` choice's "one" option body (when
   * that body is plain text, not a further nested choice) — the ICU analogue of an
   * i18next "_one" key: grammatically singular text whose masked `{__HASH__}` carries
   * no number of its own, so it qualifies for the same literal-"1" retranslation fix
   * (see `fixSingularGrammar`/`fixIcuOneUnits` in engine.ts).
   */
  oneUnitIndexes: number[];
  rebuild(translations: string[]): string;
}

/** Returns undefined when the string is not a (valid) complex ICU message. */
export function extractIcu(s: string): IcuUnits | undefined {
  if (!isIcuComplex(s)) return undefined;
  let nodes: Node[];
  try {
    const p = new Parser(s);
    nodes = p.message(false, false);
  } catch {
    return undefined;
  }
  const units: string[] = [];
  const oneUnitIndexes: number[] = [];
  const collect = (list: Node[]) => {
    for (const n of list) {
      if (n.kind === "text") units.push(n.value);
      else {
        for (const o of n.options) {
          if (n.type === "plural" && o.key === "one" && o.body.length === 1 && o.body[0].kind === "text") {
            oneUnitIndexes.push(units.length);
          }
          collect(o.body);
        }
      }
    }
  };
  collect(nodes);

  return {
    units,
    oneUnitIndexes,
    rebuild(translations) {
      let i = 0;
      const render = (list: Node[]): string =>
        list
          .map((n) => {
            if (n.kind === "text") return translations[i++].split(HASH).join("#");
            const opts = n.options.map((o) => `${o.key} {${render(o.body)}}`).join(" ");
            return `{${n.name}, ${n.type},${n.offset ? ` offset:${n.offset}` : ""} ${opts}}`;
          })
          .join("");
      return render(nodes);
    },
  };
}

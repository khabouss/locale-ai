import { Document, isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { finalNewline, isObj, type LocaleDoc, type Obj, withNewline } from "./shared.ts";

export function readJsonDoc(file: string, text: string): LocaleDoc {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${(e as Error).message}`);
  }
  const indent = /^[{[]\r?\n([ \t]+)/.exec(text)?.[1] ?? (text.includes("\n") ? 2 : 0);
  const keepNewline = finalNewline(text);
  return { data, serialize: (d) => withNewline(JSON.stringify(d, null, indent), keepNewline) };
}

/** Renames a single-key document's top-level key, keeping that key's own comments. */
function rewrapKey(doc: Document, tag: string): void {
  const map = doc.contents;
  if (isMap(map) && map.items.length === 1 && isScalar(map.items[0].key)) {
    map.items[0].key.value = tag;
  } else {
    doc.contents = doc.createNode({ [tag]: doc.toJS() ?? {} }) as typeof doc.contents;
  }
}

/**
 * Writes every string/number/boolean leaf of `v` into `doc` at `base` (plus the
 * leaf's own key path). `Document#setIn` mutates an existing scalar node's value in
 * place rather than replacing it, so any comment already attached to that node (a
 * trailing `# ...`, or one on its own line above) survives untouched; a leaf with no
 * existing node there yet is simply inserted, with no comment of its own.
 */
function setLeaves(doc: Document, base: Array<string | number>, v: unknown): void {
  if (Array.isArray(v)) v.forEach((item, i) => setLeaves(doc, [...base, i], item));
  else if (isObj(v)) for (const [k, val] of Object.entries(v)) setLeaves(doc, [...base, k], val);
  else setLeaf(doc, base, v);
}

/**
 * `Document#setIn` matches an existing map pair by strict key equality, but every key
 * `setLeaves` passes here comes from a plain JS object (`Object.keys`/array index),
 * so it's always a string or a number *in JS's own sense* — never the YAML scalar
 * node's own value, which for a bare `404:` is the actual number `404`, parsed from
 * YAML's own type inference, not a string. `setIn` given the string `"404"` then
 * doesn't recognize that number-404 pair as the same key and inserts a second,
 * `"404":`-quoted one next to the original, untouched and still carrying the English
 * text. Looked up by its string form first, so the existing pair (whichever JS type
 * its key happens to be) is updated in place instead, and only a genuinely new key
 * falls through to `setIn`.
 */
function setLeaf(doc: Document, base: Array<string | number>, v: unknown): void {
  const last = base[base.length - 1];
  const parent = doc.getIn(base.slice(0, -1), true);
  if (isMap(parent)) {
    const pair = parent.items.find((p) => String(isScalar(p.key) ? p.key.value : p.key) === String(last));
    if (pair) {
      if (isScalar(pair.value)) pair.value.value = v;
      else pair.value = doc.createNode(v);
      return;
    }
  }
  doc.setIn(base, v);
}

/**
 * `YAMLMap#set` (called by `Document#setIn`, above, for a path that doesn't exist
 * yet) always appends a brand-new pair at the end of its parent map — so a derived
 * plural form like `item_many`, added next to `item_one`/`item_other` in `v` itself,
 * would otherwise land at the very end of the whole mapping instead. Reorders each
 * map's items to match `v`'s own key order, the same position a map built fresh
 * from `v` would already have them in.
 */
function reorderToMatch(doc: Document, base: Array<string | number>, v: unknown): void {
  if (Array.isArray(v)) {
    v.forEach((item, i) => reorderToMatch(doc, [...base, i], item));
    return;
  }
  if (!isObj(v)) return;
  const node = doc.getIn(base);
  if (isMap(node)) {
    const order = Object.keys(v);
    const rank = (pair: { key: unknown }) => {
      // A pre-existing pair's key is a Scalar node; one `setIn` just created for a
      // brand-new key (exactly the case this function exists to fix) is still the
      // plain string/number itself, not yet wrapped in one. Compared by string form
      // (see `setLeaf`, above) since `order` — built from `Object.keys(v)` — only
      // ever holds JS's own always-string keys, never a YAML-native number like 404.
      const k = isScalar(pair.key) ? pair.key.value : pair.key;
      const i = order.indexOf(String(k));
      return i < 0 ? order.length : i; // a key `v` doesn't have (never removed here) sorts last, stable among itself
    };
    node.items.sort((a, b) => rank(a) - rank(b));
  }
  for (const [k, val] of Object.entries(v)) reorderToMatch(doc, [...base, k], val);
}

/** True for a merge-key pair (`<<: *defaults`) parsed with the `merge: true` schema option — its key is a Scalar wrapping `Symbol("<<")`, not the literal string `"<<"`. */
function isMergeKeyPair(pair: { key: unknown }): boolean {
  return isScalar(pair.key) && typeof pair.key.value === "symbol" && pair.key.value.description === "<<";
}

/**
 * `Document#setIn`/`getIn` only walk through real Map/Seq nodes — an ordinary alias
 * used as a pair's value (`profile: *common`) throws `Expected YAML collection at
 * profile` the moment `setLeaves` tries to write anything under it, since the node
 * actually stored there is an `Alias`, not a collection. Replaces every such alias
 * with an independent (anchor-stripped) clone of what it points to, so every path
 * `setLeaves` walks is a real collection by the time it gets there. A merge-key pair
 * (`<<: *defaults`) is left alone — that one already round-trips fine as-is (a new,
 * independent leaf is added alongside it instead, same as any other new key), and
 * resolving it here would inline the whole merged map in place of the `*defaults`
 * reference, losing the point of writing it as a merge key at all.
 */
function resolveAliases(doc: Document, node: unknown): void {
  if (isMap(node)) {
    for (const item of node.items) {
      if (isMergeKeyPair(item)) continue;
      if (isAlias(item.value)) item.value = cloneDealiased(doc, item.value);
      resolveAliases(doc, item.value);
    }
  } else if (isSeq(node)) {
    node.items.forEach((v, i) => {
      if (isAlias(v)) node.items[i] = cloneDealiased(doc, v);
      resolveAliases(doc, node.items[i]);
    });
  }
}

function cloneDealiased(doc: Document, alias: { resolve(doc: Document): unknown }): unknown {
  const target = alias.resolve(doc) as { clone?: () => unknown; anchor?: string } | undefined;
  const cloned = target?.clone ? target.clone() : target;
  if (cloned && typeof cloned === "object" && "anchor" in cloned) (cloned as { anchor?: string }).anchor = undefined;
  return cloned;
}

/**
 * Rails and some other frameworks nest an entire YAML locale file under a single
 * top-level key matching the locale tag itself (`en:\n  hello: Hi`), so the file is
 * valid wherever it's loaded from. Detect that wrapper and unwrap it before handing
 * `data` to the rest of the pipeline (which otherwise treats "en" as just another
 * translatable key), then re-wrap under the target's own tag on serialize.
 *
 * Re-serializing edits an existing YAML document (the target file's own, when it
 * already exists, otherwise a clone of the source's) in place via `setIn` instead of
 * building a plain object and stringifying it from scratch — the latter would throw
 * away every `#` comment in the file on every run.
 */
export function readYamlDoc(file: string, text: string, tag: string): LocaleDoc {
  let srcDoc: Document;
  try {
    srcDoc = parseDocument(text, { merge: true });
  } catch (e) {
    throw new Error(`Invalid YAML in ${file}: ${(e as Error).message}`);
  }
  if (srcDoc.errors.length) throw new Error(`Invalid YAML in ${file}: ${srcDoc.errors[0].message}`);
  const raw = srcDoc.toJS() ?? {};
  const indent = Number(/\n( +)\S/.exec(text)?.[1].length) || 2;
  const keepNewline = finalNewline(text);
  const keys = isObj(raw) ? Object.keys(raw) : [];
  const wrapped = keys.length === 1 && keys[0] === tag;
  const data = wrapped ? (raw as Obj)[tag] : raw;
  const serialize = (d: unknown, targetTag: string, existingText?: string): string => {
    let base: Document | undefined;
    if (existingText !== undefined) {
      try {
        const parsed = parseDocument(existingText, { merge: true });
        if (parsed.errors.length === 0) base = parsed;
      } catch {
        // Fall through to the source clone below.
      }
    }
    base ??= srcDoc.clone();
    if (wrapped) rewrapKey(base, targetTag);
    resolveAliases(base, base.contents);
    setLeaves(base, wrapped ? [targetTag] : [], d);
    reorderToMatch(base, wrapped ? [targetTag] : [], d);
    return withNewline(base.toString({ indent }), keepNewline);
  };
  return { data, serialize };
}

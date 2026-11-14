/** Generic XML entity/tag helpers shared by XLIFF, .resx, and (for XML_TAG_RE only) Android's own escaping. */

/** Any opening/closing/self-closing tag — the same generic shape placeholders.ts already protects (`<b>`, `<x id="..."/>`, `<g id="1">...</g>`). */
export const XML_TAG_RE = /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>/g;

/**
 * The entity-escaped form of XML_TAG_RE (`&lt;b&gt;`, `&lt;a href="x"/&gt;`) — text
 * that documents or displays markup literally (`Use &lt;b&gt; tags to bold text.`),
 * as opposed to `XML_TAG_RE`'s genuine inline markup. Within a `<source>`/`<target>`
 * element's own text, a literal unescaped `<`/`>` can only come from a nested tag
 * (`<bpt>`, inline `<x/>`/`<g>`), never from ordinary text — so there's no unescaped
 * `<`/`>` for this to collide with inside the span it matches.
 */
const ESCAPED_XML_TAG_RE = /&lt;\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?&gt;/g;

/**
 * XLIFF/.resx's `&entity;` references and `<![CDATA[...]]>` — there's no
 * backslash-escape convention to also handle, unlike Android's XML.
 *
 * An entity-escaped tag-looking span (see `ESCAPED_XML_TAG_RE`) is left exactly as
 * escaped: unescaping it here would turn `Use &lt;b&gt; tags` into the literal text
 * `Use <b> tags`, indistinguishable from source that actually embeds a `<b>` tag —
 * and `escapeXmlKeepTags` (below), unable to tell the two apart on write, would skip
 * re-escaping it as a "real" tag, writing a raw `<b>` into the target and breaking
 * the file's XML. Ordinary `&lt;`/`&gt;` elsewhere (`5 &lt; 10 items`) is still
 * unescaped as before, for natural-looking input to the translation model.
 */
export function unescapeXml(s: string): string {
  const withCdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner);
  let out = "";
  let last = 0;
  for (const m of withCdata.matchAll(ESCAPED_XML_TAG_RE)) {
    out += unescapeXmlEntities(withCdata.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + unescapeXmlEntities(withCdata.slice(last));
}

function unescapeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/**
 * Escapes `&`/`<`/`>` in plain text while leaving any inline tag (`XML_TAG_RE`) or
 * already-escaped tag-looking text (`ESCAPED_XML_TAG_RE`, left exactly as `unescapeXml`
 * passed it through) completely untouched — so a translated value's own `<x .../>`/
 * `<g>...</g>` markup stays valid, literal XML, and text that merely documents markup
 * (`&lt;b&gt;`) isn't double-escaped into `&amp;lt;b&amp;gt;`.
 */
export function escapeXmlKeepTags(s: string): string {
  const escapeText = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tagRe = new RegExp(`${XML_TAG_RE.source}|${ESCAPED_XML_TAG_RE.source}`, "g");
  let out = "";
  let last = 0;
  for (const m of s.matchAll(tagRe)) {
    out += escapeText(s.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + escapeText(s.slice(last));
}

/** Sets (inserting if absent) one attribute on a single opening XML tag's raw text. */
export function setXmlAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*"[^"]*"`);
  return re.test(tag) ? tag.replace(re, `${name}="${value}"`) : tag.replace(/\/?>$/, (end) => ` ${name}="${value}"${end}`);
}

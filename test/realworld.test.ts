/**
 * Real-world regression suite: real models (en-fr, en-es, en-de) plus the real
 * toolchains a project ships through (gettext's msgfmt, xmllint). Every scenario here
 * caught a bug that the unit tests — which use fake models — passed: 0.7.29's
 * tag-text pass rewriting `%(title)s` to `%(titre)s` (#65), Angular's
 * `<x id="ICU" equiv-text>` translated inside the tag (#63), `%%` collapsing to `%`
 * in python-format .po (#66), vue-i18n literals and en dashes (#55, #56).
 *
 * Run with: npm run test:realworld (downloads ~570 MB of models on first run).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { translate } from "../src/api.ts";
import { mask } from "../src/placeholders.ts";

const skip = !process.env.LOCALE_AI_E2E;
const LOCALES = ["fr", "es", "de"];
const opts = { skip, timeout: 900_000 };

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lai-rw-${name}-`));
const tokens = (s: string) => mask(s).tokens.toSorted().join("\u0001");
const hasTool = (bin: string) => {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Translates, then checks a second run translates nothing (no repair or retranslation loop). */
async function translateTwice(cwd: string, extra: Record<string, unknown> = {}): Promise<void> {
  const first = await translate({ cwd, from: "en", to: LOCALES, yes: true, ...extra } as Parameters<typeof translate>[0]);
  assert.ok(first.ok, "first run succeeded");
  const second = await translate({ cwd, from: "en", to: LOCALES, yes: true, ...extra } as Parameters<typeof translate>[0]);
  for (const l of second.locales) assert.equal(l.stringsTranslated, 0, `${l.locale}: a second run is a no-op`);
}

test("placeholders, e-mails and URLs survive in every locale — inside tags too", opts, async () => {
  const dir = tmp("placeholders");
  fs.mkdirSync(path.join(dir, "locales"));
  const en = {
    python: "We recommend <em>%(title)s</em> by %(author)s.",
    printf: "Hello <b>%s</b>, you have mail.",
    icu: "Signed in as <strong>{name}</strong> today.",
    i18next: "Welcome back, <1>{{name}}</1>! Nice to see you.",
    email: 'Write to <a href="mailto:help@example.com">help@example.com</a> any time.',
    url: 'Read the docs at <a href="https://example.com/docs">https://example.com/docs</a> first.',
    ruby: "Logged in as <b>%{user}</b> just now.",
    laravel: "The <b>:attribute</b> field is required.",
    vueLiteral: "Questions? Email us at hello{'@'}harbor.cafe or call {0}.",
    vueLinked: "Welcome to @:{'brand'}. We open at {time}.",
    dash: "Monday to Friday: {open} – {close}",
    percent: "Members get 10%% off, %(name)s.",
  };
  fs.writeFileSync(path.join(dir, "locales/en.json"), JSON.stringify(en, null, 2));
  await translateTwice(dir);
  for (const l of LOCALES) {
    const out = JSON.parse(fs.readFileSync(path.join(dir, `locales/${l}.json`), "utf8"));
    for (const [k, v] of Object.entries(en)) assert.equal(tokens(out[k]), tokens(v), `${l}.${k}: ${out[k]}`);
  }
});

test("gettext: python-format .po output passes msgfmt -c (Django's compilemessages)", { ...opts, skip: skip || !hasTool("msgfmt") }, async () => {
  const dir = tmp("po");
  fs.mkdirSync(path.join(dir, "locale/en/LC_MESSAGES"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "locale/en/LC_MESSAGES/django.po"),
    [
      'msgid ""',
      'msgstr ""',
      '"Content-Type: text/plain; charset=UTF-8\\n"',
      '"Plural-Forms: nplurals=2; plural=(n != 1);\\n"',
      "",
      "#, python-format",
      'msgid "This month we recommend <em>%(title)s</em> by %(author)s."',
      'msgstr ""',
      "",
      "#, python-format",
      'msgid "Members get 10%% off every purchase."',
      'msgstr ""',
      "",
      'msgid "Questions? Write to <a href=\\"mailto:hello@example.com\\">hello@example.com</a>."',
      'msgstr ""',
      "",
      "#, python-format",
      'msgid "You have %(count)d book in your basket."',
      'msgid_plural "You have %(count)d books in your basket."',
      'msgstr[0] ""',
      'msgstr[1] ""',
      "",
    ].join("\n"),
  );
  await translateTwice(dir);
  for (const l of LOCALES) {
    const po = path.join(dir, `locale/${l}/LC_MESSAGES/django.po`);
    execFileSync("msgfmt", ["-c", "-o", os.devNull, po], { stdio: "pipe" });
    assert.match(fs.readFileSync(po, "utf8"), /hello@example\.com<\/a>/, `${l}: e-mail kept`);
  }
});

test("XLIFF (Angular): output is well-formed and <x id=\"ICU\" …/> is copied byte for byte", { ...opts, skip: skip || !hasTool("xmllint") }, async () => {
  const dir = tmp("xlf");
  const icu = `<x id="ICU" equiv-text="{appointments, plural, =0 {no upcoming appointments} other {{{ appointments }} upcoming appointments}}" xid="3215479450728839650"/>`;
  const units = [
    `Welcome back, <x id="INTERPOLATION" equiv-text="{{ patient }}"/>! You have ${icu}.`,
    `By booking you agree to our <x id="START_LINK" ctype="x-a" equiv-text="&lt;a href=&quot;#privacy&quot;&gt;"/>privacy policy<x id="CLOSE_LINK" ctype="x-a" equiv-text="&lt;/a&gt;"/>.`,
    `{VAR_PLURAL, plural, =0 {no upcoming appointments} other {<x id="INTERPOLATION" equiv-text="{{ appointments }}"/> upcoming appointments}}`,
    "Open Monday – Saturday, 8:00 – 20:00.",
  ];
  const body = units.map((s, i) => `      <trans-unit id="u${i}" datatype="html">\n        <source>${s}</source>\n      </trans-unit>`).join("\n");
  fs.writeFileSync(
    path.join(dir, "messages.xlf"),
    `<?xml version="1.0" encoding="UTF-8" ?>\n<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">\n  <file source-language="en-US" datatype="plaintext" original="ng2.template">\n    <body>\n${body}\n    </body>\n  </file>\n</xliff>\n`,
  );
  await translateTwice(dir, { input: path.join(dir, "messages.xlf") });
  for (const l of LOCALES) {
    const file = path.join(dir, `messages.${l}.xlf`);
    execFileSync("xmllint", ["--noout", file], { stdio: "pipe" });
    // In the target itself — the untouched <source> carries the same element.
    const target = /<trans-unit id="u0"[\s\S]*?<target[^>]*>([\s\S]*?)<\/target>/.exec(fs.readFileSync(file, "utf8"))?.[1] ?? "";
    assert.ok(target.includes(icu), `${l}: <x id="ICU" …/> intact in ${target}`);
  }
});

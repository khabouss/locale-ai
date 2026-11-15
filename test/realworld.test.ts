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

/** aapt2 and android.jar from the Android SDK (preinstalled on GitHub's ubuntu runners), newest version. */
function androidTools(): { aapt2: string; androidJar: string } | undefined {
  const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!home) return undefined;
  const newest = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) : undefined);
  const bt = newest(path.join(home, "build-tools"));
  const platform = newest(path.join(home, "platforms"));
  if (!bt || !platform) return undefined;
  const aapt2 = path.join(home, "build-tools", bt, "aapt2");
  const androidJar = path.join(home, "platforms", platform, "android.jar");
  return fs.existsSync(aapt2) && fs.existsSync(androidJar) ? { aapt2, androidJar } : undefined;
}

test("Android: translated resources compile and link with aapt2 (CDATA, apostrophes, %, currency, @handles)", { ...opts, skip: skip || !androidTools() }, async () => {
  const tools = androidTools()!;
  const dir = tmp("android");
  fs.mkdirSync(path.join(dir, "res/values"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "res/values/strings.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<resources xmlns:xliff="urn:oasis:names:tc:xliff:document:1.2">
    <string name="app_name" translatable="false">Trailhead</string>
    <string name="welcome">Welcome back, <xliff:g id="user">%1$s</xliff:g>!</string>
    <string name="apostrophe">Don\\'t lose your progress</string>
    <string name="percent" formatted="false">100% done, %s left</string>
    <string name="cdata"><![CDATA[Visit <a href="https://example.com">our site</a> today]]></string>
    <string name="price">Price \\u20AC5</string>
    <string name="handle">Contact us \\@support</string>
    <plurals name="files">
        <item quantity="one">%d file selected</item>
        <item quantity="other">%d files selected</item>
    </plurals>
</resources>
`,
  );
  fs.writeFileSync(path.join(dir, "AndroidManifest.xml"), `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.rw"><application android:label="@string/app_name"/></manifest>`);
  await translateTwice(dir, { input: path.join(dir, "res") });
  const compiled = path.join(dir, "compiled");
  fs.mkdirSync(compiled);
  for (const d of fs.readdirSync(path.join(dir, "res")).filter((d) => d.startsWith("values"))) {
    execFileSync(tools.aapt2, ["compile", "-o", compiled, path.join(dir, "res", d, "strings.xml")], { stdio: "pipe" });
  }
  const flats = fs.readdirSync(compiled).map((f) => path.join(compiled, f));
  execFileSync(tools.aapt2, ["link", "-o", path.join(dir, "app.apk"), "-I", tools.androidJar, "--manifest", path.join(dir, "AndroidManifest.xml"), ...flats], { stdio: "pipe" });
  for (const l of LOCALES) {
    const xml = fs.readFileSync(path.join(dir, `res/values-${l}/strings.xml`), "utf8");
    assert.match(xml, /<string name="cdata"><!\[CDATA\[/, `${l}: CDATA kept`);
    assert.match(xml, /€5/, `${l}: currency kept`);
    assert.match(xml, /@support/, `${l}: handle kept`);
  }
});

test(".NET: satellite assemblies build and string.Format fills {0:P0}/{0:C2}", { ...opts, skip: skip || !hasTool("dotnet") }, async () => {
  const dir = tmp("dotnet");
  fs.mkdirSync(path.join(dir, "Resources"));
  fs.writeFileSync(
    path.join(dir, "App.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><InvariantGlobalization>false</InvariantGlobalization></PropertyGroup></Project>`,
  );
  fs.writeFileSync(
    path.join(dir, "Program.cs"),
    `using System; using System.Globalization; using System.Resources;
var rm = new ResourceManager("App.Resources.Strings", typeof(Program).Assembly);
foreach (var c in args) {
  var ci = new CultureInfo(c);
  Console.WriteLine(c + "|" + string.Format(ci, rm.GetString("Percent", ci)!, 0.15) + "|" + string.Format(ci, rm.GetString("Price", ci)!, 9.5m) + "|" + string.Format(ci, rm.GetString("Items", ci)!, 3, "Nadia"));
}
`,
  );
  fs.writeFileSync(
    path.join(dir, "Resources/Strings.resx"),
    `<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>
  <data name="Percent" xml:space="preserve"><value>Members get {0:P0} off every order.</value></data>
  <data name="Price" xml:space="preserve"><value>Total: {0:C2} including tax</value></data>
  <data name="Items" xml:space="preserve"><value>You have {0} items in your cart, {1}.</value></data>
</root>
`,
  );
  await translateTwice(dir, { input: path.join(dir, "Resources/Strings.resx") });
  const out = execFileSync("dotnet", ["run", "-v", "q", "--", ...LOCALES], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  for (const l of LOCALES) {
    const line = out.split("\n").find((x) => x.startsWith(`${l}|`)) ?? "";
    assert.doesNotMatch(line, /\d:[PC]\d/, `${l}: no unformatted format item in ${line}`);
    assert.match(line, /15/, `${l}: percent formatted in ${line}`);
    assert.match(line, /Nadia/, `${l}: {1} filled in ${line}`);
  }
});

test("Rails: the i18n gem resolves translated YAML (interpolation, plurals, _html keys)", { ...opts, skip: skip || !hasTool("ruby") }, async () => {
  const dir = tmp("rails");
  fs.mkdirSync(path.join(dir, "config/locales"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config/locales/en.yml"),
    `en:
  shop:
    greeting: "Welcome back, %{name}!"
    cart:
      one: "%{count} item in your cart"
      other: "%{count} items in your cart"
    notice_html: "Read our <a href=\\"/terms\\">terms</a> before ordering."
`,
  );
  await translateTwice(dir);
  const gemHome = path.join(dir, "gems");
  execFileSync("gem", ["install", "--no-document", "--install-dir", gemHome, "i18n"], { stdio: "pipe" });
  const script = `require "i18n"
I18n.load_path += Dir[${JSON.stringify(path.join(dir, "config/locales"))} + "/*.yml"]
I18n.available_locales = %i[en ${LOCALES.join(" ")}]
%i[${LOCALES.join(" ")}].each { |l| I18n.with_locale(l) { puts [l, I18n.t("shop.greeting", name: "Nadia"), I18n.t("shop.cart", count: 5), I18n.t("shop.notice_html")].join("|") } }`;
  const out = execFileSync("ruby", ["-e", script], { env: { ...process.env, GEM_HOME: gemHome, GEM_PATH: gemHome }, encoding: "utf8", stdio: "pipe" });
  for (const l of LOCALES) {
    const line = out.split("\n").find((x) => x.startsWith(`${l}|`)) ?? "";
    assert.match(line, /Nadia/, `${l}: %{name} interpolated in ${line}`);
    assert.match(line, /5/, `${l}: %{count} interpolated in ${line}`);
    assert.doesNotMatch(line, /translation missing|%\{/, `${l}: resolved in ${line}`);
    assert.match(line, /<a href="\/terms">[^<]+<\/a>/, `${l}: _html link kept in ${line}`);
  }
});

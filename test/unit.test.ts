import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CATALOG, reachableTargets, resolveRoute } from "../src/catalog.ts";
import { translateStrings } from "../src/engine.ts";
import { extractIcu } from "../src/icu.ts";
import { extractPipePlural } from "../src/vue-plural.ts";
import { parseLocale } from "../src/lang.ts";
import { editedPaths, hashOf, isEdited, isSourceStale, loadLock, lockedPathsFor, pruneDeletedKeys, rebaseLock, recordEntries, saveLock } from "../src/lock.ts";
import {
  addNestedPluralForms,
  addPluralForms,
  buildTarget,
  decodeText,
  detectEncoding,
  detectLayout,
  encodeText,
  existingTargets,
  flattenStrings,
  isPluralCategoryPath,
  keyPathProtect,
  pendingEntries,
  pendingStrings,
  pluralOneStrings,
  readLocaleDoc,
  sourceFiles,
  targetFile,
  usesI18nextPlurals,
} from "../src/locales.ts";
import { accept, check, translate } from "../src/api.ts";
import type { Translator } from "../src/models.ts";
import { hasTranslatableText, mask, unmask } from "../src/placeholders.ts";
import { splitSentences } from "../src/segment.ts";

test("mask protects common placeholder syntaxes", () => {
  const cases: Array<[string, string[]]> = [
    ["Hello {name}!", ["{name}"]],
    ["Hi {{user.name}}, {{count}} new", ["{{user.name}}", "{{count}}"]],
    ["%s of %d, %1$s, %.2f, %@", ["%s", "%d", "%1$s", "%.2f", "%@"]],
    ["range %d-%d", ["%d", "%d"]],
    ["Value: %(amount)s and %{total}", ["%(amount)s", "%{total}"]],
    ["contact $admin or $user_name for help", ["$admin", "$user_name"]],
    ["Click <a href=\"https://x.io/a\">here</a>", ['<a href="https://x.io/a">', "</a>"]],
    ["Press <0>Save</0> then <1/>", ["<0>", "</0>", "<1/>"]],
    ["See $t(common.terms) and @:app.name", ["$t(common.terms)", "@:app.name"]],
    ["Mail support@acme.com or visit https://acme.com.", ["support@acme.com", "https://acme.com"]],
    ["The :attribute field is required", [":attribute"]],
    ["Tom&nbsp;&amp;&nbsp;Jerry", ["&nbsp;", "&amp;", "&nbsp;"]],
    // MessageFormat's lone-literal-brace idiom ('{' / '}', nothing else inside) — too
    // short/unusual on its own for a model to reliably carry through untouched (a real
    // en->fr hop dropped the brace and multiplied the quotes). '{0}'/'{name}' don't
    // need this: the content between their braces is already protected on its own by
    // the ICU-args pattern above.
    ["Use '{' to open a block in {0}", ["'{'", "{0}"]],
    // A curly quote (“ ” ‘ ’) directly touching a placeholder — the Italian and
    // German models garble this exact boundary on a real hop even though they
    // handle the quote character fine elsewhere ("{0}" -> "[55]{0} [56]"). Masked
    // together with the placeholder so the model never sees the raw boundary.
    ["The file “{0}” was deleted.", ["“{0}”"]],
    ["The file ‘{name}’ was deleted.", ["‘{name}’"]],
    // Only a genuine MATCHED pair is absorbed — a curly quote on just one side
    // (an unrelated trailing possessive, a mismatched-style pair) is never swallowed
    // into the same span as the placeholder: doing so used to prevent the model from
    // restructuring the sentence the way the target language needs.
    ["{name}’s profile was updated.", ["{name}"]],
    ["“{0}' trailing", ["{0}"]],
    // XLIFF/.resx text that documents a tag literally (already entity-escaped in the
    // XML itself) — masked as one unit, not split into "&lt;" + a bare, unprotected
    // tag name + "&gt;" by the generic entity-reference pattern below it.
    ["Use &lt;b&gt; tags to bold text.", ["&lt;b&gt;"]],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(mask(input).tokens, expected, input);
  }
});

test("mask leaves ordinary text alone", () => {
  for (const s of [
    "100% sure",
    "Note: read this",
    "Price $5",
    "a < b > c",
    "Hello world.",
    "Get 100%off today", // "%o" is not a stray printf spec glued onto "ff"
    "Price in $USD", // a currency code, not a "$name" placeholder
    "pay in $CAD or $USD",
  ]) {
    assert.deepEqual(mask(s).tokens, [], s);
  }
});

test("© / ® / ™ symbols are masked so a pivoted (two-hop) translation can't drop them", () => {
  const m = mask("© 2026 Acme. All rights reserved.");
  assert.deepEqual(m.tokens, ["©"]);
  assert.equal(unmask("{0} 2026 Acme. Tous droits réservés.", m), "© 2026 Acme. Tous droits réservés.");
  assert.deepEqual(mask("Acme® and AcmePro™").tokens, ["®", "™"]);
});

test("natural markers: {n} for variables, <n>…</n> for tags", () => {
  assert.equal(mask("Hi {{name}}, see <a href=\"/x\">this</a><br/> or <b>that</b>").text, "Hi {0}, see <0>this</0><1/> or <2>that</2>");
  assert.equal(mask("Press <0>Save</0> then <1/>").text, "Press <0>Save</0> then <1/>");
  assert.equal(mask("Hi {{name}} <b>x</b>", "opaque").text, "Hi _P0_ _P1_x_P2_");
});

test("unmask restores markers and tolerates light damage", () => {
  const m = mask("Hello {name}, you have {count} messages");
  assert.equal(unmask("Bonjour {0}, vous avez {1} messages", m), "Bonjour {name}, vous avez {count} messages");
  assert.equal(unmask("Bonjour { 0 }, vous avez {1 } messages", m), "Bonjour {name}, vous avez {count} messages");
  assert.equal(unmask("Bonjour, vous avez {1} messages", m), undefined, "missing marker");
  assert.equal(unmask("{0} {0} {1}", m), undefined, "duplicated marker");
  assert.equal(unmask("{0} {1} {2}", m), undefined, "invented marker");
  const o = mask("Hello {name}", "opaque");
  assert.equal(unmask("Bonjour __ P0 __", o), "Bonjour {name}");
});

test("unmask rejects swapped tags but allows reordered pairs", () => {
  const m = mask("<b>Bold</b> and <i>italic</i>");
  assert.equal(unmask("<1>italique</1> et <0>gras</0>", m), "<i>italique</i> et <b>gras</b>");
  assert.equal(unmask("</0>gras<0> et <1>italique</1>", m), undefined);
});

test("hasTranslatableText needs real words", () => {
  assert.equal(hasTranslatableText("{0} / {1}"), false);
  assert.equal(hasTranslatableText("123 - 456"), false);
  assert.equal(hasTranslatableText("v{0}"), false);
  assert.equal(hasTranslatableText("{0} items"), true);
});

test("splitSentences keeps separators and splits sentences", () => {
  const pieces = splitSentences("Upload failed. Please try again.\nThanks!", "en");
  assert.deepEqual(
    pieces.filter((p) => p.translate).map((p) => p.value),
    ["Upload failed.", "Please try again.", "Thanks!"],
  );
  assert.equal(pieces.map((p) => p.value).join(""), "Upload failed. Please try again.\nThanks!");
});

test("ICU plural/select extraction and rebuild", () => {
  const s = "{count, plural, =0 {No files} one {# file} other {# files}} in {folder}";
  const icu = extractIcu(s)!;
  assert.deepEqual(icu.units, ["No files", "{__HASH__} file", "{__HASH__} files", " in {folder}"]);
  const out = icu.rebuild(["Aucun fichier", "{__HASH__} fichier", "{__HASH__} fichiers", " dans {folder}"]);
  assert.equal(out, "{count, plural, =0 {Aucun fichier} one {# fichier} other {# fichiers}} dans {folder}");

  const nested = extractIcu("{gender, select, male {He has {n, plural, one {# cat} other {# cats}}} other {They have pets}}")!;
  assert.deepEqual(nested.units, ["He has ", "{__HASH__} cat", "{__HASH__} cats", "They have pets"]);
  assert.equal(extractIcu("{count, plural, one {broken}"), undefined);
  assert.equal(extractIcu("Hello {name}"), undefined);
});

test("vue-i18n pipe plural extraction and rebuild", () => {
  const s = "no items | one item | {count} items";
  const p = extractPipePlural(s)!;
  assert.deepEqual(p.units, ["no items", "one item", "{count} items"]);
  assert.equal(p.rebuild(["aucun article", "un article", "{count} articles"]), "aucun article | un article | {count} articles");

  // No spaces around the pipe: the rebuilt string keeps that shape too.
  const tight = extractPipePlural("a|b|{n} c")!;
  assert.deepEqual(tight.units, ["a", "b", "{n} c"]);
  assert.equal(tight.rebuild(["x", "y", "{n} z"]), "x|y|{n} z");

  assert.equal(extractPipePlural("just one message"), undefined);
  assert.equal(extractPipePlural("{choices, select, a {x|y} other {z}}"), undefined); // '|' only inside braces
  assert.equal(extractPipePlural("leading | | double pipe"), undefined); // empty form: not a plural list
});

test("routes: direct, multi-target prefix, pivot, unsupported", () => {
  const en = parseLocale("en");
  assert.deepEqual(resolveRoute(en, parseLocale("fr"))!.map((h) => h.model.id), ["en-fr"]);
  const pt = resolveRoute(en, parseLocale("pt-BR"))!;
  assert.equal(pt[0].model.id, "en-pt");
  assert.equal(pt[0].prefix, ">>pob<<");
  assert.equal(resolveRoute(en, parseLocale("zh-TW"))![0].prefix, ">>cmn_Hant<<");
  assert.equal(resolveRoute(en, parseLocale("ar"))![0].prefix, ">>ara<<");
  assert.deepEqual(resolveRoute(parseLocale("ja"), parseLocale("fr"))!.map((h) => h.model.id), ["ja-en", "en-fr"]);
  assert.equal(resolveRoute(en, parseLocale("en-GB")), undefined);
  assert.equal(resolveRoute(en, parseLocale("tlh")), undefined);
  assert.ok(reachableTargets("en").includes("de"));
});

test("CATALOG: every repo (third-party and this project's own khabouss/*) is pinned to a commit", () => {
  const withRepo = CATALOG.filter((m) => m.repo);
  assert.ok(withRepo.length > 0);
  assert.ok(withRepo.some((m) => m.repo!.startsWith("khabouss/")));
  for (const m of withRepo) assert.match(m.revision ?? "", /^[0-9a-f]{40}$/, m.repo);
});

test("parseLocale normalizes tags", () => {
  assert.deepEqual(parseLocale("pt_br"), { tag: "pt_br", lang: "pt", region: "BR" });
  assert.deepEqual(parseLocale("zh-hant-TW"), { tag: "zh-hant-TW", lang: "zh", script: "Hant", region: "TW" });
  assert.equal(parseLocale("nb").lang, "no");
  assert.throws(() => parseLocale("../etc"));
});

test("buildTarget keeps existing translations, order and extra keys", () => {
  const src = { a: "Hello", b: { c: "World", d: 3 }, e: ["One", "Two"], f: "" };
  const existing = { b: { c: "Monde" }, zz: "kept" };
  assert.deepEqual(pendingStrings(src, existing, false), ["Hello", "One", "Two", ""]);
  const out = buildTarget(src, existing, (s) => `[${s}]`, false);
  assert.equal(JSON.stringify(out), JSON.stringify({ a: "[Hello]", b: { c: "Monde", d: 3 }, e: ["[One]", "[Two]"], f: "[]", zz: "kept" }));
  assert.equal(JSON.stringify(buildTarget(src, existing, (s) => `[${s}]`, true)).includes("[World]"), true);
});

test("buildTarget treats __proto__ keys as data", () => {
  const src = JSON.parse('{"__proto__": {"polluted": "yes"}}');
  const out = buildTarget(src, undefined, (s) => s, false) as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(JSON.stringify(out), '{"__proto__":{"polluted":"yes"}}');
});

test("keyPathProtect: protects an exact path and everything nested under it (an enum array)", () => {
  const src = {
    brand: { name: "Acme", tagline: "Acme makes your work easier" },
    config: { statusEnum: ["ACTIVE", "PENDING"] },
    greeting: "Welcome",
  };
  const isProtected = keyPathProtect(["brand.name", "config.statusEnum"]);
  assert.deepEqual(pendingStrings(src, undefined, false, isProtected).sort(), [
    "Acme makes your work easier",
    "Welcome",
  ]);
  const built = buildTarget(src, undefined, () => "[translated]", false, isProtected) as typeof src;
  assert.equal(built.brand.name, "Acme", "protected leaf is copied verbatim");
  assert.deepEqual(built.config.statusEnum, ["ACTIVE", "PENDING"], "protected array is untouched");
  assert.equal(built.brand.tagline, "[translated]", "an unprotected sibling still translates");
  assert.equal(built.greeting, "[translated]");

  assert.equal(keyPathProtect(undefined), undefined);
  assert.equal(keyPathProtect([]), undefined);
});

test("keyPathProtect: also protects a flat key whose literal name contains a dot (regression: 0.7.24 escapes it in the real path)", () => {
  // A single, top-level key literally named "brand.name" produces the escaped path
  // "brand\.name" (joinPath, added to stop it colliding with a nested brand->name
  // path) — doNotTranslateKeys written in the natural, unescaped form must still match it.
  const isProtected = keyPathProtect(["brand.name"]);
  assert.equal(isProtected("brand\\.name"), true, "flat key's own escaped path matches");
  assert.equal(isProtected("brand\\.name.tagline"), true, "nested under the escaped flat key still protected");
  // Nested two-segment paths (brand -> name) are unaffected: neither segment has a literal dot.
  assert.equal(keyPathProtect(["a.b"])("a.b"), true);
});

test("pendingStrings/buildTarget: isStale forces re-translation of a non-empty target", () => {
  const src = { a: "Hello", b: "World" };
  const existing = { a: "Bonjour", b: "Monde" };
  const isStale = (p: string) => p === "a";
  assert.deepEqual(pendingStrings(src, existing, false, undefined, isStale), ["Hello"]);
  const built = buildTarget(src, existing, (s) => `[${s}]`, false, undefined, isStale);
  assert.equal(JSON.stringify(built), JSON.stringify({ a: "[Hello]", b: "Monde" }));
});

test("buildTarget: isOrphaned drops a target-only key/subtree instead of preserving it forever", () => {
  const src = { a: "Hello" };
  const existing = { a: "Bonjour", deleted: "Was a source key once", group: { deleted: "Whole subtree gone" }, kept: "Never consulted" };
  const isOrphaned = (p: string) => p === "deleted" || p === "group";
  const built = buildTarget(src, existing, (s) => s, false, undefined, undefined, isOrphaned);
  assert.equal(JSON.stringify(built), JSON.stringify({ a: "Bonjour", kept: "Never consulted" }));
});

test("isPluralCategoryPath: recognizes a nested group's and a flat i18next suffix's category siblings, not an unrelated key", () => {
  const srcPaths = new Set(["group.one", "group.other", "fileCount_one", "fileCount_other", "plain"]);
  assert.equal(isPluralCategoryPath("group.few", srcPaths), true, "nested sibling of a still-present group");
  assert.equal(isPluralCategoryPath("fileCount_few", srcPaths), true, "flat suffix sibling of a still-present base");
  assert.equal(isPluralCategoryPath("plain", srcPaths), false, "an ordinary key is never mistaken for a category");
  assert.equal(isPluralCategoryPath("removedGroup.few", srcPaths), false, "no surviving \"other\" sibling: not a category, not protected");
  assert.equal(isPluralCategoryPath("removedCount_few", srcPaths), false, "same, flat style");
});

test("check/translate: a deleted/renamed source key is reported by check and pruned by translate, but a never-tracked target-only key is left alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-orphan-"));
  fs.mkdirSync(path.join(dir, "locales"));
  fs.writeFileSync(path.join(dir, "locales/en.json"), JSON.stringify({ greeting: "Hello", farewell: "Goodbye" }));
  fs.writeFileSync(
    path.join(dir, "locales/fr.json"),
    JSON.stringify({ greeting: "FR:Hello", farewell: "FR:Goodbye", deprecated_key: "FR:removed from source", manual_key: "Never a source key" }),
  );
  // Only "deprecated_key" was ever recorded by this tool (source hash/written hash both
  // real) — "manual_key" has no lock entry at all, the same as a key someone added by hand.
  fs.writeFileSync(
    path.join(dir, "locales/locale-ai.lock.json"),
    JSON.stringify({
      version: 3,
      entries: {
        "en.json#greeting": { fr: `${hashOf("Hello")}:${hashOf("FR:Hello")}` },
        "en.json#farewell": { fr: `${hashOf("Goodbye")}:${hashOf("FR:Goodbye")}` },
        "en.json#deprecated_key": { fr: `${hashOf("anything")}:${hashOf("FR:removed from source")}` },
      },
    }),
  );

  // check reports every target-only key regardless of lock history — it never writes
  // anything, so being inclusive here is only informational, not destructive.
  const checked = await check({ cwd: dir, from: "en" });
  assert.equal(checked.locales[0]!.orphaned, 2);
  assert.deepEqual(
    checked.issues.filter((i) => i.kind === "orphan-key").map((i) => (i as { path: string }).path).toSorted(),
    ["deprecated_key", "manual_key"],
  );

  // translate only prunes what IT tracked in the lock as coming from a now-vanished
  // source key — "manual_key" was never this tool's to begin with, so it's left alone.
  const translated = await translate({ cwd: dir, from: "en", to: "fr" });
  assert.equal(translated.locales[0]!.stringsTranslated, 0, "both real keys already translated and non-stale: no model needed");
  const after = JSON.parse(fs.readFileSync(path.join(dir, "locales/fr.json"), "utf8"));
  assert.deepEqual(after, { greeting: "FR:Hello", farewell: "FR:Goodbye", manual_key: "Never a source key" });
});

test("lock: adding locale-ai.config.json after the first run keeps the lock's history instead of starting over (regression)", async () => {
  // The lock lives next to the config file when there is one, otherwise in the layout
  // root — so adding a config moved it to a new, empty lock, and a later source edit
  // was silently ignored by translate and not reported stale by check.
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-lockmove-"));
    fs.mkdirSync(path.join(dir, "src/locales/en"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src/locales/fr"));
    fs.writeFileSync(path.join(dir, "src/locales/en/home.json"), JSON.stringify({ cta: "Start your free trial", title: "Welcome" }));
    fs.writeFileSync(path.join(dir, "src/locales/fr/home.json"), JSON.stringify({ cta: "Commencez votre essai gratuit", title: "Bienvenue" }));
    fs.writeFileSync(
      path.join(dir, "src/locales/locale-ai.lock.json"),
      JSON.stringify({
        version: 3,
        entries: {
          "en/home.json#cta": { fr: `${hashOf("Start your free trial")}:${hashOf("Commencez votre essai gratuit")}` },
          "en/home.json#title": { fr: `${hashOf("Welcome")}:${hashOf("Bienvenue")}` },
        },
      }),
    );
    fs.writeFileSync(path.join(dir, "locale-ai.config.json"), JSON.stringify({ doNotTranslate: ["Northwind"] }));
    return dir;
  };
  const oldLock = (dir: string) => path.join(dir, "src/locales/locale-ai.lock.json");
  const newLock = (dir: string) => path.join(dir, "locale-ai.lock.json");

  // check never writes: it reads the old lock's history, re-keyed, and leaves the file where it is.
  const dir = setup();
  fs.writeFileSync(path.join(dir, "src/locales/en/home.json"), JSON.stringify({ cta: "Start your 14-day free trial", title: "Welcome" }));
  const checked = await check({ cwd: dir, from: "en" });
  assert.deepEqual(checked.issues.filter((i) => i.kind === "stale").map((i) => (i as { path: string }).path), ["cta"]);
  assert.ok(fs.existsSync(oldLock(dir)) && !fs.existsSync(newLock(dir)));

  // A translate run with nothing to translate (the case that used to lose the history
  // for good) moves the lock next to the config, re-keyed relative to its new folder.
  const dir2 = setup();
  const events: string[] = [];
  const result = await translate({ cwd: dir2, from: "en", to: "fr", onEvent: (e) => events.push(e.type) });
  assert.equal(result.locales[0]!.stringsTranslated, 0);
  assert.equal(result.lockCreated, false, "a moved lock isn't reported as newly created");
  assert.ok(events.includes("lock-moved"));
  assert.ok(!fs.existsSync(oldLock(dir2)));
  assert.deepEqual(Object.keys(loadLock(newLock(dir2)).entries).sort(), ["src/locales/en/home.json#cta", "src/locales/en/home.json#title"]);
  fs.writeFileSync(path.join(dir2, "src/locales/en/home.json"), JSON.stringify({ cta: "Start your 14-day free trial", title: "Welcome" }));
  const checked2 = await check({ cwd: dir2, from: "en" });
  assert.deepEqual(checked2.issues.filter((i) => i.kind === "stale").map((i) => (i as { path: string }).path), ["cta"], "a later source edit is still tracked");

  // accept moves it too, and a --dry-run translate never touches either file.
  const dir3 = setup();
  await translate({ cwd: dir3, from: "en", to: "fr", dryRun: true });
  assert.ok(fs.existsSync(oldLock(dir3)) && !fs.existsSync(newLock(dir3)));
  const accepted = await accept({ cwd: dir3, from: "en", to: "fr" });
  assert.equal(accepted.lockMovedFrom, oldLock(dir3));
  assert.ok(!fs.existsSync(oldLock(dir3)) && fs.existsSync(newLock(dir3)));

  // An existing lock next to the config always wins: nothing is merged or moved.
  const dir4 = setup();
  fs.writeFileSync(newLock(dir4), JSON.stringify({ version: 3, entries: {} }));
  await translate({ cwd: dir4, from: "en", to: "fr" });
  assert.ok(fs.existsSync(oldLock(dir4)));
});

test("rebaseLock: re-keys each file key from one lock directory to another", () => {
  const lock = { version: 3 as const, entries: { "en/home.json#a.b": { fr: "1:2" }, "../shared/en.json#x": { de: "3:4" } } };
  const base = path.join(os.tmpdir(), "proj");
  assert.deepEqual(rebaseLock(lock, path.join(base, "src/locales"), base).entries, {
    "src/locales/en/home.json#a.b": { fr: "1:2" },
    "src/shared/en.json#x": { de: "3:4" },
  });
});

test("pendingStrings/buildTarget: a legitimately empty source string is not perpetually re-translated", () => {
  // Regression: needsTranslation used to treat any empty-string target as
  // unfinished, even when the source itself is "" (so the target is already
  // correct) — a second run would re-"translate" it forever, violating the
  // "re-runs are a no-op" guarantee.
  const src = { a: "", b: "Hello" };
  const existing = { a: "", b: "Bonjour" };
  assert.deepEqual(pendingStrings(src, existing, false), []);
  const built = buildTarget(src, existing, (s) => `[${s}]`, false);
  assert.equal(JSON.stringify(built), JSON.stringify({ a: "", b: "Bonjour" }));

  // A genuinely untranslated empty target (no existing doc yet) still gets filled in.
  assert.deepEqual(pendingStrings(src, undefined, false), ["", "Hello"]);
  const first = buildTarget(src, undefined, (s) => `[${s}]`, false);
  assert.equal(JSON.stringify(first), JSON.stringify({ a: "[]", b: "[Hello]" }));
});

test("lock: a source edit is detected as stale; a translator edit is flagged, not stale; per-locale, not shared", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-lock-"));
  const file = path.join(dir, "locale-ai.lock.json");
  assert.deepEqual(loadLock(file), { version: 3, entries: {} });

  const lock = loadLock(file);
  recordEntries(lock, "en.json", "fr", [{ path: "welcome", source: "Welcome back!", written: "Bon retour !" }]);
  assert.equal(isSourceStale(lock, "en.json", "welcome", "fr", "Welcome back!"), false);
  assert.deepEqual(editedPaths(lock, "en.json", "fr", [{ path: "welcome", value: "Bon retour !" }]), []);

  // Translating "fr" never marks "es" (never translated) as up to date for the same path.
  assert.equal(isSourceStale(lock, "en.json", "welcome", "es", "Welcome back!"), false);
  assert.equal(isEdited(lock, "en.json", "welcome", "es", "anything"), false);

  // The English source changed: stale regardless of what the target currently holds.
  assert.equal(isSourceStale(lock, "en.json", "welcome", "fr", "Welcome back, friend!"), true);

  // The target was hand-edited while the source stayed the same: flagged, not "stale".
  assert.deepEqual(editedPaths(lock, "en.json", "fr", [{ path: "welcome", value: "Re-bonjour !" }]), ["welcome"]);
  assert.equal(isSourceStale(lock, "en.json", "welcome", "fr", "Welcome back!"), false);

  // A path the lock has never recorded (new key, or adopting the lockfile on an
  // existing project) is never reported as stale or edited.
  assert.equal(isSourceStale(lock, "en.json", "brandNew", "fr", "Something new"), false);
  assert.deepEqual(editedPaths(lock, "en.json", "fr", [{ path: "brandNew", value: "Nouveau" }]), []);

  // recordEntries only touches the locale it's given — "es" is still untouched after translating "fr" twice.
  recordEntries(lock, "en.json", "fr", [{ path: "welcome", source: "Welcome back, friend!", written: "Re-bonjour, mon ami !" }]);
  assert.equal(isSourceStale(lock, "en.json", "welcome", "es", "Welcome back, friend!"), false);
  assert.equal(isEdited(lock, "en.json", "welcome", "es", "anything"), false);

  // Deleted keys are pruned for every locale, not just the one being translated.
  recordEntries(lock, "en.json", "es", [{ path: "welcome", source: "Welcome back, friend!", written: "Bienvenido de nuevo, amigo!" }]);
  pruneDeletedKeys(lock, "en.json", ["somethingElse"]);
  assert.equal(isSourceStale(lock, "en.json", "welcome", "fr", "anything"), false);
  assert.equal(isEdited(lock, "en.json", "welcome", "es", "anything"), false);

  saveLock(file, lock);
  assert.deepEqual(loadLock(file), lock);
  assert.equal(hashOf("x"), hashOf("x"));
  assert.notEqual(hashOf("x"), hashOf("y"));
});

test("lock: a pre-0.7.24 entry for a flat dotted key is found by its new, escaped path, and migrated onto it (regression)", () => {
  // Before 0.7.24 escaped a literal "." within a key, a flat key named "menu.save"
  // and a nested "menu" -> "save" produced the exact same lock path string. The lock
  // for a pre-existing project recorded the OLD, unescaped path ("menu.save") — if
  // isSourceStale/isEdited only ever looked up the new escaped path ("menu\.save"),
  // they'd find nothing, treat the key as never-tracked (so a non-empty existing
  // target looks already up to date), and a source edit on it would be silently
  // ignored forever.
  const lock = { version: 3 as const, entries: { "en.json#menu.save": { fr: `${hashOf("Save profile")}:${hashOf("Enregistrer le profil")}` } } };
  assert.equal(isSourceStale(lock, "en.json", "menu\\.save", "fr", "Save profile"), false, "unchanged source: not stale via the legacy fallback");
  assert.equal(isSourceStale(lock, "en.json", "menu\\.save", "fr", "Save user profile"), true, "source edit is still detected, not silently lost");
  assert.equal(isEdited(lock, "en.json", "menu\\.save", "fr", "Enregistrer le profil"), false);

  // The fallback hit migrates the entry onto the new key, so a later lookup (and the
  // next save) finds it directly without the old key around to search for.
  assert.deepEqual(lock.entries["en.json#menu\\.save"], { fr: `${hashOf("Save profile")}:${hashOf("Enregistrer le profil")}` });
});

test("lock: pruning renames a pre-0.7.24 dotted-key entry onto its escaped path instead of deleting it (regression)", () => {
  // mergeAndSaveLock prunes a copy re-read from disk, which never saw lookupPair's
  // in-memory migration — so a run with nothing to translate used to delete the legacy
  // entry outright, and a later source edit on that key was silently ignored forever.
  const pair = (s: string, w: string) => `${hashOf(s)}:${hashOf(w)}`;
  const lock = {
    version: 3 as const,
    entries: {
      "en.json#menu.save": { fr: pair("Save", "Enregistrer"), de: pair("Save", "Speichern") },
      "en.json#gone": { fr: pair("Old", "Ancien") },
      "other.json#menu.save": { fr: pair("Save", "Enregistrer") },
    } as Record<string, Record<string, string>>,
  };
  pruneDeletedKeys(lock, "en.json", ["menu\\.save", "title"]);
  assert.deepEqual(Object.keys(lock.entries).sort(), ["en.json#menu\\.save", "other.json#menu.save"]);
  assert.deepEqual(lock.entries["en.json#menu\\.save"], { fr: pair("Save", "Enregistrer"), de: pair("Save", "Speichern") });
  assert.equal(isSourceStale(lock, "en.json", "menu\\.save", "fr", "Save changes"), true, "a later source edit is still detected");

  // An entry already recorded under the escaped path is newer, so it wins per locale.
  const mixed = {
    version: 3 as const,
    entries: {
      "en.json#menu.save": { fr: pair("Save", "Enregistrer"), de: pair("Save", "Speichern") },
      "en.json#menu\\.save": { fr: pair("Save changes", "Enregistrer les modifications") },
    } as Record<string, Record<string, string>>,
  };
  pruneDeletedKeys(mixed, "en.json", ["menu\\.save"]);
  assert.deepEqual(mixed.entries, { "en.json#menu\\.save": { fr: pair("Save changes", "Enregistrer les modifications"), de: pair("Save", "Speichern") } });

  // A legacy path that's still a real current path (the nested menu -> save) keeps its own entry.
  const nested = { version: 3 as const, entries: { "en.json#menu.save": { fr: pair("Save", "Enregistrer") } } as Record<string, Record<string, string>> };
  pruneDeletedKeys(nested, "en.json", ["menu.save", "menu\\.save"]);
  assert.deepEqual(nested.entries, { "en.json#menu.save": { fr: pair("Save", "Enregistrer") } });

  // Two escaped paths that both unescape to the same legacy path: ambiguous, pruned rather than guessed.
  const ambiguous = { version: 3 as const, entries: { "en.json#a.b.c": { fr: pair("X", "Y") } } as Record<string, Record<string, string>> };
  pruneDeletedKeys(ambiguous, "en.json", ["a\\.b.c", "a.b\\.c"]);
  assert.deepEqual(ambiguous.entries, {});
});

test("lockedPathsFor: every leaf path this tool previously translated, for one file and locale", () => {
  const lock = loadLock(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lai-lockedpaths-")), "locale-ai.lock.json"));
  recordEntries(lock, "en.json", "fr", [
    { path: "greeting", source: "Hello", written: "Bonjour" },
    { path: "farewell", source: "Goodbye", written: "Au revoir" },
  ]);
  recordEntries(lock, "en.json", "es", [{ path: "greeting", source: "Hello", written: "Hola" }]);
  recordEntries(lock, "other.json", "fr", [{ path: "greeting", source: "Hi", written: "Salut" }]);

  assert.deepEqual(lockedPathsFor(lock, "en.json", "fr"), new Set(["greeting", "farewell"]));
  assert.deepEqual(lockedPathsFor(lock, "en.json", "es"), new Set(["greeting"]));
  assert.deepEqual(lockedPathsFor(lock, "en.json", "de"), new Set(), "a locale never translated has no locked paths");
  assert.deepEqual(lockedPathsFor(lock, "other.json", "fr"), new Set(["greeting"]), "a different file's entries are never mixed in");
});

test("lock: two concurrent processes translating different locales both keep their lock history (no lost update)", async () => {
  // Regression: mergeAndSaveLock (src/lock.ts) re-reads the lock fresh from disk and
  // merges in only this run's own delta, under a cross-process file lock — instead of
  // the old pattern of loading once at process start and writing that whole in-memory
  // snapshot back at the end. Without it, two separate `locale-ai translate` processes
  // (e.g. one `--to fr`, one `--to es`) started close together each see the same
  // starting snapshot; whichever finishes and saves last would silently erase the
  // other's lock history for the locale it didn't itself just translate — exactly what
  // this test spawns two real OS processes to rule out.
  const { spawn } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-lock-race-"));
  const lockPath = path.join(dir, "locale-ai.lock.json");
  const worker = path.join(import.meta.dirname, "fixtures/lock-race-worker.ts");
  const run = (localeTag: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [worker, lockPath, localeTag, "50"], { stdio: "inherit" });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${localeTag} worker exited ${code}`))));
      child.on("error", reject);
    });
  await Promise.all([run("fr"), run("es")]);

  const lock = loadLock(lockPath);
  const tags = lock.entries["en.json#greeting"];
  assert.ok(tags, "the key survived at all");
  assert.equal(tags!.fr, `${hashOf("Hello")}:${hashOf("Hello-fr")}`, "fr's entry wasn't lost to es's save, or vice versa");
  assert.equal(tags!.es, `${hashOf("Hello")}:${hashOf("Hello-es")}`, "es's entry wasn't lost to fr's save, or vice versa");
});

test("lock: an unparseable (e.g. merge-conflicted) lock file throws instead of being silently discarded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-lock-conflict-"));
  const file = path.join(dir, "locale-ai.lock.json");
  fs.writeFileSync(
    file,
    '{\n  "version": 3,\n  "entries": {\n<<<<<<< HEAD\n    "a": {}\n=======\n    "b": {}\n>>>>>>> branch\n  }\n}\n',
  );
  assert.throws(() => loadLock(file), /valid JSON|merge conflict/);

  // A file that simply doesn't exist yet still starts fresh silently (first run).
  assert.deepEqual(loadLock(path.join(dir, "missing.lock.json")), { version: 3, entries: {} });
});

test("fs-atomic: writeFileAtomic replaces the target in one rename, leaving no temp file behind", async () => {
  const { writeFileAtomic } = await import("../src/fs-atomic.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-atomic-"));
  const file = path.join(dir, "out.txt");
  fs.writeFileSync(file, "old");
  writeFileAtomic(file, "new");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["out.txt"], "no .out.txt.tmp-* left behind");
});

test("lock: a pre-0.7.0 (version 1) lock file is migrated in memory, never crashes a run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-lock-v1-"));
  const file = path.join(dir, "locale-ai.lock.json");
  // Pre-0.7.0 actually stored 16-character hashes; the migration truncates them to the
  // 8 characters `hashOf` produces today, so this fixture deliberately doesn't reuse
  // `hashOf` itself (which would already be 8 characters and not exercise the migration).
  const hash16 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
  const v1 = {
    version: 1,
    files: { "en.json": { welcome: { source: hash16("Welcome back!"), mt: { fr: hash16("Bon retour !") } } } },
  };
  fs.writeFileSync(file, JSON.stringify(v1));
  const lock = loadLock(file);
  assert.equal(lock.version, 3);
  assert.equal(isSourceStale(lock, "en.json", "welcome", "fr", "Welcome back!"), false);
  assert.equal(isEdited(lock, "en.json", "welcome", "fr", "Bon retour !"), false);
  assert.equal(isEdited(lock, "en.json", "welcome", "fr", "Something else entirely"), true);
});

test("addPluralForms adds the forms the target language needs", () => {
  const doc = { item_one: "1 élément", item_other: "{{count}} éléments", gender_other: "Autre", x: 1 };
  const ar = addPluralForms(doc, "ar");
  assert.deepEqual(Object.keys(ar.doc as object), [
    "item_zero", "item_one", "item_two", "item_few", "item_many", "item_other", "gender_other", "x",
  ]);
  assert.equal(ar.added, 4);
  assert.equal(addPluralForms(doc, "ja").added, 0);
  // Idempotent: running again on the result changes nothing.
  const again = addPluralForms(ar.doc, "ar");
  assert.equal(again.added, 0);
  assert.equal(JSON.stringify(again.doc), JSON.stringify(ar.doc));
});

test("addPluralForms: a derived category resyncs when \"other\" was just retranslated, unless it was hand-edited", () => {
  const doc = {
    item_one: "1 item",
    item_other: "N items NEW",
    item_few: "N items OLD-FEW",
    item_many: "N items OLD-MANY",
  };
  // Both "one" and "other" have a real, independent English source counterpart (the only
  // two categories English ever needs) — never resynced/edit-tracked by this function.
  const hasSource = (p: string) => p === "item_one" || p === "item_other";

  // "other" untouched this run: every existing category is left exactly as it was —
  // same as calling with no opts at all (the pre-fix behavior for an unchanged "other").
  const untouched = addPluralForms(doc, "ar", { otherStale: () => false, isEdited: () => false, hasSource });
  assert.equal((untouched.doc as Record<string, string>).item_few, "N items OLD-FEW");
  assert.equal((untouched.doc as Record<string, string>).item_many, "N items OLD-MANY");
  assert.deepEqual(untouched.edited, []);

  // "other" was just retranslated: both existing derived categories resync to the new
  // text, and the newly-added zero/two categories are derived from it too — but "one"
  // (a real source key) is left completely alone despite also existing in the group.
  const refreshed = addPluralForms(doc, "ar", { otherStale: (p) => p === "item_other", isEdited: () => false, hasSource });
  const rdoc = refreshed.doc as Record<string, string>;
  assert.equal(rdoc.item_one, "1 item");
  assert.equal(rdoc.item_few, "N items NEW");
  assert.equal(rdoc.item_many, "N items NEW");
  assert.equal(rdoc.item_zero, "N items NEW");
  assert.equal(rdoc.item_two, "N items NEW");
  assert.equal(refreshed.added, 2, "only the brand-new zero/two categories count as \"added\"");
  assert.deepEqual(
    new Set(refreshed.derived.map((d) => d.path)),
    new Set(["item_few", "item_many", "item_zero", "item_two"]),
  );
  assert.deepEqual(refreshed.edited, []);

  // A translator hand-edited "item_few"; "other" also changed this run — that's a
  // conflict (both happened), and the hand-edited text must never be overwritten.
  // "item_many" wasn't touched by anyone, so it still resyncs normally.
  const conflict = addPluralForms(doc, "ar", {
    otherStale: (p) => p === "item_other",
    isEdited: (p) => p === "item_few",
    hasSource,
  });
  const cdoc = conflict.doc as Record<string, string>;
  assert.equal(cdoc.item_few, "N items OLD-FEW", "the hand edit survives untouched");
  assert.equal(cdoc.item_many, "N items NEW");
  assert.deepEqual(conflict.edited, [{ path: "item_few", conflict: true }]);
  assert.ok(!conflict.derived.some((d) => d.path === "item_few"));

  // A hand edit with "other" NOT retranslated this run is still reported — "edited" is
  // tracked independently of staleness, the same as every other key in the lock.
  const editedOnly = addPluralForms(doc, "ar", { otherStale: () => false, isEdited: (p) => p === "item_few", hasSource });
  assert.deepEqual(editedOnly.edited, [{ path: "item_few", conflict: false }]);
});

test("addNestedPluralForms: a derived category resyncs when \"other\" was just retranslated, unless it was hand-edited", () => {
  const { pluralCategories } = new Intl.PluralRules("ar").resolvedOptions();
  const needsFew = pluralCategories.includes("few");
  assert.ok(needsFew, "test assumes ar needs a few category — sanity check the assumption itself");
  const hasSource = (p: string) => p === "item.one" || p === "item.other";

  const doc = { item: { one: "1 item", other: "N items NEW", few: "N items OLD-FEW" } };
  const refreshed = addNestedPluralForms(doc, "ar", { otherStale: (p) => p === "item.other", isEdited: () => false, hasSource });
  const rdoc = (refreshed.doc as { item: Record<string, string> }).item;
  assert.equal(rdoc.one, "1 item");
  assert.equal(rdoc.few, "N items NEW");
  assert.ok(refreshed.derived.some((d) => d.path === "item.few"));

  const conflict = addNestedPluralForms(doc, "ar", {
    otherStale: (p) => p === "item.other",
    isEdited: (p) => p === "item.few",
    hasSource,
  });
  const cdoc = (conflict.doc as { item: Record<string, string> }).item;
  assert.equal(cdoc.few, "N items OLD-FEW");
  assert.deepEqual(conflict.edited, [{ path: "item.few", conflict: true }]);
});

test("plural-sync + lock wiring: a hand-edited derived path survives pruneDeletedKeys across runs (regression)", () => {
  // Reproduces, at the unit level, the exact sequence found via real e2e testing: cmdTranslate's
  // pruneDeletedKeys call must keep BOTH pluralDerived and pluralEdited paths, or an edited-but-
  // protected derived key's lock entry is deleted the run it isn't refreshed, and the NEXT run's
  // isEdited(...) sees no history (= "not edited") and silently overwrites the hand edit.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-prune-"));
  const lock = loadLock(path.join(dir, "x.lock.json"));
  const fileKey = "en.json";
  const tag = "ar";
  const hasSource = (p: string) => p === "item_one" || p === "item_other";

  // Run 1: fresh translation. "other" is new, so few/many are derived from it.
  const r1 = addPluralForms({ item_one: "1 item", item_other: "A" }, "ar", {
    otherStale: () => true,
    isEdited: () => false,
    hasSource,
  });
  recordEntries(lock, fileKey, tag, [
    { path: "item_one", source: "1 item", written: "1 item" },
    { path: "item_other", source: "A", written: "A" },
  ]);
  recordEntries(
    lock,
    fileKey,
    tag,
    r1.derived.map((d) => ({ path: d.path, source: d.value, written: d.value })),
  );
  pruneDeletedKeys(lock, fileKey, ["item_one", "item_other", ...r1.derived.map((d) => d.path)]);
  assert.ok(lock.entries[`${fileKey}#item_few`], "derived entry recorded after run 1");

  // Hand-edit item_few, then run 2: "other" is retranslated (now stale/refreshed).
  const built2 = { ...(r1.doc as Record<string, string>), item_few: "HAND EDITED" };
  const r2 = addPluralForms(built2, "ar", {
    otherStale: (p) => p === "item_other",
    isEdited: (p, v) => isEdited(lock, fileKey, p, tag, v),
    hasSource,
  });
  assert.equal((r2.doc as Record<string, string>).item_few, "HAND EDITED", "conflict preserves the hand edit this run");
  assert.deepEqual(r2.edited, [{ path: "item_few", conflict: true }]);

  recordEntries(lock, fileKey, tag, [
    { path: "item_one", source: "1 item", written: "1 item" },
    { path: "item_other", source: "B", written: "B" },
  ]);
  recordEntries(
    lock,
    fileKey,
    tag,
    r2.derived.map((d) => ({ path: d.path, source: d.value, written: d.value })),
  );
  // This is the exact fix under test: the keep-set must include pluralEdited paths too,
  // not just srcFlat + pluralDerived, or item_few's lock entry is deleted right here.
  pruneDeletedKeys(lock, fileKey, [
    "item_one",
    "item_other",
    ...r2.derived.map((d) => d.path),
    ...r2.edited.map((e) => e.path),
  ]);
  assert.ok(lock.entries[`${fileKey}#item_few`], "edited entry must survive pruning or run 3 will see no history");

  // Run 3: "other" is retranslated again with no change to item_few. Must still be protected.
  const built3 = { ...(r2.doc as Record<string, string>) };
  const r3 = addPluralForms(built3, "ar", {
    otherStale: (p) => p === "item_other",
    isEdited: (p, v) => isEdited(lock, fileKey, p, tag, v),
    hasSource,
  });
  assert.equal(
    (r3.doc as Record<string, string>).item_few,
    "HAND EDITED",
    "still protected on a 3rd run — this is the regression this test guards against",
  );
  assert.deepEqual(r3.edited, [{ path: "item_few", conflict: true }]);
});

test("usesI18nextPlurals: only flat JSON/YAML, not .po/.arb/.strings", () => {
  assert.equal(usesI18nextPlurals("locales/en/common.json"), true);
  assert.equal(usesI18nextPlurals("locales/en.yaml"), true);
  assert.equal(usesI18nextPlurals("locales/en.yml"), true);
  assert.equal(usesI18nextPlurals("locales/en.po"), false);
  assert.equal(usesI18nextPlurals("locales/en.arb"), false);
  assert.equal(usesI18nextPlurals("locales/en.strings"), false);
});

test("pluralOneStrings: finds cardinal _one values, ignores ordinals and other categories", () => {
  const doc = {
    itemCount_one: "{{count}} item",
    itemCount_other: "{{count}} items",
    nested: { fileCount_one: "You have {{count}} file", fileCount_other: "You have {{count}} files" },
    list: [{ rank_ordinal_one: "{{count}}st place" }],
    plain: "not a plural key",
  };
  assert.deepEqual(pluralOneStrings(doc), new Set(["{{count}} item", "You have {{count}} file"]));
});

test("pluralOneStrings: also finds a nested {one, other} plural group (Rails YAML/Android <plurals>) and gettext's \\u0005one slot", () => {
  // Neither shape uses the i18next "_one" suffix convention: a nested group (what
  // addNestedPluralForms also recognizes, and what android-xml.ts produces for a
  // <plurals> element) has no "_one" key at all, and po.ts's own flat plural keys use
  // a "\u0005one" separator instead of an underscore. Both were previously invisible
  // to pluralOneStrings, so Android/.po/Rails-YAML singular plurals never got the
  // literal-"1" grammar retry engine.ts gives i18next's "_one" keys.
  const doc = {
    file_count: { one: "%d file", other: "%d files" },
    "\u0004file\u0005one": "%d file",
    "\u0004file\u0005other": "%d files",
    plain: "not a plural key",
  };
  assert.deepEqual(pluralOneStrings(doc), new Set(["%d file"]));
});

test("detects dir and file layouts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-"));
  fs.mkdirSync(path.join(root, "src/locales/en/admin"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/locales/en/common.json"), "{}");
  fs.writeFileSync(path.join(root, "src/locales/en/admin/users.json"), "{}");
  const l = detectLayout(root, "en");
  assert.deepEqual(l, { kind: "dir", root: path.join(root, "src/locales") });
  const files = sourceFiles(l, "en");
  assert.equal(files.length, 2);
  assert.equal(targetFile(l, "en", "fr", files[0]), path.join(root, "src/locales/fr/admin/users.json"));

  fs.mkdirSync(path.join(root, "messages"));
  fs.writeFileSync(path.join(root, "messages/en.json"), "{}");
  const f = detectLayout(root, "en", "messages");
  assert.equal(targetFile(f, "en", "de", sourceFiles(f, "en")[0]), path.join(root, "messages/de.json"));
  assert.throws(() => detectLayout(root, "xx"));
});

test("detectLayout: --from mismatch on a non-English-source project hints the locale actually found", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-hint-"));
  fs.mkdirSync(path.join(root, "src/locales/fr"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/locales/fr/common.json"), '{"hello":"Bonjour"}');
  assert.throws(() => detectLayout(root, "en"), /Found "fr" instead — did you mean --from fr\?/);

  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "lai-hint2-"));
  assert.throws(() => detectLayout(root2, "en"), (e: Error) => !/did you mean/.test(e.message));
});

test("detects Rails' config/locales convention with no --input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-rails-"));
  fs.mkdirSync(path.join(root, "config/locales"), { recursive: true });
  fs.writeFileSync(path.join(root, "config/locales/en.yml"), "en:\n  hello: Hi\n");
  const l = detectLayout(root, "en");
  assert.deepEqual(l, { kind: "file", root: path.join(root, "config/locales"), ext: ".yml" });
  assert.equal(targetFile(l, "en", "fr", sourceFiles(l, "en")[0]), path.join(root, "config/locales/fr.yml"));
});

test("Flutter's app_<locale>.arb filename prefix is detected, auto and via --input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-flutter-"));
  fs.mkdirSync(path.join(root, "lib/l10n"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/l10n/app_en.arb"), '{"@@locale": "en", "hello": "Hi"}');
  fs.writeFileSync(path.join(root, "lib/l10n/app_fr.arb"), '{"@@locale": "fr", "hello": "Salut"}');

  // No --input at all: lib/l10n is Flutter's own default, listed among the auto-detected candidates.
  const auto = detectLayout(root, "en");
  assert.deepEqual(auto, { kind: "file", root: path.join(root, "lib/l10n"), ext: ".arb", prefix: "app" });

  const l = detectLayout(root, "en", "lib/l10n");
  assert.deepEqual(l, { kind: "file", root: path.join(root, "lib/l10n"), ext: ".arb", prefix: "app" });
  assert.deepEqual(existingTargets(l, "en"), ["fr"]);
  assert.equal(targetFile(l, "en", "de", sourceFiles(l, "en")[0]), path.join(root, "lib/l10n/app_de.arb"));

  // Pointing --input directly at the source file itself also resolves it.
  const direct = detectLayout(root, "en", "lib/l10n/app_en.arb");
  assert.deepEqual(direct, { kind: "file", root: path.join(root, "lib/l10n"), ext: ".arb", prefix: "app" });
});

test("detectLayout: a Flutter project's unrelated top-level lib/ folder is never mistaken for a locale, even with --from wrong", () => {
  // Regression: lib/ is Flutter's own source folder, not a locale directory — but its
  // name happens to shape-match looksLikeLocale's loose 2-3-letter check, and before
  // lib/l10n was an auto-detected candidate, a full recursive scan under "." found the
  // unrelated lib/l10n/app_en.arb several levels down and wrongly suggested --from lib.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-flutter-nohint-"));
  fs.mkdirSync(path.join(root, "lib/l10n"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/l10n/app_en.arb"), '{"@@locale": "en", "hello": "Hi"}');
  assert.throws(() => detectLayout(root, "de"), (e: Error) => !/did you mean --from lib/.test(e.message));
});

test("Apple's <locale>.lproj directory suffix is detected, auto and via --input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-ios-"));
  fs.mkdirSync(path.join(root, "en.lproj"), { recursive: true });
  fs.mkdirSync(path.join(root, "fr.lproj"), { recursive: true });
  fs.writeFileSync(path.join(root, "en.lproj/Localizable.strings"), '"hello" = "Hi";\n');
  fs.writeFileSync(path.join(root, "fr.lproj/Localizable.strings"), '"hello" = "Salut";\n');

  const l = detectLayout(root, "en", root);
  assert.deepEqual(l, { kind: "dir", root, dirSuffix: ".lproj" });
  assert.deepEqual(existingTargets(l, "en"), ["fr"]);
  const files = sourceFiles(l, "en");
  assert.equal(files.length, 1);
  assert.equal(targetFile(l, "en", "de", files[0]), path.join(root, "de.lproj/Localizable.strings"));

  // Pointing --input directly at the en.lproj directory also resolves it.
  const direct = detectLayout(root, "en", path.join(root, "en.lproj"));
  assert.deepEqual(direct, { kind: "dir", root, dirSuffix: ".lproj" });
});

test("Android's values/values-<qualifier> resource folders are detected, auto and via --input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-android-"));
  fs.mkdirSync(path.join(root, "app/src/main/res/values"), { recursive: true });
  fs.mkdirSync(path.join(root, "app/src/main/res/values-pt-rBR"), { recursive: true });
  fs.writeFileSync(path.join(root, "app/src/main/res/values/strings.xml"), "<resources>\n    <string name=\"hi\">Hi</string>\n</resources>\n");
  fs.writeFileSync(
    path.join(root, "app/src/main/res/values-pt-rBR/strings.xml"),
    '<resources>\n    <string name="hi">Oi</string>\n</resources>\n',
  );
  const resRoot = path.join(root, "app/src/main/res");

  const l = detectLayout(root, "en");
  assert.deepEqual(l, { kind: "android", root: resRoot });
  assert.deepEqual(existingTargets(l, "en"), ["pt-BR"]);
  const files = sourceFiles(l, "en");
  assert.deepEqual(files, [path.join(resRoot, "values/strings.xml")]);
  assert.equal(targetFile(l, "en", "fr", files[0]), path.join(resRoot, "values-fr/strings.xml"));
  assert.equal(targetFile(l, "en", "pt-BR", files[0]), path.join(resRoot, "values-pt-rBR/strings.xml"));

  // Pointing --input directly at the values directory also resolves it.
  const direct = detectLayout(root, "en", path.join(resRoot, "values"));
  assert.deepEqual(direct, { kind: "android", root: resRoot });
});

test("Android strings.xml: strings, arrays, plurals, translatable=false and escaping round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-android-xml-"));
  const file = path.join(dir, "strings.xml");
  const text = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- The app's own name, never translated -->
    <string name="app_name" translatable="false">MyApp</string>
    <!-- Shown on the welcome screen -->
    <string name="welcome_title">Welcome, %1$s!</string>
    <string-array name="colors">
        <item>Red</item>
        <item>Green</item>
    </string-array>
    <plurals name="item_count">
        <item quantity="one">%d item</item>
        <item quantity="other">%d items</item>
    </plurals>
    <string name="escaping_test">It&apos;s a &quot;test&quot; &amp; more</string>
</resources>
`;
  fs.writeFileSync(file, text);
  const doc = readLocaleDoc(file, "en", true, false);
  assert.equal(JSON.stringify(doc.data), JSON.stringify({
    welcome_title: "Welcome, %1$s!",
    colors: ["Red", "Green"],
    item_count: { one: "%d item", other: "%d items" },
    escaping_test: 'It\'s a "test" & more',
  }));

  const out = doc.serialize(
    {
      welcome_title: "Bienvenue, %1$s !",
      colors: ["Rouge", "Vert"],
      item_count: { one: "%d article", other: "%d articles" },
      escaping_test: 'C\'est un "test" & plus',
    },
    "fr",
  );
  assert.equal(
    out,
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- The app's own name, never translated -->
    <string name="app_name" translatable="false">MyApp</string>
    <!-- Shown on the welcome screen -->
    <string name="welcome_title">Bienvenue, %1$s !</string>
    <string-array name="colors">
        <item>Rouge</item>
        <item>Vert</item>
    </string-array>
    <plurals name="item_count">
        <item quantity="one">%d article</item>
        <item quantity="other">%d articles</item>
    </plurals>
    <string name="escaping_test">C\\'est un \\"test\\" &amp; plus</string>
</resources>
`,
  );

  // addNestedPluralForms reuses the Rails-style nested-plural machinery unchanged.
  const withMissing = addNestedPluralForms(doc.data, "ar");
  assert.equal(withMissing.added, 4);
  assert.deepEqual(Object.keys(withMissing.doc as Record<string, unknown>).includes("item_count"), true);
});

test("Android strings.xml: inline <xliff:g> markup survives a write, @string/ refs are never translated, quote-wrapped whitespace is kept", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-android-xml2-"));
  const file = path.join(dir, "strings.xml");
  const text = `<resources>
    <string name="time_left">You have <xliff:g id="time">%1$s</xliff:g> left</string>
    <string name="app_name_ref">@string/app_name</string>
    <string name="leading_space">"  padded on both sides  "</string>
    <string name="plain">Plain text</string>
</resources>
`;
  fs.writeFileSync(file, text);
  const doc = readLocaleDoc(file, "en", true, false);
  assert.equal(JSON.stringify(doc.data), JSON.stringify({
    time_left: "You have <xliff:g id=\"time\">%1$s</xliff:g> left",
    leading_space: "  padded on both sides  ",
    plain: "Plain text",
  }));
  // app_name_ref isn't in `data` at all: it's a pure resource reference, never a candidate for translation.
  assert.equal(Object.prototype.hasOwnProperty.call(doc.data as object, "app_name_ref"), false);

  const out = doc.serialize(
    {
      time_left: "Il vous reste <xliff:g id=\"time\">%1$s</xliff:g>",
      leading_space: "  rembourré des deux côtés  ",
      plain: "Texte simple",
    },
    "fr",
  );
  // Real inline markup comes out as actual XML, not HTML-escaped into visible text.
  assert.match(out, /<string name="time_left">Il vous reste <xliff:g id="time">%1\$s<\/xliff:g><\/string>/);
  assert.doesNotMatch(out, /&lt;xliff:g/);
  // The reference is reproduced byte-for-byte, never sent through translation.
  assert.match(out, /<string name="app_name_ref">@string\/app_name<\/string>/);
  // Quote-wrapping (and the whitespace it protects) survives the round-trip.
  assert.match(out, /<string name="leading_space">"  rembourré des deux côtés  "<\/string>/);
});

test("Android strings.xml: \\uXXXX escapes decode to the real character, and a leading \\@/\\? is re-escaped on write", () => {
  // A generic "drop the backslash, keep the next char" unescape pass turns
  // `Loading…` into the literal text `Loadingu2026` — the backslash is dropped
  // but the `u2026` is kept as-is, rather than decoding to "Loading…". And a value
  // that starts with a literal `@`/`?` must stay escaped (`\@`/`\?`) on write, or
  // Android's aapt2 build tool parses it as a resource/style reference and fails.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-android-xml4-"));
  const file = path.join(dir, "strings.xml");
  const text = `<resources>
    <string name="loading">Loading\\u2026</string>
    <string name="mention">\\@mention a teammate</string>
    <string name="help_ref">\\?attr/help</string>
    <string name="real_ref">@string/app_name</string>
</resources>
`;
  fs.writeFileSync(file, text);
  const doc = readLocaleDoc(file, "en", true, false);
  assert.equal(JSON.stringify(doc.data), JSON.stringify({
    loading: "Loading…",
    mention: "@mention a teammate",
    help_ref: "?attr/help",
  }));
  // The true @string/ reference is never a translation candidate, same as before.
  assert.equal(Object.prototype.hasOwnProperty.call(doc.data as object, "real_ref"), false);

  const out = doc.serialize(
    {
      loading: "Chargement…",
      mention: "@mention un coéquipier",
      help_ref: "?attr/aide",
    },
    "fr",
  );
  // Written as the real character directly (valid UTF-8 strings.xml), not re-escaped —
  // what matters is that it's the correct "…" character, not the corrupted "u2026" text.
  assert.match(out, /<string name="loading">Chargement…<\/string>/);
  assert.match(out, /<string name="mention">\\@mention un coéquipier<\/string>/);
  assert.match(out, /<string name="help_ref">\\\?attr\/aide<\/string>/);
  // Untouched true reference still round-trips byte-for-byte.
  assert.match(out, /<string name="real_ref">@string\/app_name<\/string>/);
});

test("Android strings.xml: a literal backslash is escaped on write, and an escaped backslash isn't mistaken for a \\uXXXX escape on read", () => {
  // escapeAndroidXml never escaped a literal `\` at all: "Saved to C:\Temp" came out
  // byte-for-byte the same, and Android's own unescaping then drops the backslash
  // (its generic "unknown escape" rule), displaying "C:Temp". And unescapeAndroidXml's
  // `\uXXXX` decode ran as its own separate pass before the generic backslash
  // fallback, so it couldn't tell a real `\uXXXX` escape from an escaped backslash
  // immediately followed by the literal text "uXXXX" (`\\u0041`, meaning one
  // backslash then "u0041") — it matched starting at the second backslash and wrongly
  // decoded that as U+0041 ("A"), leaving the first backslash to be eaten by the next
  // pass. Both escapes are handled in one combined pass now.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-android-xml5-"));
  const file = path.join(dir, "strings.xml");
  const text = `<resources>
    <string name="path">Saved to C:\\Temp</string>
    <string name="literal_escape">Literal \\\\u0041</string>
</resources>
`;
  fs.writeFileSync(file, text);
  const doc = readLocaleDoc(file, "en", true, false);
  assert.equal(JSON.stringify(doc.data), JSON.stringify({
    path: "Saved to C:Temp",
    literal_escape: "Literal \\u0041",
  }));

  const out = doc.serialize({ path: "Enregistre dans C:\\Temp", literal_escape: "Literal \\u0041" }, "fr");
  assert.match(out, /<string name="path">Enregistre dans C:\\\\Temp<\/string>/);
  assert.match(out, /<string name="literal_escape">Literal \\\\u0041<\/string>/);

  // Round-trip: writing it back and reading it again recovers the exact original text.
  fs.writeFileSync(path.join(dir, "fr.xml"), out);
  const reread = readLocaleDoc(path.join(dir, "fr.xml"), "fr", true, false);
  assert.equal((reread.data as Record<string, string>).path, "Enregistre dans C:\\Temp");
  assert.equal((reread.data as Record<string, string>).literal_escape, "Literal \\u0041");
});

test("Android strings.xml: translatable='false' (single quotes) is honored, and an orphan commented-out <string> isn't read as live", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-android-xml3-"));
  const file = path.join(dir, "strings.xml");
  const text = `<resources>
    <string name="app_name">My App</string>
    <string name="single_quoted" translatable='false'>DO_NOT_TRANSLATE</string>
    <!--
    <string name="old_unused">Should not appear, it's commented out at the end</string>
    -->
</resources>
`;
  fs.writeFileSync(file, text);
  const doc = readLocaleDoc(file, "en", true, false);
  assert.equal(JSON.stringify(doc.data), JSON.stringify({ app_name: "My App" }));
});

test("Android strings.xml: several product-qualified variants sharing one name keep their own product attribute, not one duplicate pair", () => {
  // <string name="title" product="tablet"> and product="default"> are two distinct,
  // device-specific resources — keying purely by name collapsed them into whichever
  // was read last and dropped the product attribute entirely, writing two identical
  // <string name="title"> elements (a duplicate-resource error under aapt2).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-android-product-"));
  const file = path.join(dir, "strings.xml");
  fs.writeFileSync(
    file,
    `<resources>
    <string name="title" product="tablet">Welcome, tablet user</string>
    <string name="title" product="default">Welcome</string>
    <string name="subtitle">Single variant, unaffected</string>
</resources>
`,
  );
  const doc = readLocaleDoc(file, "en", true, false);
  assert.equal(
    JSON.stringify(doc.data),
    JSON.stringify({ "title[tablet]": "Welcome, tablet user", "title[default]": "Welcome", subtitle: "Single variant, unaffected" }),
  );
  const out = doc.serialize({
    "title[tablet]": "Bienvenue, utilisateur tablette",
    "title[default]": "Bienvenue",
    subtitle: "Variante unique, non affectée",
  });
  assert.match(out, /<string name="title" product="tablet">Bienvenue, utilisateur tablette<\/string>/);
  assert.match(out, /<string name="title" product="default">Bienvenue<\/string>/);
  // The single-variant string keeps its plain, unqualified key and no product attribute.
  assert.match(out, /<string name="subtitle">Variante unique, non affectée<\/string>/);
  assert.equal([...out.matchAll(/<string name="title"/g)].length, 2, "both variants must survive, not collapse into one");
});

test("Android strings.xml: formatted=\"false\" and tools:ignore survive a rewrite instead of being dropped", () => {
  // The tag is rebuilt from scratch on every write, with only name/product/translatable
  // handled explicitly — any other attribute (formatted="false", required once a value mixes
  // a bare %s/%d with other text or aapt2's format check fails; tools:ignore, a lint
  // suppression) was silently lost.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-android-attrs-"));
  const file = path.join(dir, "strings.xml");
  fs.writeFileSync(
    file,
    `<resources>
    <string name="progress" formatted="false">%1$d%% complete, %2$s remaining</string>
    <string name="ignored" tools:ignore="UnusedResources">Unused but kept</string>
</resources>
`,
  );
  const doc = readLocaleDoc(file, "en", true, false);
  const out = doc.serialize({ progress: "FR:%1$d%% complete, %2$s remaining", ignored: "FR:Unused but kept" });
  assert.match(out, /<string name="progress" formatted="false">FR:/);
  assert.match(out, /<string name="ignored" tools:ignore="UnusedResources">FR:/);
});

test("Apple .xcstrings: source extraction skips shouldTranslate=false/device variants, falls back to the key itself", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-xcstrings-"));
  const file = path.join(dir, "Localizable.xcstrings");
  const catalog = {
    sourceLanguage: "en",
    strings: {
      Settings: { localizations: { en: { stringUnit: { state: "translated", value: "Settings" } } } },
      "App Bundle ID": { shouldTranslate: false, localizations: { en: { stringUnit: { state: "translated", value: "com.acme.app" } } } },
      "%lld items": {
        localizations: {
          en: {
            variations: {
              plural: {
                one: { stringUnit: { state: "translated", value: "%lld item" } },
                other: { stringUnit: { state: "translated", value: "%lld items" } },
              },
            },
          },
        },
      },
      "Device thing": { localizations: { en: { variations: { device: { iphone: { stringUnit: { state: "translated", value: "Phone" } } } } } } },
      Cancel: {},
    },
    version: "1.0",
  };
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2));

  const layout = detectLayout(dir, "en", file);
  assert.deepEqual(layout, { kind: "xcstrings", root: dir, file });
  assert.deepEqual(sourceFiles(layout, "en"), [file]);
  assert.equal(targetFile(layout, "en", "fr", file), file);
  assert.throws(() => detectLayout(dir, "de", file), /sourceLanguage "en", not "de"/);

  const doc = readLocaleDoc(file, "en", true);
  assert.equal(
    JSON.stringify(doc.data),
    JSON.stringify({
      Settings: "Settings",
      "%lld items": { one: "%lld item", other: "%lld items" },
      Cancel: "Cancel",
    }),
  );
});

test("Apple .xcstrings: translating several locales in one run shares the file without clobbering each other or untouched state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-xcstrings-"));
  const file = path.join(dir, "Localizable.xcstrings");
  const catalog = {
    sourceLanguage: "en",
    strings: {
      Settings: { localizations: { en: { stringUnit: { state: "translated", value: "Settings" } } } },
      "%lld items": {
        localizations: {
          en: {
            variations: {
              plural: {
                one: { stringUnit: { state: "translated", value: "%lld item" } },
                other: { stringUnit: { state: "translated", value: "%lld items" } },
              },
            },
          },
        },
      },
    },
    version: "1.0",
  };
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2));
  const layout = detectLayout(dir, "en", file);
  const doc = readLocaleDoc(file, "en", true);

  for (const [tag, marker] of [["fr", "FR"], ["ar", "AR"]] as const) {
    const target = targetFile(layout, "en", tag, file);
    const existing = fs.existsSync(target) ? readLocaleDoc(target, tag).data : undefined;
    let built = buildTarget(doc.data, existing, (s) => `[${marker}] ${s}`, false);
    built = addNestedPluralForms(built, tag).doc;
    const before = fs.readFileSync(target, "utf8");
    fs.writeFileSync(target, doc.serialize(built, tag, before));
  }

  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.strings.Settings.localizations.fr.stringUnit.value, "[FR] Settings");
  assert.equal(after.strings.Settings.localizations.ar.stringUnit.value, "[AR] Settings");
  assert.equal(after.strings.Settings.localizations.en.stringUnit.value, "Settings");
  // French only needs one/other/many; Arabic's 6 categories were all filled in by addNestedPluralForms.
  assert.deepEqual(Object.keys(after.strings["%lld items"].localizations.fr.variations.plural).toSorted(), ["many", "one", "other"]);
  assert.deepEqual(
    Object.keys(after.strings["%lld items"].localizations.ar.variations.plural).toSorted(),
    ["few", "many", "one", "other", "two", "zero"],
  );
  assert.deepEqual(existingTargets(layout, "en").toSorted(), ["ar", "fr"]);

  // A no-op rerun for fr must not disturb a translator's own "needs_review" flag.
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.strings.Settings.localizations.fr.stringUnit.state = "needs_review";
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  const srcRerun = readLocaleDoc(file, "en", true);
  const existingRerun = readLocaleDoc(file, "fr").data;
  assert.deepEqual(pendingStrings(srcRerun.data, existingRerun, false), []);
  let builtRerun = buildTarget(srcRerun.data, existingRerun, (s) => `[FR] ${s}`, false);
  builtRerun = addNestedPluralForms(builtRerun, "fr").doc;
  const beforeRerun = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, srcRerun.serialize(builtRerun, "fr", beforeRerun));
  const final = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(final.strings.Settings.localizations.fr.stringUnit.state, "needs_review");
});

test("Apple .xcstrings: writes Xcode's own \"key\" : value colon spacing, so a no-op rerun is byte-identical", () => {
  // JSON.stringify's pretty-printer writes "key": value; Xcode's own serializer
  // writes "key" : value (a space before the colon too) — the mismatch alone used to
  // put the whole file in the diff on every run, translated or not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-xcstrings-colon-"));
  const file = path.join(dir, "Localizable.xcstrings");
  const text = [
    "{",
    '  "sourceLanguage" : "en",',
    '  "strings" : {',
    '    "Time: %@" : {',
    '      "localizations" : {',
    '        "en" : {',
    '          "stringUnit" : {',
    '            "state" : "translated",',
    '            "value" : "Time: %@"',
    "          }",
    "        },",
    '        "fr" : {',
    '          "stringUnit" : {',
    '            "state" : "translated",',
    '            "value" : "FR:Time: %@"',
    "          }",
    "        }",
    "      }",
    "    }",
    "  },",
    '  "version" : "1.0"',
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(file, text);

  const doc = readLocaleDoc(file, "en", true);
  const existing = readLocaleDoc(file, "fr").data;
  assert.deepEqual(pendingStrings(doc.data, existing, false), [], "already translated: nothing pending");
  const built = buildTarget(doc.data, existing, (s) => `[translated] ${s}`, false);
  const out = doc.serialize(built, "fr", text);
  assert.equal(out, text, "a no-op rerun reproduces Xcode's own colon spacing byte-for-byte");

  // A colon inside a string's own text (not a JSON key-value separator) is never touched.
  assert.match(out, /"value" : "FR:Time: %@"/);
});

test("flattenStrings: key paths for nested objects and arrays", () => {
  assert.deepEqual(flattenStrings({ a: "x", b: { c: "y" }, d: ["p", "q"] }), [
    { path: "a", value: "x" },
    { path: "b.c", value: "y" },
    { path: "d[0]", value: "p" },
    { path: "d[1]", value: "q" },
  ]);
  assert.deepEqual(flattenStrings("just a string"), [{ path: "(root)", value: "just a string" }]);
});

test("flattenStrings/pendingEntries: a flat key containing a literal dot never collides with a same-shaped nested path", () => {
  // Without escaping, a flat key "a.b" and a nested a -> b both flatten to the exact
  // same path string "a.b" — the lock file (keyed by this string) can't tell them
  // apart, so whichever is recorded last overwrites the other's entry, leaving it
  // permanently "stale" and re-translated every run, and `check` reporting it as such.
  const data = { "a.b": "literal dotted key", a: { b: "nested value" } };
  const flat = flattenStrings(data);
  const paths = flat.map((e) => e.path);
  assert.equal(new Set(paths).size, paths.length, "every path must be unique");
  assert.deepEqual(flat, [
    { path: "a\\.b", value: "literal dotted key" },
    { path: "a.b", value: "nested value" },
  ]);

  const pending = pendingEntries(data, {}, false);
  assert.deepEqual(
    pending.map((e) => e.path),
    ["a\\.b", "a.b"],
  );
});

test("existingTargets: finds already-translated locales, dir and file layout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-targets-"));
  fs.mkdirSync(path.join(root, "locales/en"), { recursive: true });
  fs.mkdirSync(path.join(root, "locales/fr"), { recursive: true });
  fs.mkdirSync(path.join(root, "locales/empty")); // no locale files inside: not a target
  // Sibling folders that happen to hold locale-shaped files but aren't locales.
  fs.mkdirSync(path.join(root, "locales/__mocks__"));
  fs.mkdirSync(path.join(root, "locales/schemas"));
  fs.writeFileSync(path.join(root, "locales/en/common.json"), "{}");
  fs.writeFileSync(path.join(root, "locales/fr/common.json"), "{}");
  fs.writeFileSync(path.join(root, "locales/__mocks__/common.json"), "{}");
  fs.writeFileSync(path.join(root, "locales/schemas/common.json"), "{}");
  const l = detectLayout(root, "en");
  assert.deepEqual(existingTargets(l, "en"), ["fr"]);

  const fileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lai-targets-file-"));
  fs.writeFileSync(path.join(fileRoot, "en.json"), "{}");
  fs.writeFileSync(path.join(fileRoot, "fr.json"), "{}");
  fs.writeFileSync(path.join(fileRoot, "de.json"), "{}");
  fs.writeFileSync(path.join(fileRoot, "schema.json"), "{}");
  const f = detectLayout(fileRoot, "en");
  assert.deepEqual(existingTargets(f, "en"), ["de", "fr"]);
});

test("YAML locale files: dir layout (mixed with JSON), file layout, and round-trip style", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-yaml-"));
  fs.mkdirSync(path.join(root, "locales/en"), { recursive: true });
  fs.writeFileSync(path.join(root, "locales/en/common.json"), "{}");
  fs.writeFileSync(path.join(root, "locales/en/auth.yaml"), "login:\n  submit: Sign in\n");

  const l = detectLayout(root, "en");
  assert.equal(l.kind, "dir");
  const files = sourceFiles(l, "en");
  assert.deepEqual(
    files.map((f) => path.basename(f)).sort(),
    ["auth.yaml", "common.json"],
  );
  const yamlSrc = files.find((f) => f.endsWith(".yaml"))!;
  assert.equal(targetFile(l, "en", "fr", yamlSrc), path.join(root, "locales/fr/auth.yaml"));

  const doc = readLocaleDoc(yamlSrc, "en");
  assert.deepEqual(doc.data, { login: { submit: "Sign in" } });
  // Unchanged data re-serializes to the same text (indent and trailing newline preserved).
  assert.equal(doc.serialize(doc.data, "en"), "login:\n  submit: Sign in\n");
  // An edited value keeps the same style.
  assert.equal(doc.serialize({ login: { submit: "Se connecter" } }, "fr"), "login:\n  submit: Se connecter\n");

  // File layout: <root>/en.yaml -> <root>/fr.yaml, not .json.
  const fileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lai-yaml-file-"));
  fs.writeFileSync(path.join(fileRoot, "en.yml"), "greeting: Hello\n");
  const fl = detectLayout(fileRoot, "en");
  assert.equal(fl.kind, "file");
  assert.equal(targetFile(fl, "en", "fr", sourceFiles(fl, "en")[0]), path.join(fileRoot, "fr.yml"));
});

test("YAML: a bare numeric key is updated in place, not duplicated as a second quoted pair", () => {
  // YAML parses a bare `404:` as the JS *number* 404, while every key this tool's own
  // pipeline passes back in (from Object.entries()) is always a *string* "404". Looking
  // that up with Document#setIn's strict key-identity match misses the existing
  // number-keyed pair entirely and inserts a second, "404"-quoted one next to it,
  // leaving the original untranslated.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-yaml-numkey-"));
  const file = path.join(root, "en.yaml");
  fs.writeFileSync(file, "errors:\n  404: Not found\n  title: Errors\n  500: Server error\n");
  const doc = readLocaleDoc(file, "en");
  const translated = { errors: { "404": "FR:Not found", title: "FR:Errors", "500": "FR:Server error" } };
  const out = doc.serialize(translated, "fr");
  assert.equal((out.match(/404/g) ?? []).length, 1, "the numeric key appears exactly once, not duplicated");
  assert.equal((out.match(/Not found/g) ?? []).length, 1, "the English value isn't left behind untranslated alongside the translated one");
  assert.match(out, /404: FR:Not found/);

  // Idempotent rerun over its own output: still no duplicate.
  const again = doc.serialize(translated, "fr", out);
  assert.equal((again.match(/404/g) ?? []).length, 1);
});

test("YAML: a merge key or a plain alias no longer crashes the whole file, and doesn't double-count its strings", () => {
  // `Document#setIn`/`getIn` only walk through real Map/Seq nodes; an ordinary alias
  // used as a pair's value (`profile: *common`) is an Alias node, not a collection, so
  // writing anything under it used to throw "Expected YAML collection at profile" and
  // abort the whole file with no target written, not a regression (0.7.13 and 0.7.17
  // crash the same way). A Rails-style merge key (`<<: *defaults`) didn't crash, but
  // without the `merge: true` schema option its `<<` subtree is read as an ordinary
  // key holding its own nested copy of the merged-in strings — double-counting them
  // alongside the anchor's own copy — instead of flattening straight into the map.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-yaml-alias-"));

  // Plain alias: must not throw, and must produce a real (translatable) value.
  const aliasFile = path.join(root, "alias.yaml");
  fs.writeFileSync(aliasFile, "common: &common\n  save: Save\n  cancel: Cancel\n\nprofile: *common\n");
  const aliasDoc = readLocaleDoc(aliasFile, "en");
  assert.deepEqual(aliasDoc.data, { common: { save: "Save", cancel: "Cancel" }, profile: { save: "Save", cancel: "Cancel" } });
  const aliasOut = aliasDoc.serialize(
    { common: { save: "FR:Save", cancel: "FR:Cancel" }, profile: { save: "FR:Save", cancel: "FR:Cancel" } },
    "fr",
  );
  assert.match(aliasOut, /profile:\n {2}save: FR:Save\n {2}cancel: FR:Cancel/);
  // Idempotent rerun over its own output: still no crash, no drift.
  assert.doesNotThrow(() =>
    aliasDoc.serialize({ common: { save: "FR:Save", cancel: "FR:Cancel" }, profile: { save: "FR:Save", cancel: "FR:Cancel" } }, "fr", aliasOut),
  );

  // Merge key: `data` flattens straight through, no `<<` artifact and no double-counting.
  const mergeFile = path.join(root, "merge.yaml");
  fs.writeFileSync(mergeFile, "defaults: &defaults\n  save: Save\n  cancel: Cancel\n\nprofile:\n  <<: *defaults\n  title: Profile\n");
  const mergeDoc = readLocaleDoc(mergeFile, "en");
  assert.deepEqual(mergeDoc.data, {
    defaults: { save: "Save", cancel: "Cancel" },
    profile: { save: "Save", cancel: "Cancel", title: "Profile" },
  });
  assert.equal(Object.prototype.hasOwnProperty.call((mergeDoc.data as { profile: object }).profile, "<<"), false);
  assert.doesNotThrow(() =>
    mergeDoc.serialize(
      { defaults: { save: "FR:Save", cancel: "FR:Cancel" }, profile: { save: "FR:Save", cancel: "FR:Cancel", title: "FR:Profile" } },
      "fr",
    ),
  );
});

test("YAML: a merge key stays exactly where it was in the source, not moved to the end of the map", () => {
  // The `yaml` package (and PyYAML) give an explicit key priority over a `<<` merge
  // key regardless of where `<<` sits in the map, but Ruby's Psych (what Rails uses)
  // applies `<<` where it textually appears — so if `reorderToMatch` moved `<<` after
  // an overriding key, Ruby would apply the merge LAST and silently discard the
  // override. Confirmed against real Ruby/Psych, not just this project's own reading
  // of the YAML spec.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-yaml-merge-order-"));
  const file = path.join(root, "en.yml");
  fs.writeFileSync(
    file,
    "defaults: &defaults\n  save: Save\n  cancel: Cancel\nprofile:\n  <<: *defaults\n  save: Save profile\n  title: Profile\n",
  );
  const doc = readLocaleDoc(file, "en");
  const out = doc.serialize(
    {
      defaults: { save: "FR:Save", cancel: "FR:Cancel" },
      profile: { save: "FR:Save profile", cancel: "FR:Cancel", title: "FR:Profile" },
    },
    "fr",
  );
  assert.match(out, /profile:\n {2}<<: \*defaults\n {2}save: FR:Save profile/, out);

  // Still holds on a rerun over an existing target, with a brand-new key added alongside it.
  const rerun = doc.serialize(
    {
      defaults: { save: "FR:Save", cancel: "FR:Cancel" },
      profile: { save: "FR:Save profile", cancel: "FR:Cancel", title: "FR:Profile", subtitle: "FR:Subtitle" },
    },
    "fr",
    out,
  );
  assert.match(rerun, /profile:\n {2}<<: \*defaults\n {2}save: FR:Save profile/, rerun);
});

test("YAML: a key dropped by buildTarget's isOrphaned pruning is removed from the target, not left behind forever (regression)", () => {
  // Unlike the JSON writer (built fresh from the new data alone, so a dropped key just
  // isn't there), this serializer edits the existing document in place and otherwise
  // only ever sets/reorders paths the new data already has — nothing deleted a pair
  // that fell out of the source, so a renamed/deleted key lingered in the YAML target
  // forever even after buildTarget correctly excluded it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-yaml-prune-"));
  const file = path.join(root, "fr.yml");
  fs.writeFileSync(file, "greeting: Bonjour\nold_key: Valeur supprimée\nnested:\n  kept: Garde\n  gone: Supprime\n");
  const doc = readLocaleDoc(file, "fr");
  const out = doc.serialize({ greeting: "Bonjour", nested: { kept: "Garde" } }, "fr");
  assert.equal(out, "greeting: Bonjour\nnested:\n  kept: Garde\n");

  // A merge key itself is never swept up by the same pruning (its contents live in
  // the data's siblings via toJS({merge:true}), not as a key of v's own).
  const merged = path.join(root, "fr-merge.yml");
  fs.writeFileSync(merged, "defaults: &defaults\n  save: Save\nprofile:\n  <<: *defaults\n  stale: Supprime\n");
  const mergedDoc = readLocaleDoc(merged, "fr");
  const mergedOut = mergedDoc.serialize({ defaults: { save: "Save" }, profile: { save: "Save" } }, "fr");
  assert.match(mergedOut, /profile:\n {2}<<: \*defaults\n {2}save: Save\n/, mergedOut);
  assert.ok(!mergedOut.includes("stale"));
});

test("Rails-style YAML: single top-level key matching the locale tag is unwrapped, and rewrapped under the target's tag", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-yaml-rails-"));
  const file = path.join(root, "en.yml");
  fs.writeFileSync(file, "en:\n  hello: Hello\n  greeting: Hi %{name}\n");

  const doc = readLocaleDoc(file, "en");
  assert.deepEqual(doc.data, { hello: "Hello", greeting: "Hi %{name}" });
  assert.equal(doc.serialize(doc.data, "en"), "en:\n  hello: Hello\n  greeting: Hi %{name}\n");

  const built = { hello: "Bonjour", greeting: "Bonjour %{name}" };
  assert.equal(doc.serialize(built, "fr"), "fr:\n  hello: Bonjour\n  greeting: Bonjour %{name}\n");

  // A plain (unwrapped) YAML file is untouched even if it happens to have one top-level key,
  // as long as that key isn't the source locale's own tag.
  const plain = path.join(root, "en2.yml");
  fs.writeFileSync(plain, "login:\n  submit: Sign in\n");
  const plainDoc = readLocaleDoc(plain, "en");
  assert.deepEqual(plainDoc.data, { login: { submit: "Sign in" } });
  assert.equal(plainDoc.serialize(plainDoc.data, "fr"), "login:\n  submit: Sign in\n");
});

test("YAML: comments survive a translation rewrite, on a fresh target and on a rerun over an edited one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-yaml-comments-"));
  const file = path.join(root, "en.yml");
  fs.writeFileSync(
    file,
    "# top-level note\nlogin:\n  # shown on the sign-in button\n  submit: Sign in # inline note\n  cancel: Cancel\n",
  );
  const doc = readLocaleDoc(file, "en");

  // First write for a target that doesn't exist yet: the source's own comments carry over.
  const first = doc.serialize({ login: { submit: "Se connecter", cancel: "Annuler" } }, "fr");
  assert.equal(
    first,
    "# top-level note\nlogin:\n  # shown on the sign-in button\n  submit: Se connecter # inline note\n  cancel: Annuler\n",
  );

  // A translator hand-edits the target and adds their own comment; a rerun (passing the
  // target's current text as `existingText`) keeps it, including on the unchanged value.
  const edited =
    "# top-level note\nlogin:\n  # shown on the sign-in button\n  submit: Se connecter ! # inline note\n  # double-checked\n  cancel: Annuler\n";
  const rerun = doc.serialize({ login: { submit: "Se connecter !", cancel: "Annuler" } }, "fr", edited);
  assert.equal(rerun, edited);

  // A key added to the source since the last run is appended with no comment of its own.
  fs.writeFileSync(
    file,
    "# top-level note\nlogin:\n  # shown on the sign-in button\n  submit: Sign in # inline note\n  cancel: Cancel\n  reset: Reset password\n",
  );
  const doc2 = readLocaleDoc(file, "en");
  const withNewKey = doc2.serialize(
    { login: { submit: "Se connecter !", cancel: "Annuler", reset: "Réinitialiser le mot de passe" } },
    "fr",
    edited,
  );
  assert.equal(
    withNewKey,
    "# top-level note\nlogin:\n  # shown on the sign-in button\n  submit: Se connecter ! # inline note\n  # double-checked\n  cancel: Annuler\n  reset: Réinitialiser le mot de passe\n",
  );
});

test("Rails-style YAML: the wrapper key's own comments carry over when rewrapped under the target's tag", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-yaml-rails-comments-"));
  const file = path.join(root, "en.yml");
  fs.writeFileSync(file, "# locale file\nen:\n  hello: Hello # greeting\n");
  const doc = readLocaleDoc(file, "en");
  assert.equal(doc.serialize({ hello: "Bonjour" }, "fr"), "# locale file\nfr:\n  hello: Bonjour # greeting\n");
});

test("addNestedPluralForms: Rails-style nested one/other groups get the target language's missing categories", () => {
  const data = {
    item: { one: "%{count} item", other: "%{count} items" },
    // Not a plural group: a lone "other" key is too common as an ordinary value to assume.
    single: { other: "Misc" },
    nested: { deep: { one: "one deep thing", other: "%{count} deep things" } },
  };
  const { doc, added } = addNestedPluralForms(data, "ar");
  assert.equal(added, 8); // ar needs zero/one/two/few/many/other; 4 missing per group, 2 groups
  assert.equal(
    JSON.stringify(doc),
    JSON.stringify({
      item: {
        zero: "%{count} items",
        one: "%{count} item",
        two: "%{count} items",
        few: "%{count} items",
        many: "%{count} items",
        other: "%{count} items",
      },
      single: { other: "Misc" },
      nested: {
        deep: {
          zero: "%{count} deep things",
          one: "one deep thing",
          two: "%{count} deep things",
          few: "%{count} deep things",
          many: "%{count} deep things",
          other: "%{count} deep things",
        },
      },
    }),
  );

  // English only needs one/other: nothing is added.
  const { doc: en, added: addedEn } = addNestedPluralForms(data, "en");
  assert.equal(addedEn, 0);
  assert.equal(JSON.stringify((en as { item: unknown }).item), JSON.stringify({ one: "%{count} item", other: "%{count} items" }));
});

test("Apple .strings: comments kept per key, round-trip style, new keys appended", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-strings-"));
  const file = path.join(root, "en.strings");
  fs.writeFileSync(file, '/* Shown on launch */\n"greeting" = "Hello, %@!";\n\n"farewell" = "Goodbye";\n');
  const doc = readLocaleDoc(file, "en");
  assert.equal(JSON.stringify(doc.data), '{"greeting":"Hello, %@!","farewell":"Goodbye"}');
  assert.equal(doc.serialize(doc.data, "en"), '/* Shown on launch */\n"greeting" = "Hello, %@!";\n\n"farewell" = "Goodbye";\n');
  assert.equal(
    doc.serialize({ greeting: "Bonjour, %@!", farewell: "Au revoir", extra: "New" }, "fr"),
    '/* Shown on launch */\n"greeting" = "Bonjour, %@!";\n\n"farewell" = "Au revoir";\n\n"extra" = "New";\n',
  );
});

test("Apple .strings: // line comments (single and consecutive) are kept per key too", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-strings-linecomment-"));
  const file = path.join(root, "en.strings");
  fs.writeFileSync(
    file,
    '// Shown on launch\n"greeting" = "Hello, %@!";\n\n// Shown twice\n// when the user signs out\n"farewell" = "Goodbye";\n',
  );
  const doc = readLocaleDoc(file, "en");
  assert.equal(JSON.stringify(doc.data), '{"greeting":"Hello, %@!","farewell":"Goodbye"}');
  assert.equal(
    doc.serialize(doc.data, "en"),
    '// Shown on launch\n"greeting" = "Hello, %@!";\n\n// Shown twice\n// when the user signs out\n"farewell" = "Goodbye";\n',
  );
});

test("Apple .strings: unquoted keys and \\Uxxxx escapes are read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-strings-unquoted-"));
  const file = path.join(root, "en.strings");
  fs.writeFileSync(file, 'title = "Caf\\U00e9";\n"greeting" = "Hello";\n');
  const doc = readLocaleDoc(file, "en");
  assert.equal(JSON.stringify(doc.data), '{"title":"Café","greeting":"Hello"}');
});

test("Apple .strings: a UTF-16 (BOM) file is read like a UTF-8 one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-strings-utf16-"));
  const content = '"greeting" = "Caf\\U00e9!";\n"farewell" = "Goodbye";\n';

  const le = path.join(root, "en.strings");
  fs.writeFileSync(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]));
  assert.equal(JSON.stringify(readLocaleDoc(le, "en").data), '{"greeting":"Café!","farewell":"Goodbye"}');

  const beBytes = Buffer.from(content, "utf16le");
  for (let i = 0; i + 1 < beBytes.length; i += 2) [beBytes[i], beBytes[i + 1]] = [beBytes[i + 1], beBytes[i]];
  const be = path.join(root, "fr.strings");
  fs.writeFileSync(be, Buffer.concat([Buffer.from([0xfe, 0xff]), beBytes]));
  assert.equal(JSON.stringify(readLocaleDoc(be, "fr").data), '{"greeting":"Café!","farewell":"Goodbye"}');
});

test("detectEncoding/decodeText/encodeText: UTF-16LE and UTF-16BE BOMs round-trip, UTF-8 stays a plain string", () => {
  const text = "café";
  assert.equal(detectEncoding(Buffer.from(text, "utf8")), "utf8");
  const plain = encodeText(text, "utf8");
  assert.equal(typeof plain, "string", "utf8 is never wrapped in a Buffer");
  assert.equal(plain, text);

  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  assert.equal(detectEncoding(le), "utf16le-bom");
  assert.equal(decodeText(le, "utf16le-bom"), text);
  assert.deepEqual(encodeText(text, "utf16le-bom"), le);

  const beBody = Buffer.from(text, "utf16le");
  for (let i = 0; i + 1 < beBody.length; i += 2) [beBody[i], beBody[i + 1]] = [beBody[i + 1], beBody[i]];
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
  assert.equal(detectEncoding(be), "utf16be-bom");
  assert.equal(decodeText(be, "utf16be-bom"), text);
  assert.deepEqual(encodeText(text, "utf16be-bom"), be);
});

test("translate: a UTF-16 (BOM) .strings target keeps its own encoding instead of being rewritten as UTF-8", async () => {
  // Regression: the existing target was read with a plain fs.readFileSync(file, "utf8")
  // instead of the same BOM-aware decode every other read in this project uses — for a
  // UTF-16 ".strings" file (Xcode's traditional default) that garbled "before" into
  // mojibake, which never equaled the freshly serialized text, so even a no-op run
  // rewrote the file from scratch as plain UTF-8, permanently losing its BOM/encoding.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-utf16-target-"));
  fs.mkdirSync(path.join(dir, "en.lproj"));
  fs.mkdirSync(path.join(dir, "fr.lproj"));
  fs.writeFileSync(path.join(dir, "en.lproj/Localizable.strings"), '"hello" = "Hi";\n');
  const frBefore = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('"hello" = "FR:Hi";\n', "utf16le")]);
  const frFile = path.join(dir, "fr.lproj/Localizable.strings");
  fs.writeFileSync(frFile, frBefore);

  // Already fully translated and non-stale: no model needed, so this stays fast.
  const result = await translate({ cwd: dir, from: "en", to: "fr", input: dir });
  assert.equal(result.locales[0]!.stringsTranslated, 0);
  assert.equal(result.locales[0]!.filesWritten, 0, "nothing actually changed: a no-op run never touches the file at all");
  assert.deepEqual(fs.readFileSync(frFile), frBefore, "byte-for-byte unchanged, BOM included");
});

test("Java .properties: detection (bare and prefixed), region qualifier uses an underscore, not a hyphen", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-properties-"));
  fs.writeFileSync(path.join(root, "messages_en.properties"), "greeting=Hi\n");

  const l = detectLayout(root, "en");
  assert.deepEqual(l, { kind: "file", root, ext: ".properties", prefix: "messages" });
  const files = sourceFiles(l, "en");
  assert.deepEqual(files, [path.join(root, "messages_en.properties")]);
  assert.equal(targetFile(l, "en", "fr", files[0]), path.join(root, "messages_fr.properties"));
  assert.equal(targetFile(l, "en", "pt-BR", files[0]), path.join(root, "messages_pt_BR.properties"));

  fs.writeFileSync(path.join(root, "messages_pt_BR.properties"), "greeting=Oi\n");
  assert.deepEqual(existingTargets(l, "en"), ["pt-BR"]);

  // A bare "en.properties" (no app-name prefix) is also detected.
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "lai-properties-bare-"));
  fs.writeFileSync(path.join(root2, "en.properties"), "greeting=Hi\n");
  assert.deepEqual(detectLayout(root2, "en"), { kind: "file", root: root2, ext: ".properties" });
});

test("Java .properties: comments/continuation/escapes on read; in-place edit on rerun keeps untouched lines and a hand-added comment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-properties-rw-"));
  const file = path.join(root, "en.properties");
  const text = `# App messages
! legacy bang-comment too

greeting=Hello, world!
app.title: My App
long.value=This is a very long \\
    continued value
leading.space=\\ padded
`;
  fs.writeFileSync(file, text);
  const doc = readLocaleDoc(file, "en", true);
  assert.equal(
    JSON.stringify(doc.data),
    JSON.stringify({
      greeting: "Hello, world!",
      "app.title": "My App",
      "long.value": "This is a very long continued value",
      "leading.space": " padded",
    }),
  );

  const translated = {
    greeting: "[FR] Hello, world!",
    "app.title": "[FR] My App",
    "long.value": "[FR] long value",
    "leading.space": "[FR]  padded",
  };
  const out = doc.serialize(translated, "fr");
  assert.equal(
    out,
    `# App messages
! legacy bang-comment too

greeting=[FR] Hello, world!
app.title: [FR] My App
long.value=[FR] long value
leading.space=[FR]  padded
`,
  );

  // A hand-added comment and untouched values survive a no-op rerun.
  const edited = out.replace("greeting=", "# translator note\ngreeting=");
  const rebuilt = buildTarget(doc.data, JSON.parse(JSON.stringify(translated)), () => {
    throw new Error("should not translate anything on a no-op rerun");
  }, false);
  const rerun = doc.serialize(rebuilt, "fr", edited);
  assert.equal(rerun, edited);
});

test("Java .properties: a key dropped by buildTarget's isOrphaned pruning is removed from the file, not left as a blank `key=` (regression)", () => {
  // Writing `key=` instead of deleting the line was worse than the pre-pruning
  // behavior: Java finds the key and uses that empty string rather than falling back
  // to the English default, whereas the old (unpruned) text at least showed something.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-properties-prune-"));
  const file = path.join(root, "fr.properties");
  fs.writeFileSync(file, "greeting=Bonjour\nold.key=Valeur supprimée\n");
  const doc = readLocaleDoc(file, "fr");
  // "old.key" is absent from the built target entirely — buildTarget already pruned
  // it as orphaned, not just left it translated to "".
  const out = doc.serialize({ greeting: "Bonjour" }, "fr");
  assert.equal(out, "greeting=Bonjour\n");
});

test("Java .properties: a key whose source value uses \\uXXXX escapes keeps using them on write, instead of switching to raw UTF-8", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-properties-unicode-"));
  const file = path.join(root, "en.properties");
  fs.writeFileSync(file, "greeting=Caf\\u00e9 reward\nplain=Plain text\n");
  const doc = readLocaleDoc(file, "en", true);
  assert.equal(JSON.stringify(doc.data), JSON.stringify({ greeting: "Café reward", plain: "Plain text" }));

  // First write (no existing target): the source's own \u-escape convention is followed per key.
  const out = doc.serialize({ greeting: "Récompense café", plain: "Texte simple" }, "fr");
  assert.equal(out, "greeting=R\\u00e9compense caf\\u00e9\nplain=Texte simple\n");

  // Rewriting an existing target that itself used raw UTF-8 for a key keeps THAT key's own convention,
  // even though the source used an escape for it.
  const existingFr = "greeting=Ancien\nplain=Ancien aussi\n";
  const rerun = doc.serialize({ greeting: "Nouveau café", plain: "Nouveau aussi" }, "fr", existingFr);
  assert.equal(rerun, "greeting=Nouveau café\nplain=Nouveau aussi\n");
});

test("Java .properties: an apostrophe is doubled when the value has a {0}-style MessageFormat placeholder, left alone otherwise", () => {
  // java.text.MessageFormat (the usual way a `{0}`-placeholder resource string gets
  // interpolated) treats a bare `'` as the start of a literal-quoted run whenever `{N}`
  // syntax appears anywhere in the pattern; `''` is its documented escape for one
  // literal apostrophe. Scoped to values with a `{N}` placeholder only — plain
  // ResourceBundle.getString() does no substitution at all, so doubling an apostrophe
  // in a value with no placeholder would just put a stray `''` in front of someone.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-properties-apostrophe-"));
  const file = path.join(root, "en.properties");
  fs.writeFileSync(file, "close=Cannot open {0}\nunavailable=Not available\n");
  const doc = readLocaleDoc(file, "en", true);
  assert.equal(JSON.stringify(doc.data), JSON.stringify({ close: "Cannot open {0}", unavailable: "Not available" }));

  const out = doc.serialize({ close: "Impossible d'ouvrir {0}", unavailable: "Il n'est pas disponible" }, "fr");
  assert.equal(out, "close=Impossible d''ouvrir {0}\nunavailable=Il n'est pas disponible\n");

  // Round-trips back to the single-apostrophe form it started from.
  fs.writeFileSync(path.join(root, "fr.properties"), out);
  const rereadDoc = readLocaleDoc(path.join(root, "fr.properties"), "fr", true);
  assert.equal((rereadDoc.data as Record<string, string>).close, "Impossible d'ouvrir {0}");
  assert.equal((rereadDoc.data as Record<string, string>).unavailable, "Il n'est pas disponible");
});

test("Java .properties: a typed MessageFormat argument ({0,number,integer}) still triggers apostrophe-doubling, and intentional '{0}'-literal quoting is left alone", () => {
  // The placeholder check only matched a bare `{0}`, not the extended
  // `{0,number,integer}`/`{0,date}` forms — so an apostrophe next to one of those
  // stayed single, and MessageFormat would eat it into a quoted run same as before
  // the fix. Separately, `'{0}'` is MessageFormat's own documented way to show a
  // placeholder's braces literally (no substitution) — blindly doubling every
  // apostrophe turns that into `''{0}''`, which un-protects the placeholder instead
  // of keeping it literal, exactly backwards from the intent.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-properties-typed-"));
  const file = path.join(root, "en.properties");
  fs.writeFileSync(file, "count=User has {0,number,integer} files\nliteral=Type {0} literally\n");
  const doc = readLocaleDoc(file, "en", true);
  assert.equal(
    JSON.stringify(doc.data),
    JSON.stringify({ count: "User has {0,number,integer} files", literal: "Type {0} literally" }),
  );

  const out = doc.serialize(
    { count: "L'utilisateur a {0,number,integer} fichiers", literal: "Type '{0}' literally" },
    "fr",
  );
  assert.equal(
    out,
    "count=L''utilisateur a {0,number,integer} fichiers\nliteral=Type '{0}' literally\n",
  );

  // Round-trips: the typed-arg apostrophe comes back single, the intentional quoting survives untouched.
  fs.writeFileSync(path.join(root, "fr.properties"), out);
  const reread = readLocaleDoc(path.join(root, "fr.properties"), "fr", true);
  assert.equal((reread.data as Record<string, string>).count, "L'utilisateur a {0,number,integer} fichiers");
  assert.equal((reread.data as Record<string, string>).literal, "Type '{0}' literally");
});

test("Java .properties: two unrelated elisions in the same value are both doubled, not left alone just because they pair up", () => {
  // 0.7.19 judged a value's quotes "intentional" whenever they came out balanced
  // overall (an even count of unpaired `'`s) — but two ordinary French/Italian
  // elisions pair up by coincidence just as often as a genuine `'{0}'` idiom does.
  // "L'utilisateur n'a pas accès à {0}." has two such elisions and no intentional
  // quoting at all; written with only one of them (or neither) doubled, MessageFormat
  // reads the first `'` as opening a literal-quoted run that swallows everything up
  // to the next `'`, dropping "utilisateur n" from view and only coincidentally still
  // substituting {0} because it happens to fall outside that run. The fix only treats
  // the two quotes directly wrapping a placeholder (`'{0}'`) as intentional; every
  // other apostrophe is doubled regardless of how many others are in the string —
  // including one that merely sits next to an unrelated brace without a matching
  // closing quote, as in "L'{0} n'existe pas" (elision right before the placeholder,
  // not the literal-braces idiom, since there's no `'` right after the `}`).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-properties-elisions-"));
  const file = path.join(root, "en.properties");
  fs.writeFileSync(file, "denied=User {0} denied access\nmissing=The {0} does not exist\n");
  const doc = readLocaleDoc(file, "en", true);

  const out = doc.serialize(
    { denied: "L'utilisateur n'a pas accès à {0}.", missing: "L'{0} n'existe pas" },
    "fr",
  );
  assert.equal(
    out,
    "denied=L''utilisateur n''a pas accès à {0}.\nmissing=L''{0} n''existe pas\n",
  );

  // Round-trips back to the original single-apostrophe form.
  fs.writeFileSync(path.join(root, "fr.properties"), out);
  const reread = readLocaleDoc(path.join(root, "fr.properties"), "fr", true);
  assert.equal((reread.data as Record<string, string>).denied, "L'utilisateur n'a pas accès à {0}.");
  assert.equal((reread.data as Record<string, string>).missing, "L'{0} n'existe pas");
});

test("Java .properties: ''{0}'' (quoted substituted value) round-trips distinctly from '{0}' (literal unsubstituted braces), and a lone/named quoted brace isn't doubled", () => {
  // 0.7.20's fix only recognized the single-quote `'{0}'` idiom (literal braces, no
  // substitution). Two problems it didn't cover, both reported after a real fr/de run:
  //
  // 1. `''{0}''` is MessageFormat's OTHER quoting idiom — a common Spring/Bean
  //    Validation pattern ("The value ''{0}'' is not valid.") that wraps the
  //    *substituted* value in a literal apostrophe (since `''` never opens a quoted
  //    run, {0} in between still gets replaced). `unescapeProperties` collapses it to
  //    the same `'{0}'` text as the literal-braces idiom the moment the source is
  //    read, before translation ever happens — so by write time there's no way to
  //    tell the two apart from the text alone. The fix captures which argument
  //    indices used the doubled form straight from the raw source line (`QUOTED_ARG_RE`)
  //    and carries that alongside the key, so write-time escaping knows to double
  //    those quotes rather than protect them, no matter what the translated text
  //    around {0} looks like. (The German case broke even in 0.7.19, not just
  //    0.7.20, since 0.7.19's literal-braces idiom — same single-quote shape — won
  //    there too whenever there was no OTHER apostrophe to balance against.)
  // 2. `'{'` (a lone literal brace) and `'{name}'` (literal, non-numeric braces) are
  //    also MessageFormat's literal-quoting idiom, just not shaped like a `{N}`
  //    placeholder — 0.7.20's placeholder-shaped regex didn't recognize them and
  //    doubled their quotes, which 0.7.19 (by sheer luck of its whole-string-balance
  //    check) and 0.7.18 (narrower, digit-only) had both gotten wrong in their own
  //    ways. Broadened to match any quote directly touching a brace, balanced or
  //    lone — still requiring direct touch, so the elision-regression fix from
  //    0.7.20 stays intact.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-properties-quoted-value-"));
  const file = path.join(root, "en.properties");
  fs.writeFileSync(
    file,
    "invalid=The value ''{0}'' is not valid.\n" +
      "block=Use '{' to open a block in {0}\n" +
      "named=Write '{name}' to insert {0}\n",
  );
  const doc = readLocaleDoc(file, "en", true);
  assert.equal(
    JSON.stringify(doc.data),
    JSON.stringify({
      invalid: "The value '{0}' is not valid.",
      block: "Use '{' to open a block in {0}",
      named: "Write '{name}' to insert {0}",
    }),
  );

  const out = doc.serialize(
    {
      invalid: "La valeur '{0}' n'est pas valide.",
      block: "Utilisez '{' pour ouvrir un bloc dans {0}",
      named: "Écrivez '{name}' pour insérer {0}",
    },
    "fr",
  );
  assert.equal(
    out,
    "invalid=La valeur ''{0}'' n''est pas valide.\n" +
      "block=Utilisez '{' pour ouvrir un bloc dans {0}\n" +
      "named=Écrivez '{name}' pour insérer {0}\n",
  );

  // A value with no OTHER apostrophe to balance against (the German case) must still
  // get the quoted-value idiom's quotes doubled, not left single.
  const outDe = doc.serialize({ invalid: "Der Wert '{0}' ist nicht gültig.", block: "x {0}", named: "y {0}" }, "de");
  assert.match(outDe, /^invalid=Der Wert ''\{0\}'' ist nicht gültig\.\n/);

  fs.writeFileSync(path.join(root, "fr.properties"), out);
  const reread = readLocaleDoc(path.join(root, "fr.properties"), "fr", true);
  assert.equal((reread.data as Record<string, string>).invalid, "La valeur '{0}' n'est pas valide.");
  assert.equal((reread.data as Record<string, string>).block, "Utilisez '{' pour ouvrir un bloc dans {0}");
  assert.equal((reread.data as Record<string, string>).named, "Écrivez '{name}' pour insérer {0}");
});

test("Java .properties: adding ''{0}'' to an already-translated message is picked up on the next rerun", () => {
  // This is the normal way the ''{0}''-quoting fix actually gets used: a team edits a
  // message to add the idiom to a key that was already translated under the OLD
  // (plain `{0}`, or single-quoted) wording — so the target file that already exists
  // has no `''{0}''` of its own for a rerun to find. The quoting convention is the
  // SOURCE's call, not a per-target formatting preference (unlike \uXXXX vs raw
  // UTF-8, which legitimately IS the target's own, and must still follow it) — so a
  // rerun has to take it from the source's own quotedArgKeys every time, never from
  // re-scanning the stale existing target text, or an edit like this would never take
  // effect no matter how many times translate runs afterward.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-properties-rerun-quoting-"));
  const enFile = path.join(root, "en.properties");
  const frFile = path.join(root, "fr.properties");
  fs.writeFileSync(frFile, "badname=Le nom {0} est déjà pris.\n");
  fs.writeFileSync(enFile, "badname=The name ''{0}'' is already taken.\n");

  const doc = readLocaleDoc(enFile, "en", true);
  const existingFr = fs.readFileSync(frFile, "utf8");
  const out = doc.serialize({ badname: "Le nom '{0}' est déjà pris." }, "fr", existingFr);
  assert.equal(out, "badname=Le nom ''{0}'' est déjà pris.\n");
});

test("XLIFF 1.2: detection via --input (untagged source), target filename convention, source-language mismatch is rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-xliff-"));
  const file = path.join(root, "messages.xlf");
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
    <file source-language="en" datatype="plaintext" original="ng.template">
        <body>
            <trans-unit id="greeting"><source>Hi</source></trans-unit>
        </body>
    </file>
</xliff>
`,
  );

  const layout = detectLayout(root, "en", file);
  assert.deepEqual(layout, { kind: "xliff", root, file, ext: ".xlf" });
  assert.deepEqual(sourceFiles(layout, "en"), [file]);
  assert.equal(targetFile(layout, "en", "fr", file), path.join(root, "messages.fr.xlf"));
  assert.throws(() => detectLayout(root, "de", file), /source-language "en", not "de"/);

  fs.writeFileSync(path.join(root, "messages.fr.xlf"), fs.readFileSync(file, "utf8"));
  assert.deepEqual(existingTargets(layout, "en"), ["fr"]);
});

test("XLIFF 2.0 is rejected with a clear error instead of silently translating nothing", () => {
  // XLIFF 2.0 restructured <trans-unit>/<source>/<target> into <unit><segment>
  // <source>/<target></segment></unit>, which parseXliffUnits doesn't recognize at
  // all — previously this matched zero units, so translate reported success with 0
  // strings translated and wrote an untouched copy, with no indication anything was
  // wrong.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-xliff2-"));
  const file = path.join(root, "messages.xlf");
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="2.0" xmlns="urn:oasis:names:tc:xliff:document:2.0" srcLang="en">
    <file id="f1">
        <unit id="greeting"><segment><source>Hello</source></segment></unit>
    </file>
</xliff>
`,
  );
  assert.throws(() => readLocaleDoc(file, "en", true), /only XLIFF 1\.2 is supported.*version 2\.x/);
});

test("XLIFF 1.2: inline <x>/<g> markup survives translation like any other protected tag; translate=\"no\" and bpt/ept are left untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-xliff-rw-"));
  const file = path.join(root, "messages.xlf");
  const text = `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
    <file source-language="en" datatype="plaintext" original="ng.template">
        <body>
            <trans-unit id="greeting" datatype="html">
                <source>Hello <x id="INTERPOLATION" equiv-text="{{name}}"/>!</source>
                <context-group purpose="location">
                    <context context-type="sourcefile">src/app.component.html</context>
                    <context context-type="linenumber">12</context>
                </context-group>
                <note priority="1" from="description">A friendly greeting</note>
            </trans-unit>
            <trans-unit id="bold.text" datatype="html">
                <source>This is <g id="1">bold</g> text.</source>
            </trans-unit>
            <trans-unit id="app.id" datatype="html" translate="no">
                <source>com.acme.app</source>
            </trans-unit>
            <trans-unit id="legacy.paired">
                <source><bpt id="1">[</bpt>bracketed<ept id="1">]</ept></source>
            </trans-unit>
        </body>
    </file>
</xliff>
`;
  fs.writeFileSync(file, text);
  const doc = readLocaleDoc(file, "en", true);
  assert.equal(
    JSON.stringify(doc.data),
    JSON.stringify({
      greeting: 'Hello <x id="INTERPOLATION" equiv-text="{{name}}"/>!',
      "bold.text": "This is <g id=\"1\">bold</g> text.",
    }),
  );

  const translated = {
    greeting: 'Bonjour <x id="INTERPOLATION" equiv-text="{{name}}"/> !',
    "bold.text": 'Ceci est <g id="1">gras</g>.',
  };
  const out = doc.serialize(translated, "fr");
  assert.match(out, /<target>Bonjour <x id="INTERPOLATION" equiv-text="\{\{name\}\}"\/> !<\/target>/);
  assert.match(out, /<target>Ceci est <g id="1">gras<\/g>\.<\/target>/);
  assert.match(out, /<note priority="1" from="description">A friendly greeting<\/note>/);
  // <context-group> (and everything else besides <source>/<target>) rides through untouched, in its original position.
  assert.match(out, /<context-group purpose="location">\s*<context context-type="sourcefile">src\/app\.component\.html<\/context>\s*<context context-type="linenumber">12<\/context>\s*<\/context-group>/);
  // translate="no" and the bpt/ept unit are reproduced byte-for-byte, no <target> added.
  assert.match(out, /<trans-unit id="app\.id" datatype="html" translate="no">\s*<source>com\.acme\.app<\/source>\s*<\/trans-unit>/);
  assert.ok(!/<trans-unit id="legacy\.paired">[\s\S]*?<target>/.test(out));
  assert.match(out, /target-language="fr"/);

  // A unit that already has a <target> (e.g. an XLIFF produced by another tool,
  // or a second locale group in the same file): only the <target> element itself
  // is replaced, in place — the context-group isn't duplicated or dropped.
  const withTarget = path.join(root, "with-target.xlf");
  fs.writeFileSync(
    withTarget,
    `<xliff version="1.2"><file source-language="en"><body>
      <trans-unit id="greeting">
        <source>Hi!</source>
        <context-group purpose="location"><context context-type="sourcefile">x.html</context></context-group>
        <target state="translated">Salut (ancien) !</target>
      </trans-unit>
    </body></file></xliff>\n`,
  );
  const doc2 = readLocaleDoc(withTarget, "en", true);
  const out2 = doc2.serialize({ greeting: "Salut !" }, "fr");
  assert.match(out2, /<target>Salut !<\/target>/);
  assert.match(out2, /<context-group purpose="location">/);
  assert.equal([...out2.matchAll(/<target[ >]/g)].length, 1);

  // Unchanged text: the <target> element (attributes included — a CAT tool's own
  // state="translated"/"final") is left completely alone, not replaced with a fresh,
  // attribute-less one, even though this run "translated" (i.e. reproduced) nothing.
  const doc3 = readLocaleDoc(withTarget, "en", true);
  const out3 = doc3.serialize({ greeting: "Salut (ancien) !" }, "fr");
  assert.match(out3, /<target state="translated">Salut \(ancien\) !<\/target>/);
});

test("XLIFF 1.2: text that documents a tag literally (&lt;b&gt;) round-trips as valid, escaped XML, not a raw tag", () => {
  // Source text that merely shows markup as an example ("Use <b> tags...") is escaped
  // in the XML itself (&lt;b&gt;). Unescaping it at read time the same way as genuine
  // inline markup turns it into an indistinguishable raw "<b>" — which the model is
  // then free to carry through verbatim, and which escapeXmlKeepTags, unable to tell
  // it apart from a real tag, would leave unescaped on write, breaking the XML.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-xliff-escaped-tag-"));
  const file = path.join(root, "messages.xlf");
  fs.writeFileSync(
    file,
    `<xliff version="1.2"><file source-language="en"><body>
      <trans-unit id="help"><source>Use &lt;b&gt; tags to bold text.</source></trans-unit>
    </body></file></xliff>\n`,
  );
  const doc = readLocaleDoc(file, "en", true);
  assert.equal((doc.data as { help: string }).help, "Use &lt;b&gt; tags to bold text.");

  const out = doc.serialize({ help: "Utilisez des &lt;b&gt; balises pour mettre le texte en gras." }, "fr");
  assert.match(out, /<target>Utilisez des &lt;b&gt; balises pour mettre le texte en gras\.<\/target>/);
  assert.ok(!out.includes("<b>"), "the escaped tag-looking text must never become a raw, unescaped tag");
});

test("XLIFF 1.2: translate='no' (single quotes) is honored, and a self-closing <target/> is replaced in place rather than duplicated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-xliff-quotes-"));
  const file = path.join(root, "messages.xlf");
  const text = `<xliff version="1.2"><file source-language="en"><body>
      <trans-unit id="hello">
        <source>Hello</source>
        <target/>
      </trans-unit>
      <trans-unit id="app.id" translate='no'>
        <source>com.acme.app</source>
      </trans-unit>
    </body></file></xliff>
`;
  fs.writeFileSync(file, text);
  const doc = readLocaleDoc(file, "en", true);
  assert.equal(JSON.stringify(doc.data), JSON.stringify({ hello: "Hello" }));

  const out = doc.serialize({ hello: "Bonjour" }, "fr");
  assert.equal([...out.matchAll(/<target[ />]/g)].length, 1, "the self-closing <target/> must be replaced, not left alongside a new one");
  assert.match(out, /<target>Bonjour<\/target>/);
  assert.match(out, /<trans-unit id="app\.id" translate='no'>\s*<source>com\.acme\.app<\/source>\s*<\/trans-unit>/);
});

test("JS/TS locale modules: export default/module.exports, comments, nesting, arrays, quote/indent style kept; unsupported syntax fails clearly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-js-"));

  const file = path.join(root, "en.ts");
  fs.writeFileSync(
    file,
    `// Top-level comment, not attached to anything.
export default {
  // Shown on the home page
  greeting: 'Hello, world!',
  nested: {
    cancel: 'Cancel',
  },
  colors: ['red', 'green'],
  count: 3,
};
`,
  );
  const doc = readLocaleDoc(file, "en", true);
  assert.equal(
    JSON.stringify(doc.data),
    JSON.stringify({ greeting: "Hello, world!", nested: { cancel: "Cancel" }, colors: ["red", "green"], count: 3 }),
  );
  const out = doc.serialize({
    greeting: "Bonjour, monde !",
    nested: { cancel: "Annuler" },
    colors: ["rouge", "vert"],
    count: 3,
  });
  assert.equal(
    out,
    `// Top-level comment, not attached to anything.
export default {
  // Shown on the home page
  greeting: 'Bonjour, monde !',
  nested: {
    cancel: 'Annuler',
  },
  colors: [
    'rouge',
    'vert',
  ],
  count: 3,
};
`,
  );

  // CommonJS, and a TS trailing "as const" annotation, both just work.
  const cjs = path.join(root, "cjs.js");
  fs.writeFileSync(cjs, 'module.exports = {\n  greeting: "Hi",\n};\n');
  assert.equal(JSON.stringify(readLocaleDoc(cjs, "en", true).data), '{"greeting":"Hi"}');

  const asConst = path.join(root, "asconst.ts");
  fs.writeFileSync(asConst, 'export default {\n  greeting: "Hi",\n} as const;\n');
  const asConstDoc = readLocaleDoc(asConst, "en", true);
  assert.equal(JSON.stringify(asConstDoc.data), '{"greeting":"Hi"}');
  assert.equal(asConstDoc.serialize({ greeting: "Salut" }), 'export default {\n  greeting: "Salut",\n} as const;\n');

  // A function value, and a separately-declared-then-exported constant, both fail with a clear error rather than silently misparsing.
  const fn = path.join(root, "fn.js");
  fs.writeFileSync(fn, 'export default {\n  plural: (n) => (n === 1 ? "item" : "items"),\n};\n');
  assert.throws(() => readLocaleDoc(fn, "en", true), /Unsupported JS syntax/);

  const indirect = path.join(root, "indirect.ts");
  fs.writeFileSync(indirect, 'const en = {\n  greeting: "Hi",\n};\nexport default en;\n');
  assert.throws(() => readLocaleDoc(indirect, "en", true), /must be a plain object literal/);
});

test("JS/TS locale modules: a same-line trailing comment stays attached to its own key, not the next one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-js-trailing-"));
  const file = path.join(root, "en.js");
  fs.writeFileSync(
    file,
    `export default {
  home: 'Home', // inline note
  greeting: 'Hello',
  /* block form */
  cancel: 'Cancel', /* also inline */
  bye: 'Bye',
};
`,
  );
  const doc = readLocaleDoc(file, "en", true);
  assert.equal(
    JSON.stringify(doc.data),
    JSON.stringify({ home: "Home", greeting: "Hello", cancel: "Cancel", bye: "Bye" }),
  );
  const out = doc.serialize({ home: "Accueil", greeting: "Bonjour", cancel: "Annuler", bye: "Au revoir" });
  assert.equal(
    out,
    `export default {
  home: 'Accueil', // inline note
  greeting: 'Bonjour',
  /* block form */
  cancel: 'Annuler', /* also inline */
  bye: 'Au revoir',
};
`,
  );
});

test(".NET .resx: detection (untagged default, dot-separated culture target), resheaders/comments kept, binary resources never touched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-resx-"));
  const file = path.join(root, "Resources.resx");
  const text = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype">
    <value>text/microsoft-resx</value>
  </resheader>
  <data name="Greeting" xml:space="preserve">
    <value>Hello, {0}!</value>
    <comment>Shown on the home page</comment>
  </data>
  <data name="AppIcon" type="System.Drawing.Bitmap, System.Drawing" mimetype="application/x-microsoft.net.object.bytearray.base64">
    <value>Qk1AAAAAAAAAADYAAAAoAAAA</value>
  </data>
  <data name="Cancel" xml:space="preserve">
    <value>Cancel</value>
  </data>
</root>
`;
  fs.writeFileSync(file, text);

  const layout = detectLayout(root, "en", file);
  assert.deepEqual(layout, { kind: "resx", root, file, ext: ".resx" });
  assert.deepEqual(sourceFiles(layout, "en"), [file]);
  assert.equal(targetFile(layout, "en", "fr", file), path.join(root, "Resources.fr.resx"));

  const doc = readLocaleDoc(file, "en", true);
  assert.equal(JSON.stringify(doc.data), JSON.stringify({ Greeting: "Hello, {0}!", Cancel: "Cancel" }));

  const out = doc.serialize({ Greeting: "Bonjour, {0} !", Cancel: "Annuler" }, "fr");
  assert.equal(
    out,
    `<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype">
    <value>text/microsoft-resx</value>
  </resheader>
  <data name="Greeting" xml:space="preserve">
    <value>Bonjour, {0} !</value>
    <comment>Shown on the home page</comment>
  </data>
  <data name="AppIcon" type="System.Drawing.Bitmap, System.Drawing" mimetype="application/x-microsoft.net.object.bytearray.base64">
    <value>Qk1AAAAAAAAAADYAAAAoAAAA</value>
  </data>
  <data name="Cancel" xml:space="preserve">
    <value>Annuler</value>
  </data>
</root>
`,
  );

  fs.writeFileSync(path.join(root, "Resources.fr.resx"), out);
  assert.deepEqual(existingTargets(layout, "en"), ["fr"]);
});

test("ARB: @key metadata and @@locale are not translatable and are reinserted; @@locale follows the target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-arb-"));
  const file = path.join(root, "en.arb");
  fs.writeFileSync(
    file,
    JSON.stringify(
      { "@@locale": "en", greeting: "Hello, {name}!", "@greeting": { description: "Greeting", placeholders: { name: {} } } },
      null,
      2,
    ),
  );
  const doc = readLocaleDoc(file, "en");
  assert.equal(JSON.stringify(doc.data), '{"greeting":"Hello, {name}!"}');
  const built = { greeting: "Bonjour, {name}!" };
  const out = JSON.parse(doc.serialize(built, "fr"));
  assert.equal(out["@@locale"], "fr");
  assert.equal(out.greeting, "Bonjour, {name}!");
  assert.deepEqual(out["@greeting"], { description: "Greeting", placeholders: { name: {} } });
});

test("ARB: other @@-prefixed file metadata (@@last_modified, @@x-generator, ...) survives a write, not just @@locale", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-arb-meta-"));
  const file = path.join(root, "intl_en.arb");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        "@@locale": "en",
        "@@last_modified": "2024-01-01T00:00:00.000Z",
        "@@x-generator": "Flutter Intl",
        greeting: "Hello",
      },
      null,
      2,
    ),
  );
  const doc = readLocaleDoc(file, "en");
  const out = JSON.parse(doc.serialize({ greeting: "Bonjour" }, "fr"));
  assert.equal(out["@@locale"], "fr", "the only @@ key that's locale-specific follows the target");
  assert.equal(out["@@last_modified"], "2024-01-01T00:00:00.000Z", "file-level metadata isn't locale-specific: copied verbatim");
  assert.equal(out["@@x-generator"], "Flutter Intl");
  assert.equal(out.greeting, "Bonjour");
});

test("gettext .po: msgid is the stable key; plural entries are translated and expanded to the target's plural count", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-po-"));
  const file = path.join(root, "en.po");
  fs.writeFileSync(
    file,
    [
      'msgid ""',
      'msgstr "Language: \\n"',
      "",
      "#: src/app.js:10",
      'msgid "greeting"',
      'msgstr "Hello!"',
      "",
      'msgid "items"',
      'msgid_plural "items_plural"',
      'msgstr[0] "one item"',
      'msgstr[1] "many items"',
      "",
    ].join("\n"),
  );
  const doc = readLocaleDoc(file, "en");
  assert.equal(
    JSON.stringify(doc.data),
    '{"\\u0004greeting":"Hello!","\\u0004items\\u0005one":"one item","\\u0004items\\u0005other":"many items"}',
  );
  const built = {
    "\u0004greeting": "Bonjour!",
    "\u0004items\u0005one": "un article",
    "\u0004items\u0005other": "plusieurs articles",
  };
  const text = doc.serialize(built, "fr");
  assert.match(text, /msgstr "Language: fr\\n"/);
  assert.match(text, /#: src\/app\.js:10\nmsgid "greeting"\nmsgstr "Bonjour!"/);
  // French (nplurals=2): index 0 from the singular-sourced translation, index 1 from the plural-sourced one.
  assert.match(text, /msgid_plural "items_plural"\nmsgstr\[0\] "un article"\nmsgstr\[1\] "plusieurs articles"/);

  // Arabic (nplurals=6): index 0 is the "zero" category, not the singular — real
  // gettext/ngettext picks index 1 for n==1, so the singular-sourced translation
  // goes there, and every OTHER index (0, 2-5) gets the plural-sourced one.
  const arBuilt = { "\u0004items\u0005one": "عنصر واحد", "\u0004items\u0005other": "عناصر" };
  const arText = doc.serialize(arBuilt, "ar");
  assert.match(arText, /msgstr\[1\] "عنصر واحد"/);
  for (const i of [0, 2, 3, 4, 5]) assert.match(arText, new RegExp(`msgstr\\[${i}\\] "عناصر"`));

  // A target with no translation yet falls back to the English msgid/msgid_plural, not empty strings.
  const untouched = doc.serialize({}, "es");
  assert.match(untouched, /msgstr\[0\] "items"\nmsgstr\[1\] "items_plural"/);
});

test("gettext .po: Arabic's singular form lands in msgstr[1] (its own \"one\" slot), not msgstr[0] (\"zero\")", () => {
  // Real gettext: Arabic's Plural-Forms resolves n==0 to index 0 ("zero") and n==1 to
  // index 1 ("one") — unlike every other language this project hardcodes, where n==1
  // is always index 0. Verified against real msgfmt/ngettext, not just this test.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-po-ar-plural-"));
  const file = path.join(root, "en.po");
  fs.writeFileSync(
    file,
    [
      'msgid ""',
      'msgstr ""',
      '"Content-Type: text/plain; charset=UTF-8\\n"',
      '"Language: en\\n"',
      '"Plural-Forms: nplurals=2; plural=(n != 1);\\n"',
      "",
      'msgid "file_one"',
      'msgid_plural "file_other"',
      'msgstr[0] "You have %d file"',
      'msgstr[1] "You have %d files"',
      "",
    ].join("\n"),
  );
  const doc = readLocaleDoc(file, "en", true, true);
  const built = { "\u0004file_one\u0005one": "ملف واحد %d", "\u0004file_one\u0005other": "%d ملفات" };
  const out = doc.serialize(built, "ar");
  assert.match(out, /msgstr\[0\] "%d ملفات"/, "index 0 (\"zero\") gets the plural-sourced form");
  assert.match(out, /msgstr\[1\] "ملف واحد %d"/, "index 1 (\"one\") gets the singular-sourced form");
  for (const i of [2, 3, 4, 5]) assert.match(out, new RegExp(`msgstr\\[${i}\\] "%d ملفات"`));

  // Reading that same Arabic file back as an existing target recovers the right
  // singular text from its own "one" slot (index 1), not index 0.
  const arFile = path.join(root, "ar.po");
  fs.writeFileSync(arFile, out);
  const target = readLocaleDoc(arFile, "ar", false);
  assert.equal(JSON.stringify(target.data), JSON.stringify({ "\u0004file_one\u0005one": "ملف واحد %d", "\u0004file_one\u0005other": "%d ملفات" }));

  // A translator reviews and clears the fuzzy flag; a rerun with nothing else
  // changed must not re-add it. Before this fix, forms[0] held the "zero" text,
  // which never equals the "one" value, so a changed check against index 0 saw
  // Arabic entries as changed on every single run and kept re-flagging them fuzzy
  // even after a translator had cleared it.
  const reviewed = out.replace("#, fuzzy\n", "");
  const rerun = doc.serialize(built, "ar", reviewed);
  assert.ok(!rerun.includes("#, fuzzy"), "the cleared fuzzy flag must not come back when nothing changed");
});

test("gettext .po: a template source (empty msgstr) falls back to msgid, never for a target file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-po-template-"));
  const file = path.join(root, "en.pot");
  fs.writeFileSync(
    file,
    ['msgid ""', 'msgstr ""', "", 'msgid "greeting"', 'msgstr ""', "", 'msgid "items"', 'msgid_plural "items_plural"', 'msgstr[0] ""', 'msgstr[1] ""', ""].join("\n"),
  );
  const asSource = readLocaleDoc(file, "en", true);
  assert.equal(
    JSON.stringify(asSource.data),
    '{"\\u0004greeting":"greeting","\\u0004items\\u0005one":"items","\\u0004items\\u0005other":"items_plural"}',
  );
  // The same empty msgstr read as an existing TARGET means "not translated yet", not "translate the key".
  const asTarget = readLocaleDoc(file, "fr", false);
  assert.equal(JSON.stringify(asTarget.data), '{"\\u0004greeting":"","\\u0004items\\u0005one":"","\\u0004items\\u0005other":""}');
});

test("gettext .po: a .pot source writes a .po target, never a .pot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-pot-target-"));
  fs.mkdirSync(path.join(root, "en"), { recursive: true });
  fs.writeFileSync(path.join(root, "en/app.pot"), "");
  const dirLayout = detectLayout(root, "en");
  assert.equal(targetFile(dirLayout, "en", "fr", path.join(root, "en/app.pot")), path.join(root, "fr/app.po"));

  const fileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lai-pot-target-file-"));
  fs.writeFileSync(path.join(fileRoot, "en.pot"), "");
  const fileLayout = detectLayout(fileRoot, "en");
  assert.equal(targetFile(fileLayout, "en", "fr", path.join(fileRoot, "en.pot")), path.join(fileRoot, "fr.po"));
});

test("gettext .po: a translator's comments and #, fuzzy flag on the target survive a rerun; --fuzzy flags what changed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-po-fuzzy-"));
  const file = path.join(root, "en.po");
  fs.writeFileSync(file, ['msgid ""', 'msgstr ""', "", "#: src/app.js:10", 'msgid "greeting"', 'msgstr "Hello!"', ""].join("\n"));
  const doc = readLocaleDoc(file, "en", true);

  // A translator hand-added a note and a fuzzy flag directly on the target file.
  const existing = ['msgid ""', 'msgstr "Language: fr\\n"', "", "#. needs a friendlier tone", "#, fuzzy", 'msgid "greeting"', 'msgstr "Salut!"', ""].join("\n");
  const rerun = doc.serialize({ "\u0004greeting": "Salut!" }, "fr", existing);
  assert.match(rerun, /#\. needs a friendlier tone\n#, fuzzy\nmsgid "greeting"/);

  // --fuzzy flags an entry this run actually changed, merging onto the translator's comment rather than duplicating the flag.
  const docFuzzy = readLocaleDoc(file, "en", true, true);
  const existingPlain = ['msgid ""', 'msgstr "Language: fr\\n"', "", "#. needs a friendlier tone", 'msgid "greeting"', 'msgstr "Salut!"', ""].join("\n");
  const changed = docFuzzy.serialize({ "\u0004greeting": "Bonjour!" }, "fr", existingPlain);
  // "#, fuzzy" is its own flag line, never appended to an unrelated "#." translator-note line.
  assert.match(changed, /#\. needs a friendlier tone\n#, fuzzy\nmsgid "greeting"\nmsgstr "Bonjour!"/);
  // Unchanged from the existing target: not flagged.
  const unchanged = docFuzzy.serialize({ "\u0004greeting": "Salut!" }, "fr", existingPlain);
  assert.doesNotMatch(unchanged, /fuzzy/);
});

test("gettext .po: Plural-Forms is computed per target language, and a hand-fixed existing header survives a rerun", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-po-header-"));
  const file = path.join(root, "en.po");
  fs.writeFileSync(
    file,
    ['msgid ""', 'msgstr "Language: \\nPlural-Forms: nplurals=2; plural=(n != 1);\\n"', "", 'msgid "greeting"', 'msgstr "Hello!"', ""].join(
      "\n",
    ),
  );
  const doc = readLocaleDoc(file, "en");
  const built = { "\u0004greeting": "مرحبا!" };

  // Brand-new target file: Plural-Forms is computed for Arabic (6 categories), not copied from English (2).
  const fresh = doc.serialize(built, "ar");
  assert.match(fresh, /Language: ar/);
  assert.match(fresh, /Plural-Forms: nplurals=6;/);

  // An existing target file whose header a translator hand-fixed (e.g. a corrected
  // Plural-Forms) keeps that header verbatim on a rerun, instead of it reverting.
  const handFixed = ['msgid ""', 'msgstr "Language: ar\\nPlural-Forms: nplurals=6; plural=(n==0 ? 0 : 5);\\nLast-Translator: Alex\\n"', "", 'msgid "greeting"', 'msgstr "مرحبا!"', ""].join(
    "\n",
  );
  const rerun = doc.serialize(built, "ar", handFixed);
  assert.match(rerun, /Last-Translator: Alex/);
  assert.match(rerun, /Plural-Forms: nplurals=6; plural=\(n==0 \? 0 : 5\);/);
});

test("gettext .po: pt-BR gets its own Plural-Forms, distinct from pt, and Croatian gets the Slavic rule", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-po-plural-forms-"));
  const file = path.join(root, "en.po");
  fs.writeFileSync(
    file,
    ['msgid ""', 'msgstr "Language: \\nPlural-Forms: nplurals=2; plural=(n != 1);\\n"', "", 'msgid "greeting"', 'msgstr "Hello!"', ""].join(
      "\n",
    ),
  );
  const doc = readLocaleDoc(file, "en");
  const built = { "\u0004greeting": "Olá!" };

  // European Portuguese: 0 is also singular ("n != 1").
  assert.match(doc.serialize(built, "pt"), /Plural-Forms: nplurals=2; plural=\(n != 1\);/);
  // Brazilian Portuguese: only exactly 1 is singular ("n > 1") — a distinct formula, not
  // the generic category-count fallback silently reusing "pt"'s own rule.
  assert.match(doc.serialize(built, "pt-BR"), /Plural-Forms: nplurals=2; plural=\(n > 1\);/);
  // Croatian: the "ends in 1, not 11" Slavic rule, not the generic one-bucket-per-literal-n
  // fallback (which would wrongly bucket 21 as "other" instead of "one").
  assert.match(
    doc.serialize(built, "hr"),
    /Plural-Forms: nplurals=3; plural=\(n%10==1 && n%100!=11 \? 0 : n%10>=2 && n%10<=4 && \(n%100<12 \|\| n%100>14\) \? 1 : 2\);/,
  );
});

/** A fake model: uppercases words, keeps tokens, optionally drops one. */
function fakeTranslator(fn: (s: string) => string): Translator {
  return { translate: async (texts) => texts.map(fn), dispose: async () => {} };
}

test("engine: sentences, placeholders, caps, punctuation, fallback", async () => {
  const tr = fakeTranslator((s) => {
    if (s.includes("drop")) return s.replace(/\{1\}|_P1_|901/, "");
    return `«${s.replace(/\.$/, "")}».`;
  });
  const { translations, issues } = await translateStrings(
    ["Hello {name}. Bye.", "SAVE", "Settings", "{{count}}", "keep __P0__ drop {a} {b}", "{n, plural, one {# day} other {# days}}"],
    [tr],
    { sourceLang: "en", targetLang: "fr", batchSize: 2 },
  );
  // Translated as one whole string (not two separate sentence calls), since the fake
  // translator's output still segments into exactly two sentences — nothing looks
  // dropped, so the engine prefers it over the per-sentence path (see below for what
  // happens when it doesn't).
  assert.equal(translations.get("Hello {name}. Bye."), "«Hello {name}. Bye».");
  assert.equal(translations.get("SAVE"), "«SAVE»");
  assert.equal(translations.get("Settings"), "«Settings»", "no trailing period added to labels");
  assert.equal(translations.get("{{count}}"), "{{count}}", "placeholder-only strings are copied");
  assert.equal(translations.get("{n, plural, one {# day} other {# days}}"), "{n, plural, one {«# day»} other {«# days»}}");
  assert.ok(issues.some((i) => i.kind === "placeholder-fallback"));
  const fb = translations.get("keep __P0__ drop {a} {b}")!;
  assert.ok(fb.includes("{a}") && fb.includes("{b}"), fb);
});

test("engine: a multi-sentence string is translated whole, keeping its own separator (newline) between the translated sentences", async () => {
  const tr = fakeTranslator((s) => s.toUpperCase());
  const { translations } = await translateStrings(["First sentence.\nSecond sentence."], [tr], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 2,
  });
  assert.equal(translations.get("First sentence.\nSecond sentence."), "FIRST SENTENCE.\nSECOND SENTENCE.");
});

test("engine: a whole-string translation that drops a sentence falls back to translating each sentence on its own", async () => {
  const tr = fakeTranslator((s) => {
    const sentences = s.split(". ");
    // Simulates OPUS-MT silently dropping every sentence but the first when given the
    // whole, joined multi-sentence input (see segment.ts) — a single sentence sent on
    // its own still translates correctly.
    return sentences.length > 1 ? sentences[0] + "." : s.toUpperCase();
  });
  const { translations } = await translateStrings(["Alpha one. Beta two."], [tr], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 2,
  });
  assert.equal(translations.get("Alpha one. Beta two."), "ALPHA ONE. BETA TWO.");
});

test("glossary: built-in UI terms, project overrides, casing and punctuation", async () => {
  const { glossaryLookup, protectRegex } = await import("../src/glossary.ts");
  const en = parseLocale("en");
  const fr = glossaryLookup(en, parseLocale("fr"), { glossary: { fr: { Home: "Page d'accueil" } } });
  assert.equal(fr("Sign in"), "Se connecter");
  assert.equal(fr("SIGN IN"), "SE CONNECTER");
  assert.equal(fr("Loading…"), "Chargement…");
  assert.equal(fr("Password:"), "Mot de passe :", "a non-breaking space, not a plain one, before the French colon");
  assert.equal(fr("Home"), "Page d'accueil", "project glossary wins");
  assert.equal(fr("Sign in to continue"), undefined, "whole strings only");
  assert.equal(glossaryLookup(en, parseLocale("pt-PT"), {})("Save"), undefined, "pt-BR terms not used for pt-PT");
  assert.equal(glossaryLookup(parseLocale("de"), parseLocale("fr"), {})("Save"), undefined, "English sources only");
  const re = protectRegex({ doNotTranslate: ["Acme", "Acme Pro"] })!;
  assert.deepEqual(mask("Upgrade to Acme Pro today", "natural", re).tokens, ["Acme Pro"]);
  assert.deepEqual(mask("Acmeville is not Acme", "natural", re).tokens, ["Acme"]);
});

test("loadConfig: walks up to find locale-ai.config.json like eslint/prettier, but stops at .git", async () => {
  const { loadConfig } = await import("../src/glossary.ts");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-cfg-"));
  fs.writeFileSync(path.join(root, "locale-ai.config.json"), JSON.stringify({ doNotTranslate: ["Acme"] }));
  const sub = path.join(root, "a/b/c");
  fs.mkdirSync(sub, { recursive: true });
  const found = loadConfig(sub);
  assert.equal(found.configFile, path.join(root, "locale-ai.config.json"));
  assert.deepEqual(found.doNotTranslate, ["Acme"]);

  // A config sitting above an unrelated project's own .git root is never picked up.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "lai-cfg-outer-"));
  fs.writeFileSync(path.join(outer, "locale-ai.config.json"), JSON.stringify({ doNotTranslate: ["ShouldNotBeFound"] }));
  const inner = path.join(outer, "project");
  fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
  const subInner = path.join(inner, "src/locales");
  fs.mkdirSync(subInner, { recursive: true });
  assert.deepEqual(loadConfig(subInner), { dir: subInner });
});

test("loadConfig: --config <file> resolves only against cwd, never walks up, and throws when missing", async () => {
  const { loadConfig } = await import("../src/glossary.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-cfg-explicit-"));
  assert.throws(() => loadConfig(dir, "missing.json"), /Config file not found/);
});

test("engine: count stays before the noun, tag spacing restored", async () => {
  const tr = fakeTranslator((s) => (s === "{0} file" ? "Fichier {0}" : s.replace("<0>", "<0> ")));
  const { translations } = await translateStrings(["{n} file", "Read the <b>terms</b>"], [tr], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 4,
  });
  assert.equal(translations.get("{n} file"), "{n} fichier");
  assert.equal(translations.get("Read the <b>terms</b>"), "Read the <b>terms</b>");
});

test("engine: French punctuation spacing uses a non-breaking space, not a plain one", async () => {
  const tr = fakeTranslator((s) => (s === "Continue?" ? "Continuer?" : s));
  const { translations } = await translateStrings(["Continue?"], [tr], { sourceLang: "en", targetLang: "fr", batchSize: 4 });
  assert.equal(translations.get("Continue?"), "Continuer ?");
});

test("numeric markers: restore, reject collisions", async () => {
  const { numericStyleSafe } = await import("../src/placeholders.ts");
  const m = mask("Hi {name}, <b>{count}</b> new", "numeric");
  assert.equal(m.text, "Hi 900, 901 new");
  assert.equal(unmask("Привет, 900, 901 новых", m), "Привет, {name}, <b>{count}</b> новых");
  assert.equal(unmask("Привет, 900 новых", m), undefined);
  assert.equal(numericStyleSafe("Call 911 now"), false);
  assert.equal(numericStyleSafe("Call 1911 or 9000"), true);
});

test("engine: retries a failing style with numeric markers; fallback keeps punctuation", async () => {
  // Drops brace markers (like en-ru does) but keeps numbers.
  const tr = fakeTranslator((s) => s.replace(/\{\d+\}/g, "").replace("Hello", "Привет"));
  const { translations, issues } = await translateStrings(["Hello {{name}}, welcome"], [tr], {
    sourceLang: "en",
    targetLang: "ru",
    batchSize: 4,
  });
  assert.equal(translations.get("Hello {{name}}, welcome"), "Привет {{name}}, welcome");
  assert.equal(issues.length, 0);

  const dropAll = fakeTranslator((s) => s.replace(/\{\d+\}|9\d\d|_P\d+_/g, "").replace("you have", "у вас"));
  const r = await translateStrings(["Hello {{name}}, you have {{n}} messages"], [dropAll], {
    sourceLang: "en",
    targetLang: "ru",
    batchSize: 4,
  });
  assert.equal(r.translations.get("Hello {{name}}, you have {{n}} messages"), "Hello {{name}}, у вас {{n}} messages");
});

test("engine: a suspicious batched output is retried alone, and the clean retry is kept silently", async () => {
  // Simulates batch-dependent quantization noise: translating "Good morning" alongside
  // other strings in one batch hallucinates a repeating garble, but translating it
  // alone (batch of 1) is clean.
  const flaky: Translator = {
    translate: async (texts) => texts.map((s) => (s === "Good morning" && texts.length > 1 ? "non non non non non" : "Bonjour")),
    dispose: async () => {},
  };
  const { translations, issues } = await translateStrings(["Good morning", "Good night"], [flaky], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 4,
  });
  assert.equal(translations.get("Good morning"), "Bonjour");
  assert.equal(issues.length, 0, "the retry succeeded, so nothing is reported");

  // When even the solo retry is still suspicious, the (flawed) output ships and is reported.
  const stuck: Translator = { translate: async (texts) => texts.map(() => "non non non non non"), dispose: async () => {} };
  const r2 = await translateStrings(["Good morning"], [stuck], { sourceLang: "en", targetLang: "fr", batchSize: 4 });
  assert.equal(r2.translations.get("Good morning"), "Non non non non non");
  assert.ok(r2.issues.some((i) => i.kind === "repetition"));
});

test("engine: an inline tag whose content comes back empty is retried alone, and reported if it still comes back empty", async () => {
  // Simulates a real bug: a model sometimes learns a "natural"-style tag pair's own
  // numbered id (<0>...</0>) as a do-not-translate marker like {0}, and drops its
  // content entirely — "Read the <a href=...>terms</a>." -> an empty link — even
  // though the rest of the sentence translates fine. Batch-dependent, like other
  // quantization noise: dropped only when batched with another string.
  const dropsTagContentWhenBatched: Translator = {
    translate: async (texts) =>
      texts.map((s) => {
        if (!s.includes("<0>")) return s;
        const translated = s.replace("Read the", "Lea los");
        return texts.length > 1 ? translated.replace(/<0>.*?<\/0>/, "<0></0>") : translated.replace("terms", "términos");
      }),
    dispose: async () => {},
  };
  const source = 'Read the <a href="/terms">terms</a>.';
  const batched = await translateStrings([source, "Good night"], [dropsTagContentWhenBatched], {
    sourceLang: "en",
    targetLang: "es",
    batchSize: 4,
  });
  assert.equal(batched.translations.get(source), 'Lea los <a href="/terms">términos</a>.');
  assert.equal(batched.issues.length, 0, "the solo retry succeeded, so nothing is reported");

  // When even the solo retry still comes back empty, the (flawed) output ships and is reported.
  const alwaysDropsTagContent: Translator = {
    translate: async (texts) => texts.map((s) => (s.includes("<0>") ? s.replace(/<0>.*?<\/0>/, "<0></0>").replace("Read the", "Lea los") : s)),
    dispose: async () => {},
  };
  const r2 = await translateStrings([source], [alwaysDropsTagContent], { sourceLang: "en", targetLang: "es", batchSize: 4 });
  assert.equal(r2.translations.get(source), 'Lea los <a href="/terms"></a>.');
  assert.ok(r2.issues.some((i) => i.kind === "empty-tag"));
});

test("engine: an i18next _one string is retranslated with a literal 1, fixing the wrong plural noun", async () => {
  // Simulates a measured real bug: given the masked {0} marker, the model infers the
  // target's PLURAL noun form even though the English source is singular; given the
  // real number "1" instead, it gets the grammar right.
  const grammarSensitive: Translator = {
    translate: async (texts) =>
      texts.map((s) => {
        if (s === "You have {0} file") return "Vous avez {0} fichiers";
        if (s === "You have 1 file") return "Vous avez 1 fichier";
        return s;
      }),
    dispose: async () => {},
  };
  const source = "You have {{count}} file";
  const withoutHint = await translateStrings([source], [grammarSensitive], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 4,
  });
  assert.equal(withoutHint.translations.get(source), "Vous avez {{count}} fichiers", "unfixed without the hint");

  const withHint = await translateStrings([source], [grammarSensitive], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 4,
    singularHints: new Set([source]),
  });
  assert.equal(withHint.translations.get(source), "Vous avez {{count}} fichier");
});

test("engine: a non-i18next singular hint (Android <plurals>/.po's %d, not {{count}}) also gets the literal-1 grammar retry", async () => {
  // fixSingularGrammar used to require the string's one masked placeholder to be
  // {{count}} specifically. Android's <plurals> "one" item and .po's msgstr[0] (or
  // msgstr[1] for Arabic) are grammatically singular the same way, but use a printf
  // specifier (%d) instead — pluralOneStrings now surfaces these too (see its own
  // test), so the retry must accept any single placeholder, not just {{count}}.
  const grammarSensitive: Translator = {
    translate: async (texts) =>
      texts.map((s) => {
        if (s === "{0} file") return "{0} fichiers";
        if (s === "1 file") return "1 fichier";
        return s;
      }),
    dispose: async () => {},
  };
  const source = "%d file";
  const withHint = await translateStrings([source], [grammarSensitive], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 4,
    singularHints: new Set([source]),
  });
  assert.equal(withHint.translations.get(source), "%d fichier");
});

test("engine: several _one keys are retranslated in one batched model call, not one call per key", async () => {
  let calls = 0;
  const map: Record<string, string> = {
    "You have {0} file": "Vous avez {0} fichiers",
    "You have 1 file": "Vous avez 1 fichier",
    "You have {0} photo": "Vous avez {0} photos",
    "You have 1 photo": "Vous avez 1 photo",
    "You have {0} video": "Vous avez {0} videos",
    "You have 1 video": "Vous avez 1 video",
  };
  const counting: Translator = {
    translate: async (texts) => {
      calls++;
      return texts.map((s) => map[s] ?? s);
    },
    dispose: async () => {},
  };
  const sources = ["You have {{count}} file", "You have {{count}} photo", "You have {{count}} video"];
  const result = await translateStrings(sources, [counting], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 32,
    singularHints: new Set(sources),
  });
  // One call for the main pass (all 3 strings, masked) + one batched call for all 3 "literal 1" retries —
  // not a separate model call per singular-hint key.
  assert.equal(calls, 2);
  assert.equal(result.translations.get("You have {{count}} file"), "Vous avez {{count}} fichier");
  assert.equal(result.translations.get("You have {{count}} photo"), "Vous avez {{count}} photo");
  assert.equal(result.translations.get("You have {{count}} video"), "Vous avez {{count}} video");
});

test("engine: an ambiguous literal-1 restore (source already has its own unrelated \"1\") is skipped, keeping the safe main-pass output", async () => {
  // The "literal 1" retry comes back with TWO standalone 1s (the pinned count, and the
  // source's own unrelated literal "1", reordered) — restoring the first one found would
  // silently freeze the real count as "1" and corrupt the unrelated "1" into {{count}}.
  const tr: Translator = {
    translate: async (texts) =>
      texts.map((s) => {
        if (s === "{0} of 1 total slots used") return "{0} of 1 total slots used (unfixed)";
        if (s === "1 of 1 total slots used") return "1 total slots used of 1"; // ambiguous
        return s;
      }),
    dispose: async () => {},
  };
  const source = "{{count}} of 1 total slots used";
  const result = await translateStrings([source], [tr], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 4,
    singularHints: new Set([source]),
  });
  assert.equal(result.translations.get(source), "{{count}} of 1 total slots used (unfixed)");
});

test("engine: doNotTranslate is respected by the singular-grammar retry, not just the main pass", async () => {
  // Both the i18next "_one" retry (fixSingularGrammar) and the ICU "one {...}" retry
  // (fixIcuOneUnits) used to build their literal-"1" retranslation input straight from
  // the source string, bypassing `opts.protect` entirely — so even though the MAIN pass
  // correctly masked a doNotTranslate match like "Acme", the retry sent it to the model
  // raw, and the model was then free to respell/recase it (observed for real: "Acme" ->
  // "AKME", and a stray capital on "Сиденье"). The fix makes the retry's eligibility
  // check protect-aware too, so any string containing BOTH the count placeholder/hash
  // AND a protected term is disqualified from this narrow retry rather than leaking it.
  const seenUnmasked: string[] = [];
  const tr: Translator = {
    translate: async (texts) => {
      for (const t of texts) if (t.includes("Acme")) seenUnmasked.push(t);
      return texts.map((s) => `FR:${s}`);
    },
    dispose: async () => {},
  };

  const i18nextSource = "{{count}} Acme seat";
  await translateStrings([i18nextSource], [tr], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 4,
    protect: /Acme/g,
    singularHints: new Set([i18nextSource]),
  });

  const icuSource = "{n, plural, one {# Acme seat} other {# Acme seats}}";
  await translateStrings([icuSource], [tr], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 4,
    protect: /Acme/g,
  });

  assert.deepEqual(seenUnmasked, [], "the model never saw unmasked \"Acme\" in any call, main pass or retry");
});

test("custom models: config entries win over built-ins, prefixes per target", async () => {
  const { customEntries, resolveRoute, CATALOG } = await import("../src/catalog.ts");
  const custom = customEntries(
    [
      { source: "en", target: ["ar", "ary"], path: "models/en-ar", prefix: { ar: ">>ara<<", ary: ">>ary<<" } },
      { id: "my-ko", source: "en", target: "ko", repo: "me/opus-mt-en-ko-onnx" },
    ],
    "/project",
  );
  const catalog = [...custom, ...CATALOG];
  const en = parseLocale("en");
  const ar = resolveRoute(en, parseLocale("ar"), catalog)!;
  assert.equal(ar[0].model.path, path.resolve("/project", "models/en-ar"));
  assert.equal(ar[0].prefix, ">>ara<<");
  assert.equal(resolveRoute(en, parseLocale("ary"), catalog)![0].prefix, ">>ary<<");
  assert.equal(resolveRoute(en, parseLocale("ko"), catalog)![0].model.id, "my-ko");
  assert.equal(resolveRoute(en, parseLocale("ko")), undefined, "not available without config");
  // Pivot through a custom model: ja -> en (built-in) -> ko (custom).
  assert.deepEqual(resolveRoute(parseLocale("ja"), parseLocale("ko"), catalog)!.map((h) => h.model.id), ["ja-en", "my-ko"]);
  assert.throws(() => customEntries([{ source: "en", target: "ko" }], "/"), /exactly one of "repo" or "path"/);

  // A "repo" that would resolve outside the model cache (install() writes there,
  // uninstall() recursively deletes it) is rejected at config load, not at that point.
  for (const bad of ["../../../etc/passwd", "org/..", "org/../../x", "/etc/passwd", "org\\name", "onlyonesegment"]) {
    assert.throws(
      () => customEntries([{ source: "en", target: "fr", repo: bad }], "/project"),
      /must look like "namespace\/name"/,
      `rejects repo "${bad}"`,
    );
  }
});

test("modelDir: refuses to resolve outside the model cache even if an unsafe repo got past config validation", async () => {
  const { modelDir, cacheRoot } = await import("../src/models.ts");
  assert.throws(
    () => modelDir({ id: "evil", repo: "../../../etc", sources: ["en"], targets: ["fr"] } as never),
    /resolves outside the model cache/,
  );
  const safe = modelDir({ id: "ok", repo: "khabouss/opus-mt-tc-big-en-fr-onnx", sources: ["en"], targets: ["fr"] } as never);
  assert.equal(safe, path.join(cacheRoot(), "models/khabouss/opus-mt-tc-big-en-fr-onnx"));
});

test("cleanupStalePartials: removes a .partial-<pid> dir left by a killed process, keeps a live one's", async () => {
  const { cleanupStalePartials } = await import("../src/models.ts");
  const { spawnSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-partials-"));
  const dir = path.join(root, "khabouss", "some-model");
  fs.mkdirSync(dir, { recursive: true });

  // A pid guaranteed to no longer exist: a child process that has already exited.
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  const deadPartial = `${dir}.partial-${dead}`;
  fs.mkdirSync(deadPartial, { recursive: true });
  fs.writeFileSync(path.join(deadPartial, "leftover.bin"), "x");

  // This test process's own pid is, by definition, still alive.
  const livePartial = `${dir}.partial-${process.pid}`;
  fs.mkdirSync(livePartial, { recursive: true });

  // A sibling model's partial dir must never be touched.
  const otherModelPartial = path.join(root, "khabouss", "other-model.partial-999999999");
  fs.mkdirSync(otherModelPartial, { recursive: true });

  cleanupStalePartials(dir);

  assert.equal(fs.existsSync(deadPartial), false, "the killed process's leftover dir is removed");
  assert.equal(fs.existsSync(livePartial), true, "a concurrent, still-running install's temp dir is left alone");
  assert.equal(fs.existsSync(otherModelPartial), true, "a different model's partial dir is never touched");
});

test("download: a full disk during a write rejects with ENOSPC instead of hanging forever or exiting silently", async () => {
  // A write-stream that has already errored (e.g. ENOSPC) never emits 'drain' again,
  // so code that awaits only 'drain' after a backpressured write hangs on that promise
  // forever — and with nothing else keeping the event loop alive, Node then exits the
  // whole process on its own, silently, with no thrown error and exit code 0. A fake
  // write stream reproduces the exact race (write() returns false, only 'error' ever
  // fires, 'drain' never does) without depending on a real full disk or /dev/full,
  // which isn't writable/available the same way on every CI runner.
  const origFetch = global.fetch;
  const origCreateWriteStream = fs.createWriteStream;
  global.fetch = (async () => ({
    ok: true,
    body: (async function* () {
      for (let i = 0; i < 5; i++) yield new Uint8Array(1 << 20); // 5 x 1MB chunks
    })(),
  })) as typeof fetch;
  (fs as unknown as { createWriteStream: typeof fs.createWriteStream }).createWriteStream = ((): fs.WriteStream => {
    const ee = new EventEmitter();
    let first = true;
    const stream = ee as unknown as fs.WriteStream;
    stream.write = (() => {
      if (!first) return true;
      first = false;
      queueMicrotask(() => ee.emit("error", Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })));
      return false; // backpressure: the caller must wait for 'drain' (never comes) or 'error'
    }) as typeof stream.write;
    stream.end = ((cb?: () => void) => cb?.()) as typeof stream.end;
    return stream;
  }) as typeof fs.createWriteStream;
  try {
    const mod = await import(`../src/models.ts?t=${Date.now()}-${Math.random()}`);
    const file = { path: "x.bin", size: 5 * (1 << 20), gitSha1: "deadbeef" };
    await assert.rejects(mod.download("http://example.invalid/x.bin", "/tmp/lai-download-test/x.bin", file, () => {}), /ENOSPC|no space/i);
  } finally {
    global.fetch = origFetch;
    fs.createWriteStream = origCreateWriteStream;
  }
});

test("HF_TOKEN is never sent to a spoofed HF_ENDPOINT host, only to the real huggingface.co", async () => {
  // A substring check like `HF.includes("huggingface.co")` passes for both
  // "https://huggingface.co.attacker.example" (a subdomain of attacker.example) and
  // "https://attacker.example/huggingface.co" (the text appears, but only in the
  // path) — either would leak HF_TOKEN to a third party. The fix compares the parsed
  // hostname exactly instead.
  const origFetch = global.fetch;
  const origEndpoint = process.env.HF_ENDPOINT;
  const origToken = process.env.HF_TOKEN;
  let capturedHeaders: Record<string, string> | undefined;
  global.fetch = (async (_url: string, opts: { headers: Record<string, string> }) => {
    capturedHeaders = opts.headers;
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
  try {
    process.env.HF_TOKEN = "secret123";
    for (const endpoint of ["https://huggingface.co.attacker.example", "https://attacker.example/huggingface.co"]) {
      process.env.HF_ENDPOINT = endpoint;
      const mod = await import(`../src/models.ts?t=${Date.now()}-${Math.random()}`);
      capturedHeaders = undefined;
      await assert.rejects(mod.planInstall({ id: "x", repo: "attacker/repo" } as never));
      assert.equal(capturedHeaders?.authorization, undefined, `leaked token to spoofed endpoint ${endpoint}`);
    }

    delete process.env.HF_ENDPOINT;
    const real = await import(`../src/models.ts?t=${Date.now()}-${Math.random()}`);
    capturedHeaders = undefined;
    await assert.rejects(real.planInstall({ id: "x", repo: "real/repo" } as never));
    assert.equal(capturedHeaders?.authorization, "Bearer secret123", "the real huggingface.co should still get the token");
  } finally {
    global.fetch = origFetch;
    if (origEndpoint === undefined) delete process.env.HF_ENDPOINT;
    else process.env.HF_ENDPOINT = origEndpoint;
    if (origToken === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = origToken;
  }
});

test("SentencePiece encoder matches the reference segmentation (if a model is cached)", async (t) => {
  const { SentencePiece } = await import("../src/spm.ts");
  const { cacheRoot } = await import("../src/models.ts");
  const spm = path.join(cacheRoot(), "models/Xenova/opus-mt-en-fr/source.spm");
  if (!fs.existsSync(spm)) return t.skip("en-fr model not installed");
  const sp = new SentencePiece(fs.readFileSync(spm));
  // Expected values produced by Python sentencepiece 0.2.
  assert.deepEqual(sp.encode("This action cannot be undone."), ["▁This", "▁action", "▁cannot", "▁be", "▁und", "one", "."]);
  assert.deepEqual(sp.encode("Zero​width"), ["▁Zero", "▁width"]);
  assert.deepEqual(sp.encode("  Hello   world\t\tagain  "), sp.encode("Hello world again"));
  assert.deepEqual(sp.encode(""), []);
});

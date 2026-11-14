import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CATALOG, reachableTargets, resolveRoute } from "../src/catalog.ts";
import { translateStrings } from "../src/engine.ts";
import { extractIcu } from "../src/icu.ts";
import { extractPipePlural } from "../src/vue-plural.ts";
import { parseLocale } from "../src/lang.ts";
import { editedPaths, hashOf, isEdited, isSourceStale, loadLock, pruneDeletedKeys, recordEntries, saveLock } from "../src/lock.ts";
import {
  addNestedPluralForms,
  addPluralForms,
  buildTarget,
  detectLayout,
  existingTargets,
  flattenStrings,
  keyPathProtect,
  pendingStrings,
  pluralOneStrings,
  readLocaleDoc,
  sourceFiles,
  targetFile,
  usesI18nextPlurals,
} from "../src/locales.ts";
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

test("pendingStrings/buildTarget: isStale forces re-translation of a non-empty target", () => {
  const src = { a: "Hello", b: "World" };
  const existing = { a: "Bonjour", b: "Monde" };
  const isStale = (p: string) => p === "a";
  assert.deepEqual(pendingStrings(src, existing, false, undefined, isStale), ["Hello"]);
  const built = buildTarget(src, existing, (s) => `[${s}]`, false, undefined, isStale);
  assert.equal(JSON.stringify(built), JSON.stringify({ a: "[Hello]", b: "Monde" }));
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

  const l = detectLayout(root, "en", "lib/l10n");
  assert.deepEqual(l, { kind: "file", root: path.join(root, "lib/l10n"), ext: ".arb", prefix: "app" });
  assert.deepEqual(existingTargets(l, "en"), ["fr"]);
  assert.equal(targetFile(l, "en", "de", sourceFiles(l, "en")[0]), path.join(root, "lib/l10n/app_de.arb"));

  // Pointing --input directly at the source file itself also resolves it.
  const direct = detectLayout(root, "en", "lib/l10n/app_en.arb");
  assert.deepEqual(direct, { kind: "file", root: path.join(root, "lib/l10n"), ext: ".arb", prefix: "app" });
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

test("flattenStrings: key paths for nested objects and arrays", () => {
  assert.deepEqual(flattenStrings({ a: "x", b: { c: "y" }, d: ["p", "q"] }), [
    { path: "a", value: "x" },
    { path: "b.c", value: "y" },
    { path: "d[0]", value: "p" },
    { path: "d[1]", value: "q" },
  ]);
  assert.deepEqual(flattenStrings("just a string"), [{ path: "(root)", value: "just a string" }]);
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

  // Arabic (nplurals=6): all indices past 0 get the plural-sourced translation.
  const arBuilt = { "\u0004items\u0005one": "عنصر واحد", "\u0004items\u0005other": "عناصر" };
  const arText = doc.serialize(arBuilt, "ar");
  assert.match(arText, /msgstr\[0\] "عنصر واحد"/);
  for (let i = 1; i < 6; i++) assert.match(arText, new RegExp(`msgstr\\[${i}\\] "عناصر"`));

  // A target with no translation yet falls back to the English msgid/msgid_plural, not empty strings.
  const untouched = doc.serialize({}, "es");
  assert.match(untouched, /msgstr\[0\] "items"\nmsgstr\[1\] "items_plural"/);
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

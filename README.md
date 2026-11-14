# locale-ai

[![npm version](https://img.shields.io/npm/v/locale-ai.svg)](https://www.npmjs.com/package/locale-ai)
[![npm downloads](https://img.shields.io/npm/dm/locale-ai.svg)](https://www.npmjs.com/package/locale-ai)
[![CI](https://github.com/khabouss/locale-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/khabouss/locale-ai/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/locale-ai.svg)](LICENSE)
[![node](https://img.shields.io/node/v/locale-ai.svg)](package.json)

Translate your i18n locale files **locally, on CPU, for free**. No API keys, no Python, nothing leaves your machine.

![demo](media/demo.gif)

```bash
npx locale-ai translate --from en --to fr,es,de
```

```
locale-ai 0.7.16
Found 3 en files in locales/en/
Models to download (one time, then cached for every project):
  en-fr         345 MB  khabouss/opus-mt-tc-big-en-fr-onnx
  ...
Download 577 MB? (Y/n)
✓ fr         43 strings translated, 3 files written in 2.7s, 1 plural forms added
✓ es         43 strings translated, 3 files written in 2.5s, 1 plural forms added
✓ de         43 strings translated, 3 files written in 2.1s
```

> **Behind a proxy or in locked-down CI?** `npm install` pulls in `onnxruntime-node`, which tries to download a ~260&nbsp;MB CUDA provider locale-ai never uses (it only ever runs on CPU) — on a network that can't reach `api.nuget.org`, that download failing takes the whole install down with it. Skip it with:
> ```bash
> ONNXRUNTIME_NODE_INSTALL=skip npm install locale-ai
> ```
> That's also the faster way to install even with a good connection — ~45&nbsp;MB and 3 seconds instead of several hundred MB. locale-ai re-checks for (and removes) that CUDA provider on every run too, in case it slipped in anyway.

> **Seeing an `install-scripts` warning?** npm 11.20+ added an approval gate that silently skips `postinstall` scripts not yet on an allowlist — including both locale-ai's own CUDA-trim script above and `onnxruntime-node`'s own postinstall. This is expected and harmless: the CLI re-checks for (and removes) the unused CUDA provider on every run regardless, with or without that `postinstall` having run. Approve both explicitly to silence the warning, if you'd rather:
> ```bash
> npm install-scripts approve locale-ai onnxruntime-node
> ```

## Why locale-ai?

- **No API keys, no cloud bill.** Google/DeepL/OpenAI-based translation tools work well but mean an account, a key, a per-character cost, and your strings leaving your machine. locale-ai runs the model on your own CPU.
- **Built for i18n files, not plain text.** General MT tools translate strings; they don't know that `{count}`, `<0>bold</0>`, or `$t(common.footer.tagline)` must survive untouched. locale-ai is built around i18next/ICU conventions specifically, so placeholders, plurals, and nested references come out intact instead of mangled or dropped.
- **Incremental by default.** Add one new key to `en.json` and only that key gets translated; edit an existing one and the lockfile catches it and re-translates just that key — existing, unrelated translations are left alone, so re-runs are cheap and safe to automate in CI.
- **Honest about quality.** The [Languages](#languages) section tells you which pairs are review-light vs. which need a human pass, instead of presenting every language as equally production-ready.

**When *not* to use it**: if you need professional/legal-grade translation, or languages outside the [supported list](#languages), use a human translator or a larger cloud model instead — locale-ai is built for keeping UI strings in sync across languages during development, with a review pass before shipping.

## What it handles

- **Layouts**: `locales/en/*.json` (nested folders too) → `locales/fr/...`, or `messages/en.json` → `messages/fr.json`. `.json`, `.yaml`, `.yml`, `.po`/`.pot` (gettext), `.arb` (Flutter), `.strings` (Apple), `.properties` (Java) and `.js`/`.mjs`/`.cjs`/`.ts` locale modules are all supported, mixed freely in the same project. Common folders (`locales`, `src/locales`, `public/locales`, `src/i18n`, `messages`, `lang`, `config/locales` (Rails), ...) are found automatically, or pass `--input`. Framework-specific naming is also recognized: `flutter gen-l10n`'s `app_en.arb`/`app_fr.arb` filename prefix, Apple's `en.lproj`/`fr.lproj` directory-suffix convention (`--input en.lproj` or just the project root both work), and Java `ResourceBundle`'s `messages_en.properties`/`messages_fr.properties` filename prefix (region-qualified as `messages_pt_BR.properties`, with an underscore — Java's own convention, not this project's usual BCP-47 hyphen), on both the source and the generated target side.
- **Android**: `res/values/strings.xml` → `res/values-fr/strings.xml` (or `values-pt-rBR` for a region). `<string>`, `<string-array>` and `<plurals>` are all translated; `translatable="false"` strings and `<!-- ... -->` comments are kept as-is. A value that's purely a reference to another resource (`@string/app_name`) is never translated either, regardless of its own `translatable` attribute. Inline markup inside a value — most commonly `<xliff:g id="...">...</xliff:g>` — comes out as real, untouched XML rather than visible escaped text. A value entirely wrapped in a literal `"..."` pair (Android's own convention for preserving leading/trailing whitespace) keeps those quotes, and that whitespace, on write. Resource-qualifier scripts/variants (`values-b+sr+Latn`) aren't supported — only a plain language or language-region qualifier.
- **Apple `.xcstrings`** (Xcode 15+'s String Catalog, replacing `.strings`): every locale lives inside this one file, so point `--input` straight at it (e.g. `--input Localizable.xcstrings`; it isn't auto-detected, since a project can have several). `shouldTranslate: false` entries, and Xcode's per-device variants (`variations.iphone`/`.ipad`) or multi-variable strings (`substitutions`), are left untouched rather than mistranslated — only a single cardinal plural (`variations.plural`) is supported. A key with no explicit source-language text falls back to the key itself, matching Xcode's own convention.
- **XLIFF 1.2** (Qt Linguist, Angular's `ng extract-i18n`, and most CAT tools): also only via `--input <file>.xlf`/`.xliff` — the source file's name carries no locale tag (XLIFF puts it in `source-language` instead), only the `<basename>.fr.xlf` convention the target file is written under. Inline markup inside a `<source>` — Angular's `<x id="INTERPOLATION" .../>`, or a generic `<g id="1">...</g>` — passes through untouched, the same as `<b>…</b>` everywhere else. `translate="no"` units, and the rarer non-nesting `<bpt>`/`<ept>` paired-tag markup, are left completely alone. A `<note>` is kept from the source.
- **.NET `.resx`**: `--input Resources.resx` (the untagged default/neutral resource file) → `Resources.fr.resx` (same `<basename>.<culture>.resx` convention as XLIFF). `<resheader>` boilerplate is left exactly as-is; a non-string resource (an icon, image, or other base64 blob — any `<data>` with a `type`/`mimetype` attribute) is never touched; an optional `<comment>` is kept from the source. There's no locale metadata inside the file itself to cross-check `--from` against, unlike every other XML format here.
- **JS/TS locale modules** (`en.js`, `en.ts`, ...): deliberately narrow — only `export default {...}` / `module.exports = {...}` / `exports.default = {...}` whose value is a plain object literal (strings, numbers, booleans, null, nested objects/arrays; bare or quoted keys; `//`/`/* */` comments; trailing commas) is read, with **no code ever executed**. A function, template-literal interpolation, import, computed key, or a value that's a reference to a separately-declared constant (`const en = {...}; export default en;`) fails with a clear parse error instead of being silently misread. A per-key `//`/`/* */` comment immediately above it is kept; the file's original quote style (`'` vs `"`) and indentation are matched on output; anything outside the exported object (imports, a trailing `as const`/`satisfies ...`) is left completely untouched.
- **Placeholders are never translated or lost**: `{name}`, `{{count}}`, `%s`, `%1$s`, `%(name)s`, `%{name}`, `${name}`, `:attribute`, `$t(key)`, `@:key`, `<b>…</b>`, `<0>…</0>`, `&nbsp;`, URLs, e-mails, and the `©`/`®`/`™` symbols (no config needed, same as the rest of this list — a model can otherwise drop one on a pivoted, two-hop translation).
- **ICU MessageFormat**: `{count, plural, one {# file} other {# files}}`, `select`, nesting. Only the text is translated.
- **i18next plurals**: adds the forms the target language needs (`_few`, `_many` for Arabic, Russian, Polish...), so the app doesn't fall back to the English string — each added form copies the `_other` translation verbatim rather than inflecting it, so review and adjust the wording of `_zero`/`_two`/`_few`/`_many` by hand for languages where those forms use a different noun/adjective form. The `_one` form is translated with its `{{count}}` temporarily replaced by a literal "1", since the model otherwise sometimes picks the target's plural noun form despite the English source being grammatically singular. Rails-style nested plurals (`item:` with `one:`/`other:` children instead of `item_one`/`item_other`) get the same missing-forms treatment — Android's `<plurals>`/`<item quantity="...">` groups and `.xcstrings`' `variations.plural` are the same shape and get it too.
- **Incremental, and edit-aware**: only missing or changed keys are translated; untouched translations are kept, so re-runs are no-ops. A small `locale-ai.lock.json` — written next to your config file if you have one, otherwise next to the locale files themselves, never wherever you happened to run the command from — remembers a hash of each source string and of the output last written for it, *per target locale* (translating `es` never marks a never-touched `fr` as up to date). Editing a source string gets it re-translated automatically on the next run for every locale (it isn't enough for the target to already hold *some* text); editing a target string by hand is detected and reported for review on every run until resolved, never silently overwritten — and if the source changes too while that hand edit is still pending, it's reported as a **conflict** rather than auto-resolved either way. Run `locale-ai accept [--to <locales>] [key...]` once you've reviewed a hand edit (or several, or all of them) to stop it being reported — it only updates the lock's own record, never the file. `--overwrite` bypasses all of that and re-translates everything, hand edits included. A key removed from the source is dropped from the lock too. The lock file only *tracks* history — `locale-ai check` reads it to fail CI on a translation gone stale, and committing the lock (like a package lock) is what makes that history consistent across machines and CI. It's a flat, one-line-per-key JSON file with short hashes (not a deep, multi-line-per-field tree), so a 5,000-key, 4-locale project stays small and two translators editing different keys touch different lines instead of colliding on every commit.
- **Structure**: key order, numbers, booleans, arrays, indentation and trailing newline are preserved.

**Format notes**: most formats edit an existing target file in place on a rerun, so comments and hand edits to untouched entries survive; Android, ARB, `.xcstrings` and `.resx` regenerate each entry from the source's own structure instead, and XLIFF does a bit of both (only `<target>` is ever replaced). See [docs/formats.md](docs/formats.md) for the specifics, per format — comment handling, escape conventions, and what does and doesn't survive a rerun.

## Commands

```bash
locale-ai translate --to fr,pt-BR [--from en] [--input dir] [--dry-run] [--overwrite] [--fast] [--beams n] [--batch-size n] [--report file] [--fuzzy] [--config file] [-y]
locale-ai check [--from en] [--input dir] [--config file]   # CI: fails if a translated locale has missing keys or placeholder mismatches
                                                              # (also warns, without failing, about strings left identical to the source)
locale-ai accept [--to <locales>] [--from en] [--input dir] [--config file] [key...]
                                             # approve a hand edit as final, so `check`/`translate` stop reporting it (see below)
locale-ai models list [--from en]     # supported language pairs
locale-ai models installed
locale-ai models install en-de        # pre-download (e.g. in CI)
locale-ai models remove en-de
locale-ai models convert <hf-marian-model> --out <dir>   # bring your own model (see below)
```

`translate` uses beam search (4 beams) by default; `--beams n` overrides the width directly. `--fast` uses greedy decoding (equivalent to `--beams 1`): 2–3x faster, about 0.5 chrF lower. `--batch-size n` (default 32) controls how many strings go through the model per batch — lower it if you're hitting memory limits, raise it for a bit more throughput on a machine with room to spare.

Models are cached once per machine in `~/.cache/locale-ai` (`LOCALE_AI_CACHE` to change). In CI, pass `--yes`.

Installing trims the `onnxruntime-node` dependency down to the one CPU binary locale-ai actually loads (it ships binaries for every platform/arch plus GPU providers locale-ai never uses) — but only when nothing else in your `node_modules` also depends on it, so a shared copy another package needs for GPU inference is left alone. Set `LOCALE_AI_SKIP_TRIM=1` to disable this entirely.

## Library API

Everything the CLI does is also a plain async function, for a build script or test that wants to call it in-process instead of shelling out:

```ts
import { translate, check } from "locale-ai";

const result = await translate({ to: ["fr", "es"], yes: true });
console.log(result.locales); // per-locale counts: strings translated, files written, plural forms added

const report = await check(); // same validation as `locale-ai check`, returned as data instead of printed
if (!report.ok) process.exitCode = 1;
```

`translate`/`check` take the same options as their CLI flags (`from`, `to`, `input`, `overwrite`, `config`, ...; `to` accepts a single tag or an array). Unlike the CLI, `translate` never prompts: a download either proceeds (`yes: true`, or a `confirmDownload` hook that resolves to `true`) or the call rejects — pass an `onEvent` hook to observe progress (model downloads, per-locale translation progress, issues) as it happens. See the `TranslateOptions`/`TranslateResult`/`CheckOptions`/`CheckResult` types exported from `locale-ai` for the full shape.

## Project config (optional)

`locale-ai.config.json` in the project root:

```json
{
  "doNotTranslate": ["Acme", "Acme Pro"],
  "doNotTranslateKeys": ["brand.name", "config.statusEnum"],
  "glossary": {
    "fr": { "Workspace": "Espace de travail" },
    "de": { "Sign in": "Einloggen" }
  }
}
```

`glossary` entries replace whole strings. `models` adds your own translation models (next section). A built-in glossary covers ~60 standard UI labels ("Sign in", "Settings", "Log out", ...) for fr, es, de, it, pt-BR, nl and ar, because one-to-three word labels are where sentence-level MT is weakest.

`doNotTranslate` protects a term everywhere it appears in any string. `doNotTranslateKeys` instead protects a key path (dot/`[i]` notation, e.g. `brand.name`, `items[0]`) — the whole value at that path, and everything nested under it if it's an object or array, is copied to every target verbatim. Use it for an enum array (`"statusEnum": ["ACTIVE", "PENDING"]`, which you'd otherwise have to list value-by-value in `doNotTranslate`) or a field a model might respell or inflect even when the word is listed in `doNotTranslate` elsewhere in the same string.

**Known MT weak spots worth glossary-ing up front**: a brand or product name can come back phonetically transliterated into a non-Latin script (`doNotTranslate` fixes this); a short, common word can hit a false-cognate trap sentence-level MT is prone to ("Connexion" → "Connection" instead of "Login"; `glossary` fixes this per target language); and a word that's domain-specific slang in the source language (French "caisse" for "checkout", for example) can come back untranslated, since the model has no signal it's not already the right word — `glossary` fixes this too. None of these are bugs to work around after the fact; they're exactly what `doNotTranslate`/`doNotTranslateKeys`/`glossary` are for, and reviewing short UI strings before shipping (see [Languages](#languages)) catches the rest.

**Pivoted languages (`fr → en → ar`, no direct model) inherit the intermediate language's mistakes independently.** If the `fr → en` hop mistranslates something, every language that pivots through English gets that same mistake — but fixing it in one target (hand-editing the `en` file, or `locale-ai accept`-ing it) has **no effect** on the others; each pivoted locale is retranslated from the source through its own hop chain on every run, so review and fix each pivoted target on its own, not just the intermediate language.

## Add a language, or a better model

Any [MarianMT / OPUS-MT](https://huggingface.co/Helsinki-NLP) model on Hugging Face can be used. Convert it once (needs Python):

```bash
pip install "optimum-onnx[onnxruntime]" accelerate sentencepiece
locale-ai models convert Helsinki-NLP/opus-mt-tc-big-en-tr --out models/en-tr --source en --target tr
```

then declare it in `locale-ai.config.json`:

```json
{
  "models": [
    { "source": "en", "target": "tr", "path": "models/en-tr" },
    { "source": "en", "target": ["ru", "uk"], "path": "models/en-zle", "prefix": { "ru": ">>rus<<", "uk": ">>ukr<<" } },
    { "source": "en", "target": "he", "repo": "your-org/opus-mt-en-he-onnx" }
  ]
}
```

- `path` is a local folder (relative to the config file); `repo` is a Hugging Face repo with the converted files (uploaded output folder), downloaded and cached like built-in models — it must look like `namespace/name`, rejected otherwise (it's joined onto the cache directory with no further checks, so anything else could resolve outside it).
- `prefix` is required for multi-target models (`convert` lists the model's `>>xx<<` tokens).
- Project models take priority over built-ins for their language pairs and can be used for pivoting (e.g. `ja → en → tr`).

**Already built-in, no conversion needed**: `fr`, `es`, `it`, `pt`, `ar` and `tr` all use the larger, clearly-better `opus-mt-tc-big-en-*` checkpoints as their built-in model (~3x larger, 270–370 MB int8, ~1.5x slower than the plain OPUS-MT default); `ru`/`uk` use the tc-big `zle` multi-target checkpoint, and `pl` uses Helsinki-NLP's multi-target Slavic model (no tc-big `en-pl` checkpoint exists). The section above is for adding a language or model that *isn't* already built in.

| Target | Previous (plain OPUS-MT), chrF / BLEU | Built-in today (tc-big / better), chrF / BLEU |
|---|---|---|
| fr | 68.9 / 53.7 | **72.5 / 55.9** |
| es | 72.9 / 56.9 | **73.6 / 57.4** |
| it | 73.8 / 54.9 | **75.3 / 58.2** |
| pt | 68.3 / 44.4 | **70.6 / 47.7** (`>>por<<`, or `>>pob<<` for pt-BR) |
| ru | 65.7 / 46.0 | **68.2 / 48.1** (`>>rus<<`) |
| ar | 47.8 / 16.6 | **49.7 / 19.9** (`>>ara<<`, with `--fast`) |
| tr | — | **67.4 / 42.1** (not supported before) |
| pl | — | **62.6 / 40.3** (`>>pol<<`, not supported before) |

300 Tatoeba test sentences per language, int8, beam 4 unless noted; reproduce with `bench/` (see `bench/README.md`). `opus-mt-tc-big-en-ko` is broken upstream (garbage output even in PyTorch) and is not recommended.

## Languages

From English: af, ar, ca, cs, da, de, es, fi, fr, gl, hi, hu, id, it, nl, oc, pl, pt (pt-BR, pt-PT), ro, ru, sv, tr, uk, vi, xh, zh (zh-CN, zh-TW). Other source languages are supported directly or through English (`locale-ai models list --from fr`).

Measured on a sample app (see `test/fixtures`):

| Quality (built-in models) | Languages |
|---|---|
| Good — light review | fr, es, de, pt-BR, nl |
| Usable — review before shipping | it, ar, ru, pl, zh-CN, zh-TW |
| Untested | the other pairs in `locale-ai models list` |

`fr`, `es`, `it`, `pt`, `ar`, `ru`/`uk`, `tr` and `pl` all ship on the tc-big (or better) models above as built-ins already — no config needed. Not available yet: ja, ko and others; he works with a converted `opus-mt-en-he` (weaker). Moroccan Arabic (Darija): the tc-big en-ar model has a `>>ary<<` token, but its output is close to Modern Standard Arabic — not supported.

## How it works

- **Models**: [OPUS-MT](https://huggingface.co/Helsinki-NLP) (MarianMT) in ONNX, int8-quantized (int8 vs fp32 measured equal: en-fr chrF 68.9 vs 69.0, en-ar 47.8 vs 47.8). Every built-in model — Xenova's OPUS-MT conversions and this project's own `khabouss/*` re-hosted conversions alike — is pinned to the commit captured when it was added (or last updated) and verified on download (sha256 / git blob hash), so neither an upstream change nor a compromised or mistaken upload to either repo ever silently changes your translations. Every model is OPUS-MT by Helsinki-NLP (Tiedemann & Thottingal, 2020 — cite this if you use the models); each is licensed individually (most CC-BY 4.0, some Apache 2.0 — check the model's own card). The larger `tc-big` and multi-target checkpoints are re-hosted as ONNX conversions under [khabouss/*](https://huggingface.co/khabouss), each model card carrying the original's license, crediting and citing it, and listing only the ONNX conversion and quantization as locale-ai's own addition.
- **Own runtime** on [onnxruntime](https://onnxruntime.ai) (`src/marian.ts`), no transformers.js:
  - a SentencePiece Unigram tokenizer including the model's precompiled normalisation map, identical to Python `sentencepiece` on 3,577/3,577 test sentences across 5 models (`src/spm.ts`);
  - real beam search with Hugging Face semantics, identical to `transformers` PyTorch beam search on 599/600 sentences; log-softmax + top-k run natively in a tiny embedded ONNX graph (`scripts/make-topk-graph.py`);
  - KV cache with batch compaction: finished sentences leave the batch, so short and long strings share batches cheaply.
- **Sentence splitting**: OPUS-MT drops sentences from multi-sentence inputs, so each sentence is translated separately.
- **Placeholder masking** with three marker styles tried in order (`{0}` / `<0>…</0>`, then numbers `900`, then `_P0_`), validating every marker; numbers survive models that mangle braces (en-zh, en-ru). A last-resort fallback translates around placeholders, and anything that needed it is listed for review.
- **Speed** (20-core CPU, ~1 GB RAM): sample app (43 strings) in ~3 s per language with beam search, ~2 s with `--fast`; full sentences at ~18/s (built-in, beam 4), ~12/s (tc-big, beam 4), ~33/s (tc-big, `--fast`).
- **Install size**: `onnxruntime-node` bundles binaries for every platform, and on linux/x64 downloads a ~260 MB CUDA provider by default — locale-ai only ever runs on CPU (`executionProviders: ["cpu"]`), so a `postinstall` script ([`scripts/trim-onnxruntime.cjs`](scripts/trim-onnxruntime.cjs)) removes the unused platforms and GPU providers after install, cutting it from ~550 MB to ~45 MB on your current platform.

## Development

```bash
npm install
npm test            # unit tests (no models)
npm run test:e2e    # real models, downloads ~345 MB once (en-fr, tc-big)
node bench/eval.ts --dir <model dir> --lang fr --beams 4 --out out.json   # quality benchmark (see bench/README.md)
npm run dev -- translate --to fr   # run from source (Node ≥ 22.18 strips types)
npm run build       # → dist/
```

## Next steps

1. **More languages**: ja, ko have no usable OPUS-MT model yet; a different model family would be needed.
2. **Rare batch-dependent mistranslation**: translating a short string can occasionally produce an unrelated/garbled result depending on which *other* strings share its translation batch — the same string translates correctly alone or in a different batch. Root cause: the built-in models are dynamically int8-quantized per-tensor, so the quantization scale for a batched activation tensor is computed from the whole batch, not per row; most of the time this is just quantization noise, but occasionally it's enough to tip beam search into a bad output with no warning. A fix would mean re-quantizing the models with static per-channel scales (or giving up CPU-batching speed) — out of scope for a quick patch; flagging here so it's a known, understood limitation rather than a silent one. (This is distinct from, and unaffected by, the placeholder masking described above — `©`/`®`/`™` and the rest of that list never reach the model as text at all, so they're not subject to this noise.)

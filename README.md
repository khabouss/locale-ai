# locale-ai

[![npm version](https://img.shields.io/npm/v/locale-ai.svg)](https://www.npmjs.com/package/locale-ai)
[![npm downloads](https://img.shields.io/npm/dm/locale-ai.svg)](https://www.npmjs.com/package/locale-ai)
[![CI](https://github.com/khabouss/locale-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/khabouss/locale-ai/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/locale-ai.svg)](LICENSE)
[![node](https://img.shields.io/node/v/locale-ai.svg)](package.json)

Translate your i18n locale files **locally, on CPU, for free**. No API keys, no Python, nothing leaves your machine.

![demo](media/demo.gif)

## Quick start

Requires **Node.js 22.18 or newer**.

```bash
npx locale-ai translate --from en --to fr,es,de
```

```
Found 3 en files in locales/en/
Models to download (one time, then cached for every project):
  en-fr         345 MB  khabouss/opus-mt-tc-big-en-fr-onnx
  ...
Download 577 MB? (Y/n)
✓ fr         43 strings translated, 3 files written in 2.7s, 1 plural forms added
✓ es         43 strings translated, 3 files written in 2.5s, 1 plural forms added
✓ de         43 strings translated, 3 files written in 2.1s
```

Placeholders, markup, nested references and plurals come out intact:

<table>
<tr><th><code>locales/en/common.json</code></th><th><code>locales/fr/common.json</code> (real output)</th></tr>
<tr><td>

```json
{
  "cart": {
    "items_one": "{{count}} item in your cart",
    "items_other": "{{count}} items in your cart"
  },
  "welcome": "Welcome back, <0>{{name}}</0>!",
  "terms": "By signing up you agree to $t(legal.terms).",
  "save": "Save changes"
}
```

</td><td>

```json
{
  "cart": {
    "items_one": "{{count}} article dans votre panier",
    "items_many": "{{count}} articles dans votre panier",
    "items_other": "{{count}} articles dans votre panier"
  },
  "welcome": "Bienvenue à toi, <0>{{name}}</0> !",
  "terms": "En vous inscrivant, vous acceptez $t(legal.terms).",
  "save": "Enregistrer les modifications"
}
```

</td></tr>
</table>

French needs an extra `_many` plural form, so it was added. Russian would get `_few` and `_many`.

Run it again and nothing happens. Add or edit a key and only that key is translated.

> Behind a proxy, in locked-down CI, or seeing an `install-scripts` warning? See [Installation notes](#installation-notes).

## Why locale-ai?

- **No API keys, no cloud bill.** Google/DeepL/OpenAI-based tools work well but mean an account, a key, a per-character cost, and your strings leaving your machine. locale-ai runs the model on your own CPU.
- **Built for i18n files, not plain text.** General MT tools don't know that `{count}`, `<0>bold</0>` or `$t(common.footer.tagline)` must survive untouched. locale-ai is built around i18next/ICU conventions, so they come out intact instead of mangled or dropped.
- **Incremental by default.** Only new or changed keys are translated, and hand edits are never overwritten, so re-runs are cheap and safe to automate in CI.
- **Honest about quality.** The [Languages](#languages) section says which pairs need only a light review and which need a human pass.

**When *not* to use it**: for professional or legal-grade translation, or languages outside the [supported list](#languages). locale-ai is for keeping UI strings in sync across languages during development, with a review pass before shipping.

## Contents

- [What it handles](#what-it-handles)
- [Keeping translations in sync](#keeping-translations-in-sync)
- [Use in CI](#use-in-ci)
- [Commands](#commands)
- [Library API](#library-api)
- [Project config](#project-config-optional)
- [Languages](#languages)
- [Add a language, or a better model](#add-a-language-or-a-better-model)
- [How it works](#how-it-works)
- [Installation notes](#installation-notes)
- [Known limitations](#known-limitations)
- [Development](#development)

## What it handles

| Format | Example | Notes |
|---|---|---|
| JSON | `locales/en/*.json`, `messages/en.json` | nested folders too |
| YAML | `config/locales/en.yml` | comments survive reruns; Rails-style nested plurals |
| gettext | `en.po`, `messages.pot` | `msgid_plural`, `Plural-Forms`, optional `#, fuzzy` |
| Flutter ARB | `app_en.arb` | `@key` metadata kept |
| Apple `.strings` | `en.lproj/Localizable.strings` | UTF-16 sources read fine |
| Apple `.xcstrings` | `--input Localizable.xcstrings` | single cardinal plurals |
| Android | `res/values/strings.xml` | `<string>`, `<string-array>`, `<plurals>`, `translatable="false"` |
| Java `.properties` | `messages_en.properties` | `\uXXXX` escapes preserved |
| XLIFF 1.2 | `--input messages.xlf` | Angular, Qt Linguist, CAT tools |
| .NET `.resx` | `--input Resources.resx` | non-string resources untouched |
| JS/TS modules | `en.js`, `en.ts` | plain object literals only, never executed |

Formats can be mixed in one project. Common folders (`locales`, `src/locales`, `public/locales`, `src/i18n`, `messages`, `lang`, `config/locales`, `lib/l10n`, ...) are found automatically, or pass `--input`. Per-format details, including what survives a rerun, are in **[docs/formats.md](docs/formats.md)**.

- **Placeholders are never translated or lost**: `{name}`, `{{count}}`, `%s`, `%1$s`, `%(name)s`, `%{name}`, `${name}`, `:attribute`, `$t(key)`, `@:key`, vue-i18n literals like `{'@'}`, `<b>…</b>`, `<0>…</0>`, `&nbsp;`, URLs, e-mails, and `©`/`®`/`™`/`–`/`—`. No config needed.
- **ICU MessageFormat**: `{count, plural, one {# file} other {# files}}`, `select`, nesting. Only the text is translated.
- **Plurals**: adds the forms the target language needs (`_few`, `_many` for Arabic, Russian, Polish...) so the app doesn't fall back to English. Each added form copies the `_other` translation rather than inflecting it, so review `_zero`/`_two`/`_few`/`_many` by hand where those use a different word form. Works the same for i18next suffixes, Rails nested plurals, Android `<plurals>`, gettext and `.xcstrings`.
- **Structure**: key order, numbers, booleans, arrays, indentation and trailing newline are preserved.

## Keeping translations in sync

Only missing or changed keys are translated. A small `locale-ai.lock.json` remembers what was last written for each key and locale, so locale-ai can tell three things apart:

- **You edited a source string**: it's re-translated on the next run, for every locale.
- **You hand-edited a translation**: it's kept, never overwritten, and reported for review until you approve it with `locale-ai accept`.
- **Both changed**: it's reported as a conflict, not resolved either way.

Commit the lock file, like a package lock. `--overwrite` ignores it and re-translates everything. Full details: **[docs/incremental.md](docs/incremental.md)**.

## Use in CI

`locale-ai check` needs no models. It fails if a locale is missing keys, has mismatched placeholders, or has gone stale since its source changed:

```yaml
# .github/workflows/i18n.yml
name: i18n
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npx locale-ai check
        env:
          ONNXRUNTIME_NODE_INSTALL: skip
```

To translate in CI as well, cache the models between runs and pass `--yes`:

```yaml
      - uses: actions/cache@v4
        with:
          path: ~/.cache/locale-ai
          key: locale-ai-models-${{ hashFiles('locale-ai.config.json') }}
      - run: npx locale-ai translate --to fr,es,de --yes
        env:
          ONNXRUNTIME_NODE_INSTALL: skip
```

## Commands

```bash
locale-ai translate --to fr,pt-BR       # translate missing/changed keys
locale-ai check                         # CI: fail on missing keys, placeholder mismatches, stale translations
locale-ai accept --to fr [key...]       # approve hand edits so they stop being reported
locale-ai models list [--from en]       # supported language pairs
locale-ai models installed              # cached models
locale-ai models install en-de          # pre-download (e.g. in CI)
locale-ai models remove en-de
locale-ai models convert <hf-model> --out <dir>   # bring your own model (see below)
```

`translate` options (`check` and `accept` take `--from`, `--input` and `--config` too):

| Option | Default | |
|---|---|---|
| `--from <locale>` | `en` | Source locale |
| `--to <locales>` | | Target locales, comma separated: `fr,es,pt-BR` |
| `--input <path>` | auto-detected | Locale folder, or a `.xcstrings`/`.xlf`/`.resx` file |
| `--dry-run` | | Show what would be translated, without downloading or writing |
| `--overwrite` | | Re-translate everything, including hand edits |
| `--beams <n>` | `4` | Beam search width |
| `--fast` | | Greedy decoding (`--beams 1`): 2–3x faster, about 0.5 chrF lower |
| `--batch-size <n>` | `32` | Strings per model batch. Lower it if memory is tight |
| `--report <file>` | | Write a JSON report of strings that need review |
| `--fuzzy` | | `.po` only: mark every (re)translated entry `#, fuzzy` |
| `--config <file>` | `./locale-ai.config.json` | Project config |
| `-y`, `--yes` | | Download required models without asking |

Models are cached once per machine in `~/.cache/locale-ai` (set `LOCALE_AI_CACHE` to change it).

## Library API

Everything the CLI does is also a plain async function, for a build script or test:

```ts
import { translate, check } from "locale-ai";

const result = await translate({ to: ["fr", "es"], yes: true });
console.log(result.locales); // per-locale counts: strings translated, files written, plural forms added

const report = await check(); // same validation as `locale-ai check`, returned as data
if (!report.ok) process.exitCode = 1;
```

`translate`/`check` take the same options as their CLI flags (`from`, `to`, `input`, `overwrite`, `config`, ...; `to` accepts a single tag or an array). `translate` never prompts: a download either proceeds (`yes: true`, or a `confirmDownload` hook that resolves to `true`) or the call rejects. Pass an `onEvent` hook to observe progress. See the exported `TranslateOptions`/`TranslateResult`/`CheckOptions`/`CheckResult` types for the full shape.

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

- `doNotTranslate` protects a term everywhere it appears in any string.
- `doNotTranslateKeys` protects a key path (`brand.name`, `items[0]`): the whole value, and everything nested under it, is copied verbatim. Useful for enum arrays like `"statusEnum": ["ACTIVE", "PENDING"]`.
- `glossary` replaces whole strings, per target language. A built-in glossary already covers ~60 standard UI labels ("Sign in", "Settings", "Log out", ...) for fr, es, de, it, pt-BR, nl and ar, because one-to-three word labels are where sentence-level MT is weakest.
- `models` adds your own translation models ([see below](#add-a-language-or-a-better-model)).

**Worth adding up front**: brand names (can come back transliterated into a non-Latin script → `doNotTranslate`), short words with false-cognate traps ("Connexion" → "Connection" instead of "Login" → `glossary`), and domain slang the model leaves untranslated (French "caisse" for "checkout" → `glossary`).

**Pivoted languages** (e.g. `fr → en → ar`, no direct model) inherit mistakes from the intermediate hop. Fixing the `en` file doesn't fix them: each pivoted locale is retranslated from the source through its own hops, so review each one separately.

## Languages

From English: af, ar, ca, cs, da, de, es, fi, fr, gl, hi, hu, id, it, nl, oc, pl, pt (pt-BR, pt-PT), ro, ru, sv, tr, uk, vi, xh, zh (zh-CN, zh-TW). Other source languages are supported directly or through English (`locale-ai models list --from fr`).

| Quality | Languages |
|---|---|
| Good — light review | fr, es, de, pt-BR, nl |
| Usable — review before shipping | it, ar, ru, pl, zh-CN, zh-TW |
| Untested | the other pairs in `locale-ai models list` |

Measured on a sample app (see `test/fixtures`).

Several languages use larger checkpoints than the plain OPUS-MT default — the `opus-mt-tc-big-en-*` models, ~3x larger (270–370 MB int8) and ~1.5x slower, but clearly better:

| Target | Built-in model | chrF / BLEU | Plain OPUS-MT |
|---|---|---|---|
| fr | tc-big en-fr | **72.5 / 55.9** | 68.9 / 53.7 |
| es | tc-big en-es | **73.6 / 57.4** | 72.9 / 56.9 |
| it | tc-big en-it | **75.3 / 58.2** | 73.8 / 54.9 |
| pt | tc-big en-pt (`>>por<<`, `>>pob<<` for pt-BR) | **70.6 / 47.7** | 68.3 / 44.4 |
| ru, uk | tc-big en-zle (`>>rus<<`, `>>ukr<<`) | **68.2 / 48.1** (ru) | 65.7 / 46.0 |
| ar | tc-big en-ar (`--fast`) | **49.7 / 19.9** | 47.8 / 16.6 |
| tr | tc-big en-tr | **67.4 / 42.1** | — |
| pl | en-sla multi-target (`>>pol<<`, no tc-big en-pl exists) | **62.6 / 40.3** | — |

300 Tatoeba test sentences per language, int8, beam 4 unless noted. Reproduce with `bench/` (see [bench/README.md](bench/README.md)).

**Not available yet**: ja, ko and others. `he` works with a converted `opus-mt-en-he` (weaker). `opus-mt-tc-big-en-ko` is broken upstream (garbage output even in PyTorch). Moroccan Arabic (Darija) isn't supported: the en-ar model's `>>ary<<` token produces output close to Modern Standard Arabic.

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

- `path` is a local folder (relative to the config file). `repo` is a Hugging Face repo holding the converted files, downloaded and cached like built-in models; it must look like `namespace/name`.
- `prefix` is required for multi-target models (`convert` lists the model's `>>xx<<` tokens).
- Project models take priority over built-ins for their language pairs, and can be used for pivoting (e.g. `ja → en → tr`).

## How it works

- **Models**: [OPUS-MT](https://huggingface.co/Helsinki-NLP) (MarianMT) in ONNX, int8-quantized (int8 vs fp32 measured equal: en-fr chrF 68.9 vs 69.0, en-ar 47.8 vs 47.8). Every built-in model is pinned to a specific commit and verified on download (sha256 / git blob hash), so an upstream change or a bad upload can't silently change your translations. All models are OPUS-MT by Helsinki-NLP (Tiedemann & Thottingal, 2020 — cite this if you use them), each licensed individually (mostly CC-BY 4.0, some Apache 2.0 — check the model card). The tc-big and multi-target checkpoints are re-hosted as ONNX conversions under [khabouss/*](https://huggingface.co/khabouss), each card carrying the original's license and citation.
- **Own runtime** on [onnxruntime](https://onnxruntime.ai) (`src/marian.ts`), no transformers.js:
  - a SentencePiece Unigram tokenizer, identical to Python `sentencepiece` on 3,577/3,577 test sentences across 5 models (`src/spm.ts`);
  - real beam search with Hugging Face semantics, identical to `transformers` PyTorch on 599/600 sentences; log-softmax + top-k run natively in a tiny embedded ONNX graph (`scripts/make-topk-graph.py`);
  - KV cache with batch compaction: finished sentences leave the batch, so short and long strings share batches cheaply.
- **Sentence splitting**: OPUS-MT drops sentences from multi-sentence inputs, so each sentence is translated separately.
- **Placeholder masking** with three marker styles tried in order (`{0}` / `<0>…</0>`, then numbers `900`, then `_P0_`), validating every marker; numbers survive models that mangle braces (en-zh, en-ru). A last-resort fallback translates around placeholders, and anything that needed it is listed for review.
- **Speed** (20-core CPU, ~1 GB RAM): sample app (43 strings) in ~3 s per language with beam search, ~2 s with `--fast`; full sentences at ~18/s (built-in, beam 4), ~12/s (tc-big, beam 4), ~33/s (tc-big, `--fast`).

## Installation notes

**Behind a proxy or in locked-down CI.** `onnxruntime-node` tries to download a ~260 MB CUDA provider during install. locale-ai never uses it (it only runs on CPU), but on a network that can't reach `api.nuget.org` that failed download breaks the whole install. Skip it:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm install locale-ai
```

This is also the faster install on any network: ~45 MB in about 3 seconds.

**`install-scripts` warning on npm 11.20+.** npm now skips `postinstall` scripts that aren't on an allowlist, including locale-ai's and `onnxruntime-node`'s. This is harmless: locale-ai re-checks for and removes the unused CUDA provider on every run anyway. To silence the warning:

```bash
npm install-scripts approve locale-ai onnxruntime-node
```

**Install size.** `onnxruntime-node` ships binaries for every platform plus GPU providers. A `postinstall` script ([`scripts/trim-onnxruntime.cjs`](scripts/trim-onnxruntime.cjs)) removes everything except the one CPU binary locale-ai loads, cutting it from ~550 MB to ~45 MB. It leaves a shared copy alone if another package in your `node_modules` depends on it. Set `LOCALE_AI_SKIP_TRIM=1` to disable trimming.

## Known limitations

- **No ja/ko yet**: there's no usable OPUS-MT model, so a different model family would be needed.
- **Rare batch-dependent mistranslation**: a short string can occasionally come out garbled depending on which other strings share its batch; the same string translates fine alone. The built-in models are dynamically int8-quantized per tensor, so a batch's quantization scale depends on the whole batch. Fixing it means re-quantizing with static per-channel scales. Placeholders aren't affected, since they never reach the model as text.

## Development

```bash
npm install
npm test            # unit tests (no models)
npm run test:e2e    # real models, downloads ~345 MB once (en-fr, tc-big)
node bench/eval.ts --dir <model dir> --lang fr --beams 4 --out out.json   # quality benchmark (see bench/README.md)
npm run dev -- translate --to fr   # run from source (Node ≥ 22.18 strips types)
npm run build       # → dist/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

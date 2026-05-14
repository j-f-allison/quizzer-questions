# quizzer-questions

Private backend for the [quizzer](https://github.com/j-f-allison/quizzer) app. Serves filtered question sets to the public frontend via an authenticated API.

This repo holds the actual question content. It pairs with the public app via a shared bearer token.

## Architecture

The Worker (`src/worker.js`) authenticates every request against `env.SHARED_TOKEN`. After auth passes:

- `GET /api/sets?code=X` returns matching `{file, name}` entries from the bundled manifest
- `GET /questions/<path>` serves the JSON file from static assets

The manifest (`src/manifest.js`) is generated at deploy time by `build-manifest.py` from the contents of `questions/`. It's bundled into the Worker, never served as a static asset.

## Repo layout

```
.
├── src/
│   ├── worker.js        # auth gate + manifest filter
│   └── manifest.js      # auto-generated, gitignored
├── questions/
│   ├── contracts/       # files here are loadable with code "contracts"
│   │   └── *.json
│   └── ...
├── build-manifest.py    # generates src/manifest.js
├── wrangler.jsonc       # Cloudflare deploy config
├── .assetsignore        # files NOT served as static assets
└── .gitignore
```

## Cloudflare setup

Connect this repo to a separate Cloudflare Workers project (`quizzer-questions`).

**Build settings:**

| Setting | Value |
| --- | --- |
| Build command | `python3 build-manifest.py` |
| Deploy command | `npx wrangler versions upload` (default) |

**Environment secret:** add `SHARED_TOKEN` as a **Secret** (not a plain variable) under Settings → Variables and Secrets. Use the same token in both this project and the public app project.

The deployed Worker lives at `quizzer-questions.<your-subdomain>.workers.dev` by default. You don't need a custom domain — only your public app talks to this backend, and it does so via the URL stored in the app's env vars.

## Generating a shared token

Any random 32+ character string works. One option:

```bash
openssl rand -hex 32
```

Set it as `SHARED_TOKEN` here, and as `QUESTIONS_TOKEN` in the public app's Cloudflare project.

## Adding a new question set

1. Drop a `.json` file into a subdirectory under `questions/`:
   - `questions/contracts/new-set.json` → loadable with code `contracts`
   - `questions/property/foo.json` → loadable with code `property`
2. Commit and push. Cloudflare rebuilds the manifest and redeploys.

The first-level subdirectory becomes the code. Files at the root of `questions/` get no code and won't be loadable via the code lookup.

## JSON format

See the public app's [README](https://github.com/j-f-allison/quizzer/blob/main/README.md#json-format) for the full schema. In brief:

```json
[
  {
    "facts": "Optional fact pattern, with \\n\\n for paragraph breaks.",
    "question": "...",
    "option_a": "...",
    "option_b": "...",
    "option_c": "...",
    "option_d": "...",
    "answer": "B",
    "answer_explanation": "..."
  }
]
```

For multi-code files, use the wrapper format with `_codes`:

```json
{
  "_codes": ["contracts", "ucc"],
  "_name": "UCC Cross-Tagged",
  "questions": [ ... ]
}
```

## Local development

```bash
# regenerate manifest
python3 build-manifest.py

# create a .dev.vars file with your local token (DO NOT commit)
echo 'SHARED_TOKEN=your-test-token-here' > .dev.vars

# run locally
npx wrangler dev
```

Test with curl:

```bash
curl -H "Authorization: Bearer your-test-token-here" \
  'http://localhost:8787/api/sets?code=contracts'
```

Without the auth header you'll get 401.

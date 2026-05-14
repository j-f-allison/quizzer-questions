# quizzer-questions

Backend scaffold for the [quizzer](https://github.com/j-f-allison/quizzer) app. Holds the Worker code, build script, and Cloudflare config for serving question content via an authenticated API.

This repo is intentionally **content-free**. To deploy a working backend, fork it to a private repo, add your own questions, and connect that private fork to Cloudflare.

## Architecture

The Worker (`src/worker.js`) authenticates every request against `env.SHARED_TOKEN`. After auth passes:

- `GET /api/sets?code=X` returns matching `{file, name}` entries from the bundled manifest
- `GET /questions/<path>` serves the JSON file from static assets

The manifest (`src/manifest.js`) is generated at deploy time by `build-manifest.py` from the contents of `questions/`. It's bundled into the Worker, never served as a static asset — so the master list of sets and codes can't be fetched directly.

## Repo layout

```
.
├── src/
│   ├── worker.js        # auth gate + manifest filter
│   └── manifest.js      # auto-generated at deploy time
├── build-manifest.py    # generates src/manifest.js from questions/
├── wrangler.jsonc       # Cloudflare deploy config
├── .assetsignore        # files NOT served as static assets
└── .gitignore
```

No `questions/` directory ships with this repo — you add that in your private fork.

## Deploying your own

The pattern is: keep this scaffold as upstream, fork it to a private repo, add your questions, deploy from the private fork. This keeps your question content private and your deployment URL out of any public Git history.

```bash
# 1. Create a new EMPTY private repo on GitHub (e.g., quizzer-questions-mine)

# 2. Locally:
git clone git@github.com:j-f-allison/quizzer-questions.git quizzer-questions-mine
cd quizzer-questions-mine
git remote remove origin
git remote add origin git@github.com:YOURNAME/quizzer-questions-mine.git
git remote add upstream git@github.com:j-f-allison/quizzer-questions.git
git push -u origin main

# 3. Add your questions
mkdir -p questions/contracts
cp ~/path/to/your-questions/*.json questions/contracts/
git add . && git commit -m "add questions" && git push

# 4. Generate a shared token (save it — you need it on both projects):
openssl rand -hex 32
```

In Cloudflare:
1. Workers & Pages → Create → Connect to Git → pick your private fork
2. Build command: `python3 build-manifest.py`
3. Settings → Variables and Secrets → add `SHARED_TOKEN` (type: Secret) = the token from above

Then deploy a paired [quizzer](https://github.com/j-f-allison/quizzer) app (forked similarly to private), with `QUESTIONS_URL` set to your backend's URL and `QUESTIONS_TOKEN` set to the same token.

## Pulling future updates

When this scaffold gets updates, sync them to your private fork:

```bash
cd ~/quizzer-questions-mine
git fetch upstream
git merge upstream/main
git push
# Cloudflare auto-deploys.
```

First merge may need `--allow-unrelated-histories` if the histories started independently.

## Adding a question set (in your private fork)

1. Drop a `.json` file into a subdirectory under `questions/`:
   - `questions/contracts/new-set.json` → loadable with code `contracts`
   - `questions/property/foo.json` → loadable with code `property`
2. Commit and push. Cloudflare rebuilds the manifest and redeploys.

The first-level subdirectory becomes the code. Files at the root of `questions/` get no code and won't be loadable via the code lookup.

For multi-code files or display name overrides, use the wrapper format:

```json
{
  "_codes": ["contracts", "ucc"],
  "_name": "UCC Cross-Tagged",
  "questions": [ ... ]
}
```

## JSON format

See the [app README](https://github.com/j-f-allison/quizzer#json-format) for the full schema.

## Local development

```bash
# Add a sample question if your local clone has no questions/
mkdir -p questions/sample
cat > questions/sample/test.json <<'EOF'
[{"question":"Test?","option_a":"a","option_b":"b","option_c":"c","option_d":"d","answer":"A","answer_explanation":""}]
EOF

# Regenerate manifest
python3 build-manifest.py

# Create .dev.vars with a test token (DO NOT commit)
echo 'SHARED_TOKEN=local-test-token' > .dev.vars

# Run locally
npx wrangler dev
```

Test with curl:

```bash
curl -H "Authorization: Bearer local-test-token" \
  'http://localhost:8787/api/sets?code=sample'
```

# quizzer-questions

Backend scaffold for the [quizzer](https://github.com/j-f-allison/quizzer-app) app. Holds the Worker code, build script, and Cloudflare config for serving question content via an authenticated API.

This repo is intentionally **content-free**. To deploy a working backend, fork it to a private repo, add your own questions, and connect that private fork to Cloudflare.

## Architecture

The Worker (`src/worker.js`) authenticates every request against `env.SHARED_TOKEN`. After auth passes:

- `GET /api/sets?code=X` returns matching `{file, name}` entries from the bundled manifest
- `GET /questions/<path>` serves the JSON file from static assets
- `POST /api/flag` records a user-submitted question flag to a D1 database (see [Flag reports](#flag-reports) below)

The manifest (`src/manifest.js`) is generated at deploy time by `build-manifest.py` from the contents of `questions/`. It's bundled into the Worker, never served as a static asset — so the master list of sets and codes can't be fetched directly.

## Repo layout

```
.
├── src/
│   ├── worker.js        # auth gate + manifest filter + flag handler
│   └── manifest.js      # auto-generated at deploy time
├── migrations/
│   └── 0001_create_flags.sql  # D1 schema for flag reports
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

## Flag reports

Users can flag questions from the quiz UI. Flags are stored in a Cloudflare D1 (SQLite) database. Each row records the question ID, question text, set name, cursor index, an optional note, and a timestamp.

### Setting up D1 (Cloudflare dashboard — no CLI needed)

1. **Create the database:** Cloudflare dashboard → **Workers & Pages** → **D1** → **Create database**. Name it `quizzer-flags`. Note the **Database ID** shown on the detail page.

2. **Apply the schema:** Still on the D1 detail page, open the **Console** tab. Paste and run the contents of `migrations/0001_create_flags.sql`.

3. **Add the binding to `wrangler.jsonc`** in your private fork:
   ```jsonc
   "d1_databases": [
     {
       "binding": "DB",
       "database_name": "quizzer-flags",
       "database_id": "<your-database-id>"
     }
   ]
   ```

4. **Deploy.** The `POST /api/flag` endpoint is now live.

### Reviewing flags

In the D1 Console (dashboard → D1 → quizzer-flags → Console):

```sql
SELECT * FROM flags ORDER BY submitted_at DESC LIMIT 50;
```

Or filter by set:

```sql
SELECT submitted_at, question_id, note FROM flags WHERE set_name = 'contracts' ORDER BY submitted_at DESC;
```

### Local development with D1

Add a local D1 binding in `.dev.vars` is not supported for D1 — Wrangler creates a local SQLite file automatically when you run `wrangler dev` with a D1 binding in `wrangler.jsonc`. The local database starts empty; apply the migration once with:

```bash
npx wrangler d1 execute quizzer-flags --local --file=migrations/0001_create_flags.sql
```

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

Each question file is either a bare array of question objects, or a wrapper object.

### Question fields

| Field | Required | Description |
|---|---|---|
| `question` | yes | The question text. |
| `option_a` – `option_d` | yes | Answer choices. |
| `answer` | yes | Correct answer: `"A"`, `"B"`, `"C"`, or `"D"`. |
| `id` | recommended | 8-character random alphanumeric string. Generate with `openssl rand -hex 4`. New questions should always include this. |
| `answer_explanation` | no | Explanation shown after answering. |
| `facts` | no | Inline fact pattern shown above the question. Paragraphs separated by `\n\n`. |
| `facts_id` | no | ID of a shared fact pattern defined at the file's top level (see below). Requires wrapper format. |
| `group_id` | no | Human-readable slug shared by questions that must stay together in order when shuffling (e.g., `"offer-hypo-1"`). |
| `group_order` | no | 1-based position within the group. Required when `group_id` is set. |

Minimal example (bare array):

```json
[
  {
    "id": "a3f9b2c1",
    "question": "Under UCC § 2-207, ...",
    "option_a": "...",
    "option_b": "...",
    "option_c": "...",
    "option_d": "...",
    "answer": "B",
    "answer_explanation": "Optional. Empty string if no feedback."
  }
]
```

### Shared fact patterns

When multiple questions share the same fact pattern, define it once at the top level and reference it by ID. This avoids repetition and makes revisions easier. Requires the wrapper format:

```json
{
  "facts": {
    "offer-and-acceptance": "On Monday, Seller sent Buyer a signed written offer...\n\nOn Tuesday, Buyer replied in writing..."
  },
  "questions": [
    {
      "id": "a3f9b2c1",
      "facts_id": "offer-and-acceptance",
      "group_id": "contract-formation-1",
      "group_order": 1,
      "question": "Was a contract formed?",
      "option_a": "...", "option_b": "...", "option_c": "...", "option_d": "...",
      "answer": "B",
      "answer_explanation": "..."
    },
    {
      "id": "b7c1d4e2",
      "facts_id": "offer-and-acceptance",
      "group_id": "contract-formation-1",
      "group_order": 2,
      "question": "What is the buyer's remedy?",
      "option_a": "...", "option_b": "...", "option_c": "...", "option_d": "...",
      "answer": "C",
      "answer_explanation": "..."
    }
  ]
}
```

`facts_id` and `group_id` may share the same slug when the fact pattern defines the group, but they are independent: `facts_id` controls what text is displayed, `group_id` controls shuffle behavior. A group does not require a shared fact pattern, and a shared fact pattern does not require grouping.

For standalone questions with a unique fact pattern, use the inline `facts` field instead.

### Grouped questions

Questions sharing a `group_id` are treated as a single unit when shuffling — they stay together and appear in `group_order` sequence. Use this for multi-part questions or any questions that depend on a specific ordering relative to each other.

### Parser aliases

The runtime parser accepts alternate keys:
- `option_a` / `optionA` / `a`, and so on for B–D
- `question` / `q` / `prompt`
- `answer_explanation` / `explanation` / `rationale`
- `facts` / `fact` / `scenario`
- Top-level container: `[...]`, `{"questions": [...]}`, `{"data": [...]}`, or `{"items": [...]}`
- `answer` accepts `"A"`, `"a"`, `"A."`, `"option_a"`, etc.

### Wrapper format options

For multi-code files, display name overrides, or shared facts, use the wrapper format. Recognized top-level keys:

| Key | Description |
|---|---|
| `_codes` | Array of codes this file appears under |
| `_code` | Single code (alternate to `_codes`) |
| `_name` | Display name override |
| `facts` | Map of fact pattern ID → text (for `facts_id` references) |
| `questions` | The question array |

Codes are normally derived from the backend's subdirectory structure (see the backend's README).


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

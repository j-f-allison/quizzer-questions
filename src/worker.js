// Authenticated questions backend.
//
// Every request goes through this Worker first (see wrangler.jsonc).
// Without a valid Bearer token, no response leaks any content.
//
// Handles:
//   GET /api/sets?code=X       → filtered manifest entries
//   GET /questions/<path>      → serves the JSON file from static assets
//
// The Worker imports the manifest from src/manifest.js (auto-generated
// by build-manifest.py at deploy time). The manifest is bundled into the
// Worker, never exposed as a static asset.

import { manifest } from "./manifest.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

function entryCodes(entry) {
  if (Array.isArray(entry.codes)) return entry.codes;
  if (typeof entry.code === "string") return [entry.code];
  return [];
}

function checkAuth(request, env) {
  if (!env.SHARED_TOKEN) return "backend misconfigured";
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.SHARED_TOKEN}`) return "unauthorized";
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Auth-gate everything this Worker handles.
    const authError = checkAuth(request, env);
    if (authError) {
      const status = authError === "unauthorized" ? 401 : 500;
      return json({ error: authError }, status);
    }

    if (url.pathname === "/api/sets") {
      const code = (url.searchParams.get("code") || "").trim().toLowerCase();
      if (!code) return json({ error: "code required" }, 400);
      const matches = manifest.filter((entry) =>
        entryCodes(entry).some((c) => String(c).toLowerCase() === code)
      );
      // Strip codes from response — client never needs them.
      const sets = matches.map(({ file, name }) => ({ file, name }));
      return json({ sets });
    }

    if (url.pathname.startsWith("/questions/")) {
      // Pass through to static assets. The auth check above gates access.
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/flag" && request.method === "POST") {
      if (!env.DB) return json({ error: "flags database not configured" }, 500);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const { question, setName, note, id, questionIndex, timestamp } = body;
      if (!question) return json({ error: "question required" }, 400);
      await env.DB.prepare(
        "INSERT INTO flags (submitted_at, question_id, question_text, set_name, cursor_index, note) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(
          timestamp ?? new Date().toISOString(),
          id ?? null,
          String(question),
          setName ?? null,
          questionIndex ?? null,
          note ?? null
        )
        .run();
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};

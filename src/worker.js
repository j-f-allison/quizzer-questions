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
import { adminPage } from "./admin-page.js";
import { EmailMessage } from "cloudflare:email";

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

// Optional email notification on flag. Requires: EMAIL send_email binding,
// NOTIFY_FROM (sender address on a Cloudflare Email Routing domain),
// and NOTIFY_TO (recipient). If any are absent, silently skips.
async function sendFlagNotification(env, { question, setName, note, id, questionIndex }) {
  if (!env.EMAIL || !env.NOTIFY_FROM || !env.NOTIFY_TO) {
    console.warn("Flag email skipped: missing", !env.EMAIL ? "EMAIL binding" : !env.NOTIFY_FROM ? "NOTIFY_FROM" : "NOTIFY_TO");
    return;
  }
  const subject = "Quizzer: question flagged";
  const body = [
    `Set: ${setName ?? "(unknown)"}`,
    `Question #${questionIndex != null ? questionIndex + 1 : "?"}${id ? ` (ID: ${id})` : ""}`,
    ``,
    question,
    ``,
    note ? `Note: ${note}` : "(no note provided)",
  ].join("\n");
  const raw = [
    `From: Quizzer <${env.NOTIFY_FROM}>`,
    `To: ${env.NOTIFY_TO}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join("\r\n");
  const encoded = new TextEncoder().encode(raw);
  const stream = new ReadableStream({
    start(c) { c.enqueue(encoded); c.close(); },
  });
  try {
    await env.EMAIL.send(new EmailMessage(env.NOTIFY_FROM, env.NOTIFY_TO, stream));
    console.log(`Flag email sent to ${env.NOTIFY_TO}`);
  } catch (err) {
    console.error("Flag email failed:", err?.message ?? err);
  }
}

// ---- Admin panel (Cloudflare Access–gated) -------------------------------
//
// The /admin* routes are NOT gated by the shared bearer token (the admin's
// browser doesn't have it). They're protected by Cloudflare Access, which
// must be configured to cover the path /admin* on this Worker's host. As
// defense-in-depth we also cryptographically verify the Access JWT here, so a
// direct hit to this Worker's URL that bypasses Access is still rejected.

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// Cache the Access signing keys (JWKS) in module memory, keyed by team domain.
let jwksCache = { domain: null, keys: null };
async function getAccessKeys(teamDomain) {
  if (jwksCache.domain === teamDomain && jwksCache.keys) return jwksCache.keys;
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = await res.json();
  jwksCache = { domain: teamDomain, keys };
  return keys;
}

// Returns { email } on success, or { error } ("admin not configured" → 500,
// "forbidden" → 403).
async function verifyAccess(request, env) {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN || "").replace(/\/+$/, "");
  const aud = env.ACCESS_AUD;
  if (!teamDomain || !aud) return { error: "admin not configured" };

  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    readCookie(request, "CF_Authorization");
  if (!token) return { error: "forbidden" };

  const parts = token.split(".");
  if (parts.length !== 3) return { error: "forbidden" };

  let header, payload;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
  } catch {
    return { error: "forbidden" };
  }

  // Claim checks.
  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { error: "forbidden" };
  if (payload.iss !== teamDomain) return { error: "forbidden" };
  if (typeof payload.exp === "number" && payload.exp < now) return { error: "forbidden" };

  // Signature check (RS256).
  let keys;
  try {
    keys = await getAccessKeys(teamDomain);
  } catch {
    return { error: "admin not configured" };
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { error: "forbidden" };

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    ok = false;
  }
  if (!ok) return { error: "forbidden" };

  return { email: payload.email || "(unknown)" };
}

async function handleAdmin(request, env, url) {
  const auth = await verifyAccess(request, env);
  if (auth.error) {
    return json({ error: auth.error }, auth.error === "admin not configured" ? 500 : 403);
  }

  if (url.pathname === "/admin" && request.method === "GET") {
    return new Response(adminPage, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (url.pathname === "/admin/api/flags" && request.method === "GET") {
    if (!env.DB) return json({ error: "flags database not configured" }, 500);
    const { results } = await env.DB.prepare(
      "SELECT id, submitted_at, question_id, question_text, set_name, cursor_index, note FROM flags ORDER BY submitted_at DESC"
    ).all();
    return json({ flags: results ?? [], user: auth.email });
  }

  const del = url.pathname.match(/^\/admin\/api\/flags\/(\d+)$/);
  if (del && request.method === "DELETE") {
    if (!env.DB) return json({ error: "flags database not configured" }, 500);
    const id = Number(del[1]);
    const res = await env.DB.prepare("DELETE FROM flags WHERE id = ?").bind(id).run();
    if (!(res.meta?.changes ?? 0)) return json({ error: "not found" }, 404);
    return json({ ok: true, deleted: id });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Admin panel is Access-gated, not bearer-gated — handle it first.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }

    // Auth-gate everything else this Worker handles.
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
      await sendFlagNotification(env, { question, setName, note, id, questionIndex });
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};

// Admin panel HTML, bundled into the Worker (never served as a static asset —
// same pattern as manifest.js). Served by the Worker at GET /admin, behind
// Cloudflare Access. The page calls /admin/api/flags (same-origin, so the
// Access cookie rides along) to list and clear flags.
//
// All flag content is rendered with textContent, never innerHTML — flag notes
// and question text are user-supplied (XSS), same convention as the frontend.

export const adminPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Flag review — Quizzer admin</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #fff; --text: #1a1d21; --muted: #6b7280;
    --border: #e4e7eb; --accent: #2563eb; --danger: #dc2626; --danger-bg: #fee2e2;
    --label: #9ca3af; --note-bg: #f3f4f6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #15171a; --card: #1e2125; --text: #e7eaee; --muted: #9aa3af;
      --border: #2b2f35; --accent: #60a5fa; --danger: #f87171; --danger-bg: #3b1f22;
      --label: #6b7280; --note-bg: #262a30;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
  }
  header {
    position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--border);
    padding: 1rem 1.25rem; display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap;
  }
  header h1 { font-size: 1.15rem; margin: 0; }
  header .meta { color: var(--muted); font-size: 0.85rem; }
  main { max-width: 880px; margin: 0 auto; padding: 1.25rem; }
  .status { color: var(--muted); padding: 2rem 0; text-align: center; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 1rem 1.1rem; margin-bottom: 0.9rem;
  }
  .card-top {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 1rem; margin-bottom: 0.6rem;
  }
  .fields { display: flex; flex-wrap: wrap; gap: 0.35rem 1.1rem; font-size: 0.82rem; color: var(--muted); }
  .fields b { color: var(--label); font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; font-size: 0.72rem; }
  .question { white-space: pre-wrap; margin: 0.4rem 0; }
  .note {
    background: var(--note-bg); border-radius: 6px; padding: 0.5rem 0.7rem;
    white-space: pre-wrap; font-size: 0.92rem; margin-top: 0.5rem;
  }
  .note-empty { color: var(--muted); font-style: italic; }
  .clear-btn {
    flex: none; background: var(--danger-bg); color: var(--danger); border: none;
    border-radius: 6px; padding: 0.4rem 0.8rem; font-size: 0.85rem; font-weight: 600;
    cursor: pointer;
  }
  .clear-btn:hover { filter: brightness(0.95); }
  .clear-btn:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<header>
  <h1>Flag review</h1>
  <span class="meta" id="meta"></span>
</header>
<main>
  <div class="status" id="status">Loading flags…</div>
  <div id="list"></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);

  function fmtTime(s) {
    if (!s) return "(no timestamp)";
    const d = new Date(s);
    return isNaN(d) ? s : d.toLocaleString();
  }

  function field(label, value) {
    const span = document.createElement("span");
    const b = document.createElement("b");
    b.textContent = label + " ";
    span.appendChild(b);
    span.appendChild(document.createTextNode(value == null || value === "" ? "—" : String(value)));
    return span;
  }

  function renderCard(flag) {
    const card = document.createElement("div");
    card.className = "card";

    const top = document.createElement("div");
    top.className = "card-top";

    const fields = document.createElement("div");
    fields.className = "fields";
    fields.appendChild(field("#" + flag.id, fmtTime(flag.submitted_at)));
    fields.appendChild(field("Set", flag.set_name));
    fields.appendChild(field("Q-ID", flag.question_id));
    fields.appendChild(field("Index", flag.cursor_index == null ? null : flag.cursor_index + 1));
    top.appendChild(fields);

    const btn = document.createElement("button");
    btn.className = "clear-btn";
    btn.textContent = "Clear";
    btn.addEventListener("click", () => clearFlag(flag.id, btn, card));
    top.appendChild(btn);

    card.appendChild(top);

    const q = document.createElement("div");
    q.className = "question";
    q.textContent = flag.question_text || "(no question text)";
    card.appendChild(q);

    if (flag.note) {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = flag.note;
      card.appendChild(note);
    } else {
      const note = document.createElement("div");
      note.className = "note note-empty";
      note.textContent = "(no note)";
      card.appendChild(note);
    }

    return card;
  }

  async function clearFlag(id, btn, card) {
    if (!confirm("Clear flag #" + id + "? This permanently deletes it.")) return;
    btn.disabled = true;
    btn.textContent = "Clearing…";
    try {
      const res = await fetch("/admin/api/flags/" + id, { method: "DELETE" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      card.remove();
      updateCount();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Clear";
      alert("Could not clear flag: " + e.message);
    }
  }

  function updateCount() {
    const n = $("list").children.length;
    $("meta").textContent = (window.__user ? window.__user + " · " : "") +
      n + (n === 1 ? " flag" : " flags");
    if (n === 0) {
      $("status").textContent = "No flags. 🎉";
      $("status").style.display = "";
    } else {
      $("status").style.display = "none";
    }
  }

  async function load() {
    try {
      const res = await fetch("/admin/api/flags");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      window.__user = data.user || "";
      const list = $("list");
      list.innerHTML = "";
      (data.flags || []).forEach((f) => list.appendChild(renderCard(f)));
      updateCount();
    } catch (e) {
      $("status").textContent = "Could not load flags: " + e.message;
    }
  }

  load();
</script>
</body>
</html>`;

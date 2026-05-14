CREATE TABLE IF NOT EXISTS flags (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submitted_at  TEXT    NOT NULL,
  question_id   TEXT,
  question_text TEXT    NOT NULL,
  set_name      TEXT,
  cursor_index  INTEGER,
  note          TEXT
);

PRAGMA foreign_keys = ON;

CREATE TABLE elections (
  year INTEGER PRIMARY KEY,
  label TEXT NOT NULL
);

CREATE TABLE counties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL
);

CREATE TABLE candidates (
  id INTEGER PRIMARY KEY,
  election_year INTEGER NOT NULL REFERENCES elections(year),
  county_id TEXT NOT NULL REFERENCES counties(id),
  name TEXT NOT NULL,
  party TEXT NOT NULL,
  vision TEXT NOT NULL DEFAULT '',
  source_reference TEXT NOT NULL DEFAULT '',
  UNIQUE (election_year, county_id)
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE (candidate_id, name)
);

CREATE TABLE promises (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  source_reference TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL,
  UNIQUE (category_id, title)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_counties (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('birth', 'work')),
  county_id TEXT NOT NULL REFERENCES counties(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, slot),
  UNIQUE (user_id, county_id)
);

CREATE TABLE votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  promise_id INTEGER NOT NULL REFERENCES promises(id) ON DELETE CASCADE,
  verdict INTEGER NOT NULL CHECK (verdict IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, promise_id)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_candidates_year_county ON candidates(election_year, county_id);
CREATE INDEX idx_categories_candidate ON categories(candidate_id, sort_order);
CREATE INDEX idx_promises_category ON promises(category_id, sort_order);
CREATE INDEX idx_votes_promise ON votes(promise_id, verdict);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);


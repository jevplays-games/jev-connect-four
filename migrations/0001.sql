PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, discord_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 pending_launch TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
 token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('oauth','launch')),
 session_hash TEXT, discord_id TEXT, guild_id TEXT, channel_id TEXT, interaction_id TEXT UNIQUE,
 issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS context_grants (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, verified_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
 id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 guest_session TEXT, create_key TEXT NOT NULL, create_hash TEXT NOT NULL,
 difficulty TEXT NOT NULL CHECK(difficulty IN ('easy','normal','hard','jev')),
 opponent_version TEXT NOT NULL, human_disc INTEGER NOT NULL CHECK(human_disc IN (1,2)),
 ranked INTEGER NOT NULL CHECK(ranked IN (0,1)), eligible INTEGER NOT NULL DEFAULT 0,
 guild_id TEXT, channel_id TEXT, status TEXT NOT NULL, result TEXT,
 started_at INTEGER NOT NULL, finished_at INTEGER, deadline_at INTEGER NOT NULL,
 version INTEGER NOT NULL, event_seq INTEGER NOT NULL, event_head TEXT NOT NULL,
 last_write TEXT NOT NULL, snapshot TEXT NOT NULL,
 CHECK((user_id IS NULL) != (guest_session IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS match_user_create ON matches(user_id,create_key) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS match_guest_create ON matches(guest_session,create_key) WHERE guest_session IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_ranked ON matches(user_id) WHERE ranked=1 AND status IN ('active','thinking');
CREATE TABLE IF NOT EXISTS events (
 match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, event_type TEXT NOT NULL, utc_ms INTEGER NOT NULL,
 prev_hash TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(match_id,seq)
);
CREATE TABLE IF NOT EXISTS commands (
 match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
 command_key TEXT NOT NULL, request_hash TEXT NOT NULL, accepted_version INTEGER NOT NULL,
 PRIMARY KEY(match_id,command_key)
);
CREATE TABLE IF NOT EXISTS client_metrics (
 id TEXT PRIMARY KEY, match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
 received_at INTEGER NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
 bucket TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, PRIMARY KEY(bucket,name)
);
CREATE INDEX IF NOT EXISTS match_history ON matches(user_id,started_at DESC);
CREATE INDEX IF NOT EXISTS leaderboard_world ON matches(difficulty,opponent_version,human_disc,eligible,finished_at);
CREATE INDEX IF NOT EXISTS leaderboard_server ON matches(guild_id,difficulty,opponent_version,human_disc,eligible,finished_at);
CREATE INDEX IF NOT EXISTS leaderboard_channel ON matches(channel_id,difficulty,opponent_version,human_disc,eligible,finished_at);
CREATE INDEX IF NOT EXISTS events_type_time ON events(event_type,utc_ms);
CREATE INDEX IF NOT EXISTS matches_deadlines ON matches(status,deadline_at);
CREATE INDEX IF NOT EXISTS tickets_expiry ON tickets(expires_at);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS counters_expiry ON counters(expires_at);

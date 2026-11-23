-- Authentication tables: login identities and refresh tokens.
-- Run once with psql. Safe to re-run.
--
-- company_users.auth_user_id points at app_users.id; the superadmin's id is
-- hard-coded in backend/middleware/auth.go. password_hash is bcrypt.

CREATE TABLE IF NOT EXISTS app_users (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email            TEXT NOT NULL,
    password_hash    TEXT NOT NULL DEFAULT '',
    name             TEXT NOT NULL DEFAULT '',
    last_sign_in_at  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Emails are matched case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_key ON app_users (lower(email));

-- Refresh tokens: only the SHA-256 hash is stored. Rotated on every refresh.
CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_refresh_tokens_user_idx ON auth_refresh_tokens (user_id);

import pg from "pg";

// migrate 用 superuser (postgres) 連線建表、啟用 RLS、建 app_user
const adminUrl =
  process.env.ADMIN_DATABASE_URL ??
  `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`;

const APP_PASSWORD = process.env.DB_PASSWORD ?? "change-me-appuser";

// 需啟用 RLS 的業務表（含 workspace_id）
const RLS_TABLES = [
  "workspaces",
  "memberships",
  "calendars",
  "events",
  "event_participants",
  "resources",
  "resource_bookings",
  "event_reminders",
  "webhooks",
  "audit_log",
  "groups",
  "group_members",
];

const DDL = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL, display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, slug citext UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  region text, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','scheduler','member','guest')),
  timezone text NOT NULL DEFAULT 'UTC',
  working_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id));

CREATE TABLE IF NOT EXISTS calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES memberships(id),
  name text NOT NULL,
  visibility text NOT NULL DEFAULT 'busy' CHECK (visibility IN ('public','busy','private')),
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  calendar_id uuid NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  title text NOT NULL, description text,
  start_utc timestamptz NOT NULL, end_utc timestamptz NOT NULL,
  timezone text NOT NULL,
  rrule text, rdate timestamptz[], exdate timestamptz[],
  recurrence_id timestamptz,
  master_id uuid REFERENCES events(id) ON DELETE CASCADE,
  visibility text NOT NULL DEFAULT 'busy' CHECK (visibility IN ('public','busy','private')),
  location text, created_by uuid NOT NULL REFERENCES memberships(id),
  source text NOT NULL DEFAULT 'app' CHECK (source IN ('app','agent','google','m365')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  CHECK (end_utc > start_utc),
  CHECK (
    (rrule IS NULL AND recurrence_id IS NULL AND master_id IS NULL)
    OR (rrule IS NOT NULL AND recurrence_id IS NULL AND master_id IS NULL)
    OR (rrule IS NULL AND recurrence_id IS NOT NULL AND master_id IS NOT NULL)),
  UNIQUE (workspace_id, master_id, recurrence_id));

CREATE TABLE IF NOT EXISTS event_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id uuid REFERENCES memberships(id), guest_email citext,
  response_status text NOT NULL DEFAULT 'needs_action'
    CHECK (response_status IN ('needs_action','accepted','declined','tentative')),
  is_organizer boolean NOT NULL DEFAULT false,
  UNIQUE (event_id, member_id),
  CHECK (member_id IS NOT NULL OR guest_email IS NOT NULL));

CREATE TABLE IF NOT EXISTS resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, type text NOT NULL DEFAULT 'room' CHECK (type IN ('room','equipment')),
  capacity int, availability jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS resource_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  start_utc timestamptz NOT NULL, end_utc timestamptz NOT NULL,
  CHECK (end_utc > start_utc),
  EXCLUDE USING gist (resource_id WITH =, tstzrange(start_utc, end_utc) WITH &&));

CREATE TABLE IF NOT EXISTS event_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id uuid REFERENCES memberships(id),
  lead_minutes int NOT NULL CHECK (lead_minutes >= 0),
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','push','webhook')),
  enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, member_id, lead_minutes, channel));

CREATE TABLE IF NOT EXISTS groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_by uuid REFERENCES memberships(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name));

CREATE TABLE IF NOT EXISTS group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('leader','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id));

CREATE TABLE IF NOT EXISTS webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url text NOT NULL, secret text NOT NULL, events text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','agent','system')),
  on_behalf_of uuid, agent_id text,
  action text NOT NULL, target_type text, target_id uuid,
  decision text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now());

CREATE INDEX IF NOT EXISTS events_ws_cal_time ON events (workspace_id, calendar_id, start_utc, end_utc) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS events_ws_master ON events (workspace_id, master_id);
CREATE INDEX IF NOT EXISTS ep_ws_member ON event_participants (workspace_id, member_id);
CREATE INDEX IF NOT EXISTS rb_ws_res_time ON resource_bookings (workspace_id, resource_id, start_utc);
CREATE INDEX IF NOT EXISTS er_ws_event ON event_reminders (workspace_id, event_id);
CREATE INDEX IF NOT EXISTS audit_ws_at ON audit_log (workspace_id, at DESC);

-- 團隊群組 RSVP（feature-team-groups）：擴充參與者狀態 + group_members 索引
ALTER TABLE event_participants
  ADD COLUMN IF NOT EXISTS rsvp_status text NOT NULL DEFAULT 'pending'
    CHECK (rsvp_status IN ('pending','accepted','declined'));
CREATE INDEX IF NOT EXISTS gm_ws_group ON group_members (workspace_id, group_id);
CREATE INDEX IF NOT EXISTS gm_ws_user ON group_members (workspace_id, user_id);
CREATE INDEX IF NOT EXISTS groups_ws_name ON groups (workspace_id, name);
`;

function rlsSql(): string {
  return RLS_TABLES.map((t) => {
    // workspaces 的隔離鍵是自身 id；其餘業務表是 workspace_id
    const col = t === "workspaces" ? "id" : "workspace_id";
    return `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON ${t};
CREATE POLICY workspace_isolation ON ${t}
  USING (${col} = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
  WITH CHECK (${col} = NULLIF(current_setting('app.current_workspace', true), '')::uuid);`;
  }).join("\n");
}

async function main() {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(DDL);
    await client.query(rlsSql());

    // 建應用角色 app_user：NOSUPERUSER、無 BYPASSRLS (ISO-5)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
          CREATE ROLE app_user LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        ELSE
          ALTER ROLE app_user WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
    `);
    await client.query(`GRANT USAGE ON SCHEMA public TO app_user;`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;`);

    console.log("migrate: OK (schema + RLS on", RLS_TABLES.length, "tables + app_user)");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("migrate FAILED:", e);
  process.exit(1);
});

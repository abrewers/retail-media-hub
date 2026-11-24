// Lakebase (Postgres) write-back for the Command Center.
//
// The app owns one schema, app_ops: rebalance actions, make-good log and campaign ops status.
// Governed campaign data is NOT copied here; it is read from Unity Catalog (see governed.ts).
// Demo seed rows come from cfg_demo_config.app_seed (written by the setup job from seed_config.yml).

import type { Application, Request, Response } from 'express';
import { campaignById, campaignSites } from './governed';

export interface AppKitWithLakebase {
  lakebase: {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

const OPS_DDL = `
CREATE SCHEMA IF NOT EXISTS app_ops;

CREATE TABLE IF NOT EXISTS app_ops.rebalance_actions (
  action_id               BIGSERIAL PRIMARY KEY,
  campaign_id             INTEGER     NOT NULL,
  campaign_name           TEXT        NOT NULL,
  site_id                 INTEGER     NOT NULL,
  site_name               TEXT        NOT NULL,
  previous_daily_target   INTEGER,
  new_daily_target        INTEGER     NOT NULL,
  impressions_reallocated INTEGER     NOT NULL,
  action_type             TEXT        NOT NULL CHECK (action_type IN ('increase','decrease','pause')),
  reason                  TEXT,
  created_by              TEXT        NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                  TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','executed','rejected'))
);

CREATE TABLE IF NOT EXISTS app_ops.make_good_log (
  make_good_id          BIGSERIAL PRIMARY KEY,
  campaign_id           INTEGER       NOT NULL,
  campaign_name         TEXT          NOT NULL,
  advertiser            TEXT          NOT NULL,
  shortfall_impressions INTEGER       NOT NULL,
  shortfall_dollars     NUMERIC(12,2) NOT NULL,
  make_good_type        TEXT          NOT NULL CHECK (make_good_type IN ('extension','bonus_impressions','credit','rate_adjustment')),
  make_good_value       NUMERIC(12,2),
  contract_clause       TEXT,
  notes                 TEXT,
  created_by            TEXT          NOT NULL,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  approved_by           TEXT,
  approved_at           TIMESTAMPTZ,
  status                TEXT          NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','fulfilled','disputed'))
);

CREATE TABLE IF NOT EXISTS app_ops.campaign_ops_status (
  ops_id          BIGSERIAL PRIMARY KEY,
  campaign_id     INTEGER     NOT NULL,
  campaign_name   TEXT        NOT NULL,
  previous_status TEXT,
  new_status      TEXT        NOT NULL CHECK (new_status IN ('monitoring','rebalancing','make_good_pending','make_good_fulfilled','closed')),
  action_taken    TEXT        NOT NULL,
  owner           TEXT        NOT NULL,
  priority        TEXT        NOT NULL CHECK (priority IN ('critical','high','medium','low')),
  due_date        DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rebalance_actions_campaign_id   ON app_ops.rebalance_actions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_make_good_log_campaign_id       ON app_ops.make_good_log(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_ops_status_campaign_id ON app_ops.campaign_ops_status(campaign_id);
`;

const TABLES = ['rebalance_actions', 'make_good_log', 'campaign_ops_status'] as const;

interface SeedMakeGood {
  campaign_id: number; type: string; status: string; created_by: string; created_offset: number;
  approved_by?: string; approved_offset?: number; clause?: string; notes?: string;
}
interface SeedRebalance {
  campaign_id: number; created_by: string; created_offset: number; increase_top_sites: number;
  decrease_bottom_sites: number; statuses: string[]; reason: string;
}
interface AppSeed {
  as_of_date: string;
  users: Record<string, string>;
  make_goods: SeedMakeGood[];
  rebalances: SeedRebalance[];
}

let appSeed: AppSeed | null = null;
export function setAppSeed(seed: unknown): void {
  appSeed = (seed as AppSeed) ?? null;
}

/** as_of_date + offset days, at 14:00 UTC. */
function seedTime(offset: number): string {
  const d = new Date(`${appSeed?.as_of_date ?? new Date().toISOString().slice(0, 10)}T14:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString();
}

async function seedRows(appkit: AppKitWithLakebase): Promise<void> {
  if (!appSeed) {
    console.log('[ops] no app_seed in cfg_demo_config yet; starting with empty write-back tables');
    return;
  }
  const user = (k: string | undefined) => (k ? (appSeed?.users[k] ?? k) : null);

  for (const m of appSeed.make_goods) {
    const c = await campaignById(m.campaign_id);
    if (!c) continue;
    const created = seedTime(m.created_offset);
    await appkit.lakebase.query(
      `INSERT INTO app_ops.make_good_log
         (campaign_id, campaign_name, advertiser, shortfall_impressions, shortfall_dollars, make_good_type, make_good_value,
          contract_clause, notes, created_by, created_at, approved_by, approved_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$5,$7,$8,$9,$10,$11,$12,$13)`,
      [m.campaign_id, c.campaign_name, c.advertiser, Math.round(Number(c.shortfall_impressions)), c.shortfall_dollars,
       m.type, m.clause ?? null, m.notes ?? null, user(m.created_by), created, user(m.approved_by),
       m.approved_offset !== undefined ? seedTime(m.approved_offset) : null, m.status],
    );
    const fulfilled = m.status === 'approved';
    await appkit.lakebase.query(
      `INSERT INTO app_ops.campaign_ops_status
         (campaign_id, campaign_name, previous_status, new_status, action_taken, owner, priority, due_date, created_at, updated_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,($8::timestamptz + interval '7 days')::date,$8,$9,$9)`,
      [m.campaign_id, c.campaign_name, fulfilled ? 'make_good_pending' : 'monitoring',
       fulfilled ? 'make_good_fulfilled' : 'make_good_pending',
       `Flight closed at ${c.delivery_rate_pct}% delivery. Make-good (${m.type.replace('_', ' ')}) ${m.status}`,
       user(m.created_by), fulfilled ? 'medium' : 'high', created,
       m.approved_offset !== undefined ? seedTime(m.approved_offset) : null],
    );
  }

  for (const r of appSeed.rebalances) {
    const c = await campaignById(r.campaign_id);
    const sites = await campaignSites(r.campaign_id); // weakest first
    if (!c || sites.length === 0) continue;
    const picks = [
      ...sites.slice(-r.increase_top_sites).reverse().map((s) => ({ s, factor: 1.4 })),
      ...sites.slice(0, r.decrease_bottom_sites).map((s) => ({ s, factor: 0.5 })),
    ];
    const created = seedTime(r.created_offset);
    let net = 0;
    for (const [i, { s, factor }] of picks.entries()) {
      const prev = Number(s.avg_daily_impressions);
      const next = Math.round(prev * factor);
      net += next - prev;
      await appkit.lakebase.query(
        `INSERT INTO app_ops.rebalance_actions
           (campaign_id, campaign_name, site_id, site_name, previous_daily_target, new_daily_target, impressions_reallocated,
            action_type, reason, created_by, created_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [r.campaign_id, c.campaign_name, s.site_id, s.site_name, prev, next, next - prev,
         next > prev ? 'increase' : 'decrease', r.reason, user(r.created_by), created, r.statuses[i] ?? 'pending'],
      );
    }
    await appkit.lakebase.query(
      `INSERT INTO app_ops.campaign_ops_status
         (campaign_id, campaign_name, previous_status, new_status, action_taken, owner, priority, due_date, created_at, updated_at)
       VALUES ($1,$2,'monitoring','rebalancing',$3,$4,'high',($5::timestamptz + interval '3 days')::date,$5,$5)`,
      [r.campaign_id, c.campaign_name, `Rebalanced ${picks.length} site(s), net ${net >= 0 ? '+' : ''}${net} daily impressions. ${r.reason}`,
       user(r.created_by), created],
    );
  }
  console.log('[ops] seeded app_ops demo rows');
}

/** Creates app_ops (idempotent) and seeds it once if every table is empty. */
export async function setupOpsSchema(appkit: AppKitWithLakebase): Promise<void> {
  try {
    // Create the schema only if a table is missing: re-running DDL on tables created by an earlier
    // app identity needs ownership (the setup job grants this identity full use instead).
    const { rows: present } = await appkit.lakebase.query(
      `SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname = 'app_ops' AND tablename = ANY($1::text[])`,
      [TABLES],
    );
    if (Number(present[0]?.n ?? 0) < TABLES.length) await appkit.lakebase.query(OPS_DDL);
    const { rows } = await appkit.lakebase.query(
      `SELECT (SELECT COUNT(*) FROM app_ops.rebalance_actions) + (SELECT COUNT(*) FROM app_ops.make_good_log)
            + (SELECT COUNT(*) FROM app_ops.campaign_ops_status) AS n`,
    );
    if (Number(rows[0]?.n ?? 0) === 0) await seedRows(appkit);
    console.log('[ops] app_ops schema ready');
  } catch (err) {
    console.error('[ops] app_ops setup failed:', (err as Error).message);
    console.error('[ops] Routes are registered, but reads of action history and all writes will fail until this is fixed.');
  }
}

/** Reset demo data: empties the write-back tables and restores the seed rows. */
export async function resetOps(appkit: AppKitWithLakebase): Promise<void> {
  await appkit.lakebase.query(`TRUNCATE ${TABLES.map((t) => `app_ops.${t}`).join(', ')}`);
  // Restart ids with setval (needs only UPDATE on the sequences, not ownership like RESTART IDENTITY).
  const ID: Record<(typeof TABLES)[number], string> = { rebalance_actions: 'action_id', make_good_log: 'make_good_id', campaign_ops_status: 'ops_id' };
  for (const t of TABLES) {
    await appkit.lakebase.query(`SELECT setval(pg_get_serial_sequence('app_ops.${t}', '${ID[t]}'), 1, false)`);
  }
  await seedRows(appkit);
}

/** Signed-in user's email, injected by the Databricks Apps proxy. */
export function userEmail(req: Request): string {
  return req.header('x-forwarded-email') ?? req.header('x-forwarded-preferred-username') ?? 'local-dev@example.com';
}

export function qstr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function qint(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export function parseId(value: string): number | null {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function fail(res: Response, label: string, err: unknown): void {
  console.error(`[ops] ${label} failed:`, err);
  res.status(500).json({ error: `${label} failed` });
}

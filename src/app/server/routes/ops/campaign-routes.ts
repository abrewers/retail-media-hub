// Campaign Triage + Rebalance Workbench routes.
// Reads: Unity Catalog (v_campaign_delivery, metric_view_campaign_delivery, v_campaign_site_daily) via governed.ts.
// Reads + writes: Lakebase app_ops (latest ops status, rebalance history).

import { z } from 'zod';
import { campaignById, campaigns, campaignSites, kpis, pacing } from './governed';
import type { AppKitWithLakebase } from './ops-db';
import { fail, parseId, qint, qstr, userEmail } from './ops-db';
import type { Row } from './warehouse';

const STATUS_VALUES = new Set<string>(['all', 'active', 'completed', 'paused']);
const RISK_VALUES = new Set<string>(['all', 'Critical', 'At Risk', 'On Track', 'Over-Delivering']);

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const SORTS: Record<string, (a: Row, b: Row) => number> = {
  shortfall: (a, b) => num(b.shortfall_dollars, -Infinity) - num(a.shortfall_dollars, -Infinity),
  pace: (a, b) => num(a.pace_adjusted_pct, Infinity) - num(b.pace_adjusted_pct, Infinity),
  days: (a, b) => num(a.days_remaining, Infinity) - num(b.days_remaining, Infinity),
};

const LATEST_OPS_SQL = `
  SELECT DISTINCT ON (campaign_id) campaign_id, new_status, priority, owner, action_taken
  FROM app_ops.campaign_ops_status
  ORDER BY campaign_id, created_at DESC, ops_id DESC`;

const LATEST_SITE_TARGETS_SQL = `
  SELECT DISTINCT ON (site_id) site_id, new_daily_target, status
  FROM app_ops.rebalance_actions
  WHERE campaign_id = $1::int
  ORDER BY site_id, created_at DESC, action_id DESC`;

const ACTIONS_SQL = `
  SELECT action_id::int AS action_id, site_id::int AS site_id, site_name,
         previous_daily_target::int AS previous_daily_target,
         new_daily_target::int AS new_daily_target,
         impressions_reallocated::int AS impressions_reallocated,
         action_type, reason, created_by, status,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS created_at_utc
  FROM app_ops.rebalance_actions
  WHERE campaign_id = $1::int
  ORDER BY created_at DESC, action_id DESC
  LIMIT 100`;

// One statement = one transaction: the site actions and the campaign status change land together.
const REBALANCE_INSERT_SQL = `
  WITH input AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS x(site_id int, site_name text, previous_daily_target int, new_daily_target int)
  ), ins AS (
    INSERT INTO app_ops.rebalance_actions
      (campaign_id, campaign_name, site_id, site_name, previous_daily_target, new_daily_target,
       impressions_reallocated, action_type, reason, created_by)
    SELECT $2::int, $3::text, site_id, site_name, previous_daily_target, new_daily_target,
           new_daily_target - previous_daily_target,
           CASE WHEN new_daily_target = 0 THEN 'pause'
                WHEN new_daily_target > previous_daily_target THEN 'increase'
                ELSE 'decrease' END,
           $4::text, $5::text
    FROM input
    RETURNING action_id
  ), st AS (
    INSERT INTO app_ops.campaign_ops_status
      (campaign_id, campaign_name, previous_status, new_status, action_taken, owner, priority, due_date)
    VALUES ($2::int, $3::text, $6::text, 'rebalancing', $7::text, $5::text, $8::text, CURRENT_DATE + GREATEST($9::int, 0))
    RETURNING ops_id
  )
  SELECT (SELECT COUNT(*) FROM ins)::int AS actions_logged, (SELECT ops_id FROM st)::int AS ops_id`;

const RebalanceBody = z.object({
  reason: z.string().trim().min(3).max(500),
  changes: z
    .array(z.object({ siteId: z.number().int().positive(), newDailyTarget: z.number().int().min(0).max(1_000_000) }))
    .min(1)
    .max(200),
});

function priorityFor(risk: unknown): string {
  if (risk === 'Critical') return 'critical';
  if (risk === 'At Risk') return 'high';
  return 'medium';
}

const CAMPAIGN_FIELDS = [
  'campaign_id', 'campaign_name', 'advertiser', 'region', 'channel', 'status', 'contracted_impressions',
  'delivered_impressions', 'shortfall_impressions', 'shortfall_dollars', 'delivery_rate_pct', 'pace_adjusted_pct',
  'days_remaining', 'risk_level',
] as const;

function pick(c: Row, ops: Record<string, unknown> | undefined) {
  const out: Record<string, unknown> = {};
  for (const f of CAMPAIGN_FIELDS) out[f] = c[f];
  out.ops_status = ops?.new_status ?? null;
  out.ops_priority = ops?.priority ?? null;
  return out;
}

async function latestOps(appkit: AppKitWithLakebase): Promise<Map<number, Record<string, unknown>>> {
  const { rows } = await appkit.lakebase.query(LATEST_OPS_SQL);
  return new Map(rows.map((r) => [Number(r.campaign_id), r]));
}

async function detail(appkit: AppKitWithLakebase, id: number): Promise<Record<string, unknown> | undefined> {
  const c = await campaignById(id);
  if (!c) return undefined;
  const ops = (await latestOps(appkit)).get(id);
  return {
    ...pick(c, ops),
    cpm_rate: c.cpm_rate,
    start_date: c.start_date,
    end_date: c.end_date,
    ops_owner: ops?.owner ?? null,
    ops_action: ops?.action_taken ?? null,
  };
}

/** Sites for a campaign with the current daily target (latest rebalance in Lakebase, else the observed average). */
async function sitesWithTargets(appkit: AppKitWithLakebase, id: number) {
  const [sites, { rows }] = await Promise.all([campaignSites(id), appkit.lakebase.query(LATEST_SITE_TARGETS_SQL, [id])]);
  const latest = new Map(rows.map((r) => [Number(r.site_id), r]));
  return sites.map((s) => {
    const r = latest.get(Number(s.site_id));
    return {
      site_id: s.site_id, site_name: s.site_name, city: s.city, state: s.state, archetype: s.archetype,
      pump_count: s.pump_count, delivered_impressions: s.delivered_impressions, active_days: s.active_days,
      avg_daily_impressions: s.avg_daily_impressions,
      current_target: r ? Number(r.new_daily_target) : Number(s.avg_daily_impressions),
      last_action_status: r?.status ?? null,
    };
  });
}

export function registerCampaignRoutes(appkit: AppKitWithLakebase): void {
  appkit.server.extend((app) => {
    app.get('/api/me', (req, res) => {
      res.json({ email: userEmail(req) });
    });

    app.get('/api/campaigns/kpis', async (_req, res) => {
      try {
        res.json(await kpis());
      } catch (err) {
        fail(res, 'Load campaign KPIs', err);
      }
    });

    app.get('/api/campaigns', async (req, res) => {
      const status = qstr(req.query.status, 'active');
      const risk = qstr(req.query.risk, 'all');
      if (!STATUS_VALUES.has(status) || !RISK_VALUES.has(risk)) {
        res.status(400).json({ error: 'Invalid status or risk filter' });
        return;
      }
      const search = qstr(req.query.q, '').trim().slice(0, 100).toLowerCase();
      const sort = SORTS[qstr(req.query.sort, 'shortfall')] ?? SORTS.shortfall;
      const page = qint(req.query.page, 1, 1, 1000);
      const pageSize = qint(req.query.pageSize, 10, 1, 100);
      try {
        const [all, ops] = await Promise.all([campaigns(), latestOps(appkit)]);
        const filtered = all
          .filter((c) => status === 'all' || c.status === status)
          .filter((c) => risk === 'all' || c.risk_level === risk)
          .filter((c) => !search || String(c.campaign_name).toLowerCase().includes(search)
            || String(c.advertiser).toLowerCase().includes(search))
          .sort((a, b) => sort(a, b) || Number(a.campaign_id) - Number(b.campaign_id));
        const rows = filtered.slice((page - 1) * pageSize, page * pageSize).map((c) => pick(c, ops.get(Number(c.campaign_id))));
        res.json({ rows, total: filtered.length, page, pageSize });
      } catch (err) {
        fail(res, 'Load campaigns', err);
      }
    });

    app.get('/api/campaigns/:id', async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        res.status(400).json({ error: 'Invalid campaign id' });
        return;
      }
      try {
        const d = await detail(appkit, id);
        if (!d) {
          res.status(404).json({ error: 'Campaign not found' });
          return;
        }
        res.json(d);
      } catch (err) {
        fail(res, 'Load campaign', err);
      }
    });

    app.get('/api/campaigns/:id/pacing', async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        res.status(400).json({ error: 'Invalid campaign id' });
        return;
      }
      try {
        res.json(await pacing(id));
      } catch (err) {
        fail(res, 'Load pacing', err);
      }
    });

    app.get('/api/campaigns/:id/sites', async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        res.status(400).json({ error: 'Invalid campaign id' });
        return;
      }
      try {
        res.json(await sitesWithTargets(appkit, id));
      } catch (err) {
        fail(res, 'Load sites', err);
      }
    });

    app.get('/api/campaigns/:id/rebalance-actions', async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        res.status(400).json({ error: 'Invalid campaign id' });
        return;
      }
      try {
        const { rows } = await appkit.lakebase.query(ACTIONS_SQL, [id]);
        res.json(rows);
      } catch (err) {
        fail(res, 'Load rebalance actions', err);
      }
    });

    app.post('/api/campaigns/:id/rebalance', async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        res.status(400).json({ error: 'Invalid campaign id' });
        return;
      }
      const parsed = RebalanceBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        return;
      }
      const siteIds = parsed.data.changes.map((c) => c.siteId);
      if (new Set(siteIds).size !== siteIds.length) {
        res.status(400).json({ error: 'Each site can only appear once per rebalance' });
        return;
      }
      try {
        const campaign = await detail(appkit, id);
        if (!campaign) {
          res.status(404).json({ error: 'Campaign not found' });
          return;
        }
        if (campaign.status !== 'active') {
          res.status(409).json({ error: 'Only active campaigns can be rebalanced' });
          return;
        }
        // Site names and current targets come from governed data + Lakebase, never from the client.
        const sitesById = new Map((await sitesWithTargets(appkit, id)).map((s) => [Number(s.site_id), s]));
        const records: { site_id: number; site_name: string; previous_daily_target: number; new_daily_target: number }[] = [];
        for (const change of parsed.data.changes) {
          const site = sitesById.get(change.siteId);
          if (!site) {
            res.status(400).json({ error: `Site ${change.siteId} does not serve this campaign` });
            return;
          }
          if (site.current_target !== change.newDailyTarget) {
            records.push({ site_id: change.siteId, site_name: String(site.site_name),
                           previous_daily_target: site.current_target, new_daily_target: change.newDailyTarget });
          }
        }
        if (records.length === 0) {
          res.status(400).json({ error: 'No site targets changed' });
          return;
        }
        const net = records.reduce((sum, r) => sum + r.new_daily_target - r.previous_daily_target, 0);
        const email = userEmail(req);
        const actionTaken = `Rebalanced ${records.length} site(s), net ${net >= 0 ? '+' : ''}${net} daily impressions. ${parsed.data.reason}`.slice(0, 500);
        const { rows } = await appkit.lakebase.query(REBALANCE_INSERT_SQL, [
          JSON.stringify(records), id, String(campaign.campaign_name), parsed.data.reason, email,
          typeof campaign.ops_status === 'string' ? campaign.ops_status : 'monitoring',
          actionTaken, priorityFor(campaign.risk_level), Number(campaign.days_remaining),
        ]);
        res.status(201).json(rows[0]);
      } catch (err) {
        fail(res, 'Log rebalance', err);
      }
    });
  });
}

// Overview, insight and campaign-context routes for the Ops Console UI.
// All reads are governed (Unity Catalog through the SQL warehouse) except the activity
// timeline, which merges Lakebase write-back history. Nothing here writes.

import { campaignById, campaigns, campaignSites } from './governed';
import type { AppKitWithLakebase } from './ops-db';
import { fail, parseId } from './ops-db';
import { type Row, wqCached } from './warehouse';

// Same rule as client/src/lib/rebalance.ts (suggestTargets / recommend). Keep them in sync:
// top ~35% of sites (min 5) +40%, bottom ~25% (min 3) -50%; make-good when <= 5 days left and
// a rebalance recovers < 25% of the shortfall.
function suggestedRecovery(c: Row, sites: Row[]) {
  const sorted = [...sites].sort((a, b) => Number(a.avg_daily_impressions) - Number(b.avg_daily_impressions) || Number(a.site_id) - Number(b.site_id));
  const n = sorted.length;
  const boost = Math.max(5, Math.ceil(n * 0.35));
  const cut = Math.min(Math.max(3, Math.ceil(n * 0.25)), Math.max(n - boost, 0));
  let net = 0;
  sorted.forEach((s, i) => {
    const cur = Number(s.avg_daily_impressions);
    if (i >= n - boost) net += Math.round(cur * 1.4) - cur;
    else if (i < cut) net += Math.round(cur * 0.5) - cur;
  });
  const days = Math.max(Number(c.days_remaining), 0);
  const imp = Math.min(Math.max(net * days, 0), Math.max(Number(c.shortfall_impressions), 0));
  const usd = (imp * Number(c.cpm_rate)) / 1000;
  const pct = Number(c.shortfall_dollars) > 0 ? (usd / Number(c.shortfall_dollars)) * 100 : 0;
  return { net_daily: net, recovered_usd: usd, recovered_pct: pct };
}

function recommendation(c: Row, recoveredPct: number): string {
  if (c.status !== 'active') return 'none';
  if (c.risk_level === 'Over-Delivering') return 'over_delivering';
  if (c.risk_level !== 'Critical' && c.risk_level !== 'At Risk') return 'on_track';
  return Number(c.days_remaining) <= 5 && recoveredPct < 25 ? 'make_good' : 'rebalance';
}

const REGION_WEEKLY_SQL = `
  SELECT CAST(DATE_TRUNC('WEEK', impression_date) AS STRING) AS week, region,
         ROUND(SUM(screens_online) * 100.0 / SUM(screens_installed), 1) AS uptime_pct,
         CAST(SUM(expected_impressions_full_uptime - impressions) AS DOUBLE) AS lost_impressions,
         CAST(SUM(impressions) AS DOUBLE) AS impressions
  FROM v_campaign_site_daily WHERE campaign_status = 'active'
  GROUP BY ALL ORDER BY week, region`;

const ARCHETYPES_SQL = `
  SELECT archetype, CAST(ROUND(SUM(fuel_transactions) / COUNT(1)) AS DOUBLE) AS transactions_per_day,
         CAST(ROUND(SUM(impressions) / COUNT(1)) AS DOUBLE) AS impressions_per_day,
         ROUND(SUM(screens_online) * 100.0 / SUM(screens_installed), 1) AS uptime_pct
  FROM v_campaign_site_daily WHERE campaign_status = 'active'
  GROUP BY archetype ORDER BY transactions_per_day DESC`;

// Outages found in the data: site-days with most screens offline, grouped by region.
const OUTAGES_SQL = `
  WITH sd AS (
    SELECT DISTINCT site_id, region, impression_date, screens_online, screens_installed
    FROM v_campaign_site_daily WHERE screens_online * 1.0 / screens_installed < 0.6),
  lost AS (
    SELECT region, CAST(SUM(expected_impressions_full_uptime - impressions) AS DOUBLE) AS lost_impressions,
           COUNT(DISTINCT campaign_id) AS campaigns
    FROM v_campaign_site_daily WHERE screens_online * 1.0 / screens_installed < 0.6 GROUP BY region)
  SELECT sd.region, COUNT(DISTINCT sd.site_id) AS sites, CAST(MIN(sd.impression_date) AS STRING) AS start_date,
         CAST(MAX(sd.impression_date) AS STRING) AS end_date,
         ROUND(SUM(sd.screens_online) * 100.0 / SUM(sd.screens_installed), 0) AS uptime_pct,
         MAX(lost.lost_impressions) AS lost_impressions, MAX(lost.campaigns) AS campaigns
  FROM sd JOIN lost USING (region)
  GROUP BY sd.region HAVING COUNT(1) >= 10
  ORDER BY lost_impressions DESC`;

const SPARKLINES_SQL = `
  SELECT campaign_id, to_json(transform(array_sort(collect_list(named_struct('d', impression_date, 'n', n))), x -> x.n)) AS series
  FROM (
    SELECT campaign_id, impression_date, SUM(impressions) AS n FROM v_campaign_site_daily
    WHERE campaign_status = 'active' AND impression_date >= date_sub((SELECT as_of_date FROM cfg_demo_config), 42)
    GROUP BY 1, 2)
  GROUP BY campaign_id`;

const SEARCH_SQL = `
  SELECT campaign_id, to_json(sort_array(collect_set(named_struct('name', site_name, 'city', city, 'state', state)))) AS stores
  FROM v_campaign_site_daily GROUP BY campaign_id`;

const CAMPAIGN_DAILY_SQL = `
  SELECT CAST(impression_date AS STRING) AS d,
         SUM(screens_online) * 1.0 / SUM(screens_installed) AS uptime
  FROM v_campaign_site_daily WHERE campaign_id = :id GROUP BY 1 ORDER BY 1`;

const CREATIVE_SQL = `
  SELECT CAST(start_date AS STRING) AS start_date, CAST(creative_approved_date AS STRING) AS creative_date,
         creative_delay_days, CAST(end_date AS STRING) AS end_date
  FROM v_campaign_delivery WHERE campaign_id = :id`;

const CONTRACT_SQL = `
  SELECT makegood_threshold_pct, makegood_window_days, credit_option_shortfall_pct, makegood_clause_summary,
         excess_shortfall_remedy, special_terms, makegood_policy_text, io_number, advertiser_legal_name,
         regexp_extract(source_file, '[^/]+$', 0) AS file_name, uploaded_by,
         source_file RLIKE '/c[0-9]+__[^/]*$' AS uploaded,
         date_format(extracted_at, "yyyy-MM-dd'T'HH:mm:ss'Z'") AS extracted_at
  FROM dim_contract_terms WHERE campaign_id = :id`;

/** Contiguous runs of days where under 75% of the campaign's screens were online. */
function outageRuns(days: Row[]): { from: string; to: string; uptime: number }[] {
  const runs: { from: string; to: string; vals: number[] }[] = [];
  let cur: { from: string; to: string; vals: number[] } | null = null;
  for (const d of days) {
    const low = Number(d.uptime) < 0.75;
    if (low) {
      if (cur) { cur.to = String(d.d); cur.vals.push(Number(d.uptime)); }
      else cur = { from: String(d.d), to: String(d.d), vals: [Number(d.uptime)] };
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.vals.length >= 2).map((r) => ({ from: r.from, to: r.to, uptime: r.vals.reduce((a, b) => a + b, 0) / r.vals.length }));
}

export function registerInsightRoutes(appkit: AppKitWithLakebase): void {
  appkit.server.extend((app) => {
    app.get('/api/overview/needs-action', async (_req, res) => {
      try {
        const atRisk = (await campaigns()).filter((c) => c.status === 'active' && (c.risk_level === 'Critical' || c.risk_level === 'At Risk'));
        const rows: Record<string, unknown>[] = await Promise.all(atRisk.map(async (c) => {
          const rec = suggestedRecovery(c, await campaignSites(Number(c.campaign_id)));
          return { ...c, ...rec, recommendation: recommendation(c, rec.recovered_pct) };
        }));
        rows.sort((a, b) => Number(a.days_remaining) - Number(b.days_remaining) || Number(b.shortfall_dollars) - Number(a.shortfall_dollars));
        res.json(rows);
      } catch (err) {
        fail(res, 'Load needs-action list', err);
      }
    });

    app.get('/api/overview/region-weekly', async (_req, res) => {
      try { res.json(await wqCached('region-weekly', REGION_WEEKLY_SQL)); } catch (err) { fail(res, 'Load region trend', err); }
    });

    app.get('/api/overview/archetypes', async (_req, res) => {
      try { res.json(await wqCached('archetypes', ARCHETYPES_SQL)); } catch (err) { fail(res, 'Load site types', err); }
    });

    app.get('/api/overview/insights', async (_req, res) => {
      try { res.json({ outages: await wqCached('outages', OUTAGES_SQL) }); } catch (err) { fail(res, 'Load insights', err); }
    });

    app.get('/api/campaigns/sparklines', async (_req, res) => {
      try {
        const rows = await wqCached('sparklines', SPARKLINES_SQL);
        const out: Record<string, number[]> = {};
        for (const r of rows) out[String(r.campaign_id)] = (JSON.parse(String(r.series)) as unknown[]).map(Number);
        res.json(out);
      } catch (err) {
        fail(res, 'Load sparklines', err);
      }
    });

    app.get('/api/search-index', async (_req, res) => {
      try {
        const [all, stores] = await Promise.all([campaigns(), wqCached('search-stores', SEARCH_SQL)]);
        const byId = new Map(stores.map((s) => [Number(s.campaign_id), JSON.parse(String(s.stores)) as unknown[]]));
        res.json(all.map((c) => ({
          campaign_id: c.campaign_id, campaign_name: c.campaign_name, advertiser: c.advertiser, region: c.region,
          status: c.status, risk_level: c.risk_level, shortfall_dollars: c.shortfall_dollars,
          stores: byId.get(Number(c.campaign_id)) ?? [],
        })));
      } catch (err) {
        fail(res, 'Load search index', err);
      }
    });

    app.get('/api/campaigns/:id/events', async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) { res.status(400).json({ error: 'Invalid campaign id' }); return; }
      try {
        const [days, [cr]] = await Promise.all([wqCached(`daily:${id}`, CAMPAIGN_DAILY_SQL, { id }), wqCached(`creative:${id}`, CREATIVE_SQL, { id })]);
        const events: { type: string; from: string; to: string; label: string }[] = [];
        if (cr && Number(cr.creative_delay_days) > 0) {
          events.push({ type: 'creative', from: String(cr.start_date), to: String(cr.creative_date), label: `Creative approved ${cr.creative_delay_days} days late` });
        }
        for (const r of outageRuns(days)) {
          events.push({ type: 'outage', from: r.from, to: r.to, label: `Screen outage · ${Math.round(r.uptime * 100)}% online` });
        }
        res.json(events);
      } catch (err) {
        fail(res, 'Load campaign events', err);
      }
    });

    app.get('/api/campaigns/:id/contract', async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) { res.status(400).json({ error: 'Invalid campaign id' }); return; }
      try {
        const [row] = await wqCached(`contract:${id}`, CONTRACT_SQL, { id });
        res.json(row ?? null);
      } catch (err) {
        fail(res, 'Load contract', err);
      }
    });

    app.get('/api/campaigns/:id/activity', async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) { res.status(400).json({ error: 'Invalid campaign id' }); return; }
      try {
        const c = await campaignById(id);
        if (!c) { res.status(404).json({ error: 'Campaign not found' }); return; }
        const [rebal, mgs, [cr], [ct]] = await Promise.all([
          appkit.lakebase.query(
            `SELECT to_char(date_trunc('minute', created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:00"Z"') AS at, created_by, MAX(reason) AS reason,
                    COUNT(*)::int AS sites, SUM(impressions_reallocated)::int AS net, string_agg(DISTINCT status, ', ') AS statuses
             FROM app_ops.rebalance_actions WHERE campaign_id = $1::int GROUP BY 1, 2 ORDER BY 1 DESC`, [id]),
          appkit.lakebase.query(
            `SELECT make_good_id::int AS id, make_good_type, make_good_value::float8 AS value, status, created_by, approved_by,
                    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
                    to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS approved_at
             FROM app_ops.make_good_log WHERE campaign_id = $1::int ORDER BY created_at DESC`, [id]),
          wqCached(`creative:${id}`, CREATIVE_SQL, { id }),
          wqCached(`contract:${id}`, CONTRACT_SQL, { id }),
        ]);
        const items: { at: string; kind: string; title: string; detail: string; who: string | null }[] = [];
        const t = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
        for (const r of rebal.rows) {
          const net = Number(r.net);
          items.push({ at: t(r.at), kind: 'rebalance', title: `Rebalanced ${t(r.sites)} site(s), net ${net >= 0 ? '+' : ''}${net.toLocaleString('en-US')} a day`, detail: t(r.reason), who: t(r.created_by) || null });
        }
        for (const m of mgs.rows) {
          const id = t(m.id);
          items.push({ at: t(m.at), kind: 'make_good', title: `Make-good #${id} logged · ${t(m.make_good_type).replace('_', ' ')} $${Math.round(Number(m.value)).toLocaleString('en-US')}`, detail: `Status: ${t(m.status)}`, who: t(m.created_by) || null });
          if (m.approved_at) items.push({ at: t(m.approved_at), kind: 'approval', title: `Make-good #${id} approved`, detail: '', who: t(m.approved_by) || null });
        }
        if (cr) {
          items.push({ at: `${cr.start_date}T00:00:00Z`, kind: 'milestone', title: 'Flight started', detail: '', who: null });
          if (Number(cr.creative_delay_days) > 0) items.push({ at: `${cr.creative_date}T00:00:00Z`, kind: 'milestone', title: `Creative approved (${cr.creative_delay_days} days after start)`, detail: 'No impressions run before approval.', who: null });
        }
        if (ct?.uploaded_by && ct.extracted_at) {
          items.push({ at: t(ct.extracted_at), kind: 'contract', title: 'Signed IO uploaded · terms extracted', detail: t(ct.file_name), who: t(ct.uploaded_by) });
        }
        items.sort((a, b) => (a.at < b.at ? 1 : -1));
        res.json(items);
      } catch (err) {
        fail(res, 'Load activity', err);
      }
    });
  });
}

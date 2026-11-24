// Make-Good Tracker routes (finance: approve / fulfil make-goods).
// Reads: Unity Catalog (v_campaign_delivery + dim_contract_terms extracted from the IO PDFs) via governed.ts.
// Writes: Lakebase app_ops.make_good_log + app_ops.campaign_ops_status.
// Shortfall figures are copied from governed data, never typed by the user.

import { z } from 'zod';
import { campaignById, makeGoodCandidates } from './governed';
import type { AppKitWithLakebase } from './ops-db';
import { fail, parseId, userEmail } from './ops-db';

const LIST_SQL = `
  SELECT make_good_id::int AS make_good_id, campaign_id::int AS campaign_id, campaign_name, advertiser,
         shortfall_impressions::float8 AS shortfall_impressions,
         shortfall_dollars::float8 AS shortfall_dollars,
         make_good_type, make_good_value::float8 AS make_good_value,
         contract_clause, notes, created_by, approved_by, status,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS created_at_utc,
         to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS approved_at_utc
  FROM app_ops.make_good_log
  ORDER BY created_at DESC, make_good_id DESC
  LIMIT 200`;

const KPIS_SQL = `
  SELECT (COUNT(*) FILTER (WHERE status = 'submitted'))::int AS pending_approval,
         COALESCE(SUM(make_good_value) FILTER (WHERE status IN ('draft', 'submitted')), 0)::float8 AS open_value,
         COALESCE(SUM(make_good_value) FILTER (WHERE status IN ('approved', 'fulfilled')), 0)::float8 AS committed_value,
         COUNT(*)::int AS total
  FROM app_ops.make_good_log`;

// Campaign values ($2-$5) come from governed data; one statement = one transaction.
const INSERT_SQL = `
  WITH prev AS (
    SELECT o.new_status FROM app_ops.campaign_ops_status o
    WHERE o.campaign_id = $1::int
    ORDER BY o.created_at DESC, o.ops_id DESC
    LIMIT 1
  ), ins AS (
    INSERT INTO app_ops.make_good_log
      (campaign_id, campaign_name, advertiser, shortfall_impressions, shortfall_dollars,
       make_good_type, make_good_value, contract_clause, notes, created_by, status)
    VALUES ($1::int, $2::text, $3::text, $4::int, $5::numeric, $6::text, $7::numeric, $8::text, $9::text, $10::text, 'submitted')
    RETURNING make_good_id, campaign_id, campaign_name
  ), st AS (
    INSERT INTO app_ops.campaign_ops_status
      (campaign_id, campaign_name, previous_status, new_status, action_taken, owner, priority, due_date)
    SELECT campaign_id, campaign_name, (SELECT new_status FROM prev), 'make_good_pending',
           'Make-good #' || make_good_id || ' submitted (' || $6::text || ')', $10::text, 'high', CURRENT_DATE + 7
    FROM ins
    RETURNING ops_id
  )
  SELECT (SELECT make_good_id FROM ins)::int AS make_good_id, (SELECT ops_id FROM st)::int AS ops_id`;

const UPDATE_STATUS_SQL = `
  UPDATE app_ops.make_good_log
  SET status = $2::text,
      approved_by = CASE WHEN $2::text = 'approved' THEN $3::text ELSE approved_by END,
      approved_at = CASE WHEN $2::text = 'approved' THEN now() ELSE approved_at END
  WHERE make_good_id = $1::int AND status = ANY($4::text[])
  RETURNING make_good_id::int AS make_good_id, campaign_id::int AS campaign_id, campaign_name, status, make_good_value::float8 AS make_good_value`;

const FULFILLED_STATUS_SQL = `
  INSERT INTO app_ops.campaign_ops_status
    (campaign_id, campaign_name, previous_status, new_status, action_taken, owner, priority, due_date, updated_at, resolved_at)
  VALUES ($1::int, $2::text, 'make_good_pending', 'make_good_fulfilled', $3::text, $4::text, 'medium', CURRENT_DATE, now(), now())`;

const MakeGoodBody = z.object({
  campaignId: z.number().int().positive(),
  makeGoodType: z.enum(['extension', 'bonus_impressions', 'credit', 'rate_adjustment']),
  makeGoodValue: z.number().min(0).max(10_000_000),
  contractClause: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(1000).optional(),
});

const StatusBody = z.object({ status: z.enum(['approved', 'fulfilled', 'disputed']) });

// Allowed source states for each transition.
const TRANSITIONS: Record<'approved' | 'fulfilled' | 'disputed', string[]> = {
  approved: ['draft', 'submitted'],
  fulfilled: ['approved'],
  disputed: ['submitted', 'approved'],
};

export function registerMakeGoodRoutes(appkit: AppKitWithLakebase): void {
  appkit.server.extend((app) => {
    app.get('/api/make-goods/kpis', async (_req, res) => {
      try {
        const { rows } = await appkit.lakebase.query(KPIS_SQL);
        res.json(rows[0] ?? {});
      } catch (err) {
        fail(res, 'Load make-good KPIs', err);
      }
    });

    app.get('/api/make-goods/candidates', async (_req, res) => {
      try {
        res.json(await makeGoodCandidates());
      } catch (err) {
        fail(res, 'Load make-good candidates', err);
      }
    });

    app.get('/api/make-goods', async (_req, res) => {
      try {
        const { rows } = await appkit.lakebase.query(LIST_SQL);
        res.json(rows);
      } catch (err) {
        fail(res, 'Load make-goods', err);
      }
    });

    app.post('/api/make-goods', async (req, res) => {
      const parsed = MakeGoodBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        return;
      }
      const body = parsed.data;
      try {
        const c = await campaignById(body.campaignId);
        if (!c || Number(c.shortfall_dollars) <= 0) {
          res.status(404).json({ error: 'Campaign not found or has no shortfall' });
          return;
        }
        const { rows } = await appkit.lakebase.query(INSERT_SQL, [
          body.campaignId,
          String(c.campaign_name),
          String(c.advertiser),
          Math.round(Number(c.shortfall_impressions)),
          Number(c.shortfall_dollars),
          body.makeGoodType,
          body.makeGoodValue,
          body.contractClause || null,
          body.notes || null,
          userEmail(req),
        ]);
        res.status(201).json(rows[0]);
      } catch (err) {
        fail(res, 'Log make-good', err);
      }
    });

    app.patch('/api/make-goods/:id/status', async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        res.status(400).json({ error: 'Invalid make-good id' });
        return;
      }
      const parsed = StatusBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'status must be approved, fulfilled or disputed' });
        return;
      }
      const next = parsed.data.status;
      const email = userEmail(req);
      try {
        const { rows } = await appkit.lakebase.query(UPDATE_STATUS_SQL, [id, next, email, TRANSITIONS[next]]);
        const updated = rows[0];
        if (!updated) {
          res.status(409).json({ error: `Make-good #${id} cannot move to ${next} from its current status` });
          return;
        }
        if (next === 'fulfilled') {
          await appkit.lakebase.query(FULFILLED_STATUS_SQL, [
            Number(updated.campaign_id),
            String(updated.campaign_name),
            `Make-good #${id} fulfilled`,
            email,
          ]);
        }
        res.json(updated);
      } catch (err) {
        fail(res, 'Update make-good', err);
      }
    });
  });
}

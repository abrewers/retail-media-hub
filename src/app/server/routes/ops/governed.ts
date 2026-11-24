// Governed reads from Unity Catalog. Business rules (shortfall, pace, risk) live in the
// v_campaign_delivery view and the metric views; this file only selects from them.

import { type Row, wq, wqCached } from './warehouse';

export const CAMPAIGNS_SQL = `
  SELECT campaign_id, campaign_name, advertiser, region, channel, status,
         CAST(contracted_impressions AS DOUBLE) AS contracted_impressions,
         CAST(delivered_impressions AS DOUBLE) AS delivered_impressions,
         CAST(shortfall_impressions AS DOUBLE) AS shortfall_impressions,
         CAST(shortfall_dollars AS DOUBLE) AS shortfall_dollars,
         CAST(delivery_rate_pct AS DOUBLE) AS delivery_rate_pct,
         CAST(pace_adjusted_pct AS DOUBLE) AS pace_adjusted_pct,
         days_remaining, risk_level, CAST(cpm_rate AS DOUBLE) AS cpm_rate,
         CAST(start_date AS STRING) AS start_date, CAST(end_date AS STRING) AS end_date,
         elapsed_days, flight_days
  FROM v_campaign_delivery`;

/** All campaigns (about 50 rows), cached. Filtering, sorting and paging happen in the route. */
export const campaigns = (): Promise<Row[]> => wqCached('campaigns', CAMPAIGNS_SQL);

export async function campaignById(id: number): Promise<Row | undefined> {
  return (await campaigns()).find((c) => c.campaign_id === id);
}

/** Active-campaign KPIs, straight from the governed metric view. */
export async function kpis(): Promise<Row> {
  const [r] = await wqCached(
    'kpis',
    `SELECT MEASURE(\`Campaign Count\`) AS active_campaigns,
            CAST(MEASURE(\`Shortfall Dollars\`) AS DOUBLE) AS shortfall_dollars,
            MEASURE(\`Campaigns At Risk\`) AS at_risk,
            MEASURE(\`Campaigns Over-Delivering\`) AS over_delivering
     FROM metric_view_campaign_delivery WHERE \`Campaign Status\` = 'active'`,
  );
  const [cfg] = await wqCached('asof', 'SELECT CAST(as_of_date AS STRING) AS as_of_date FROM cfg_demo_config LIMIT 1');
  return { ...r, snapshot_at: (cfg?.as_of_date as string) ?? null };
}

export function pacing(id: number): Promise<Row[]> {
  return wqCached(
    `pacing:${id}`,
    `WITH c AS (SELECT * FROM v_campaign_delivery WHERE campaign_id = :id),
     days AS (SELECT explode(sequence(c.start_date, LEAST(c.end_date, date_sub(c.as_of_date, 1)))) AS d
              FROM c WHERE c.start_date < c.as_of_date),
     i AS (SELECT impression_date, SUM(impressions) AS n FROM v_campaign_site_daily WHERE campaign_id = :id GROUP BY 1)
     SELECT CAST(days.d AS STRING) AS date,
            CAST(SUM(COALESCE(i.n, 0)) OVER (ORDER BY days.d) AS DOUBLE) AS cumulative_delivered,
            CAST(ROUND(c.contracted_impressions * DATEDIFF(days.d, c.start_date) / c.flight_days) AS DOUBLE) AS cumulative_target
     FROM days CROSS JOIN c LEFT JOIN i ON i.impression_date = days.d
     ORDER BY days.d`,
    { id },
  );
}

/** Sites serving a campaign, weakest first (the order the Suggest-plan rule expects). */
export function campaignSites(id: number): Promise<Row[]> {
  return wqCached(
    `sites:${id}`,
    `SELECT site_id, site_name, city, state, archetype, MAX(pump_count) AS pump_count,
            CAST(SUM(impressions) AS DOUBLE) AS delivered_impressions,
            COUNT(DISTINCT impression_date) AS active_days,
            CAST(ROUND(SUM(impressions) / COUNT(DISTINCT impression_date)) AS INT) AS avg_daily_impressions
     FROM v_campaign_site_daily WHERE campaign_id = :id
     GROUP BY ALL
     ORDER BY avg_daily_impressions ASC, site_id`,
    { id },
  );
}

/** Campaigns with a shortfall, with contract terms extracted from the IO PDFs (if any). */
export async function makeGoodCandidates(): Promise<Record<string, unknown>[]> {
  const rows = await wqCached(
    'candidates',
    `WITH stores AS (
       SELECT campaign_id,
              to_json(sort_array(collect_set(named_struct('name', site_name, 'city', city, 'state', state)))) AS stores
       FROM v_campaign_site_daily GROUP BY campaign_id),
     p AS (
       SELECT c.*,
              c.delivered_impressions / GREATEST(c.elapsed_days, 1) AS current_daily_rate,
              CASE WHEN c.days_remaining > 0 THEN c.shortfall_impressions / c.days_remaining END AS required_daily_rate
       FROM v_campaign_delivery c WHERE c.shortfall_dollars > 0)
     SELECT p.campaign_id, p.campaign_name, p.advertiser, p.region, p.status, p.risk_level, st.stores,
            CAST(p.shortfall_dollars AS DOUBLE) AS shortfall_dollars,
            CAST(p.shortfall_impressions AS DOUBLE) AS shortfall_impressions,
            p.days_remaining, CAST(p.delivery_rate_pct AS DOUBLE) AS delivery_rate_pct,
            CAST(p.current_daily_rate AS DOUBLE) AS current_daily_rate,
            CAST(p.required_daily_rate AS DOUBLE) AS required_daily_rate,
            t.makegood_clause_summary AS contract_clause,
            CAST(t.makegood_threshold_pct AS INT) AS makegood_threshold,
            t.source_file,
            CASE
              WHEN p.status = 'completed' OR p.days_remaining <= 0 THEN 'credit'
              WHEN p.days_remaining <= 5 THEN 'rate_adjustment'
              WHEN p.required_daily_rate IS NULL OR p.current_daily_rate IS NULL
                   OR p.required_daily_rate <= p.current_daily_rate THEN 'extension'
              ELSE 'bonus_impressions'
            END AS recommended_type,
            CAST(p.shortfall_dollars AS DOUBLE) AS recommended_value
     FROM p LEFT JOIN dim_contract_terms t ON t.campaign_id = p.campaign_id
            LEFT JOIN stores st ON st.campaign_id = p.campaign_id
     ORDER BY (p.status = 'completed') DESC, p.shortfall_dollars DESC`,
  );
  // stores arrives as a JSON string; parse it so the client can search by store name, city or state.
  return rows.map((r) => ({ ...r, stores: r.stores ? (JSON.parse(String(r.stores)) as unknown[]) : [] }));
}

export { wq };

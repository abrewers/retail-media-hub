// Response shapes of the app's /api routes (see server/routes/ops/*).

export interface CampaignKpis {
  active_campaigns: number;
  shortfall_dollars: number;
  at_risk: number;
  over_delivering: number;
  snapshot_at: string | null;
}

export interface Campaign {
  campaign_id: number;
  campaign_name: string;
  advertiser: string;
  region: string;
  channel: string;
  status: string;
  contracted_impressions: number;
  delivered_impressions: number;
  shortfall_impressions: number;
  shortfall_dollars: number;
  delivery_rate_pct: number | null;
  pace_adjusted_pct: number | null;
  days_remaining: number;
  risk_level: string;
  ops_status: string | null;
  ops_priority: string | null;
}

export interface CampaignPage {
  rows: Campaign[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CampaignDetail extends Campaign {
  cpm_rate: number;
  start_date: string;
  end_date: string;
  ops_owner: string | null;
  ops_action: string | null;
}

export interface PacingPoint {
  date: string;
  cumulative_delivered: number;
  cumulative_target: number;
}

export interface SiteRow {
  site_id: number;
  site_name: string;
  city: string;
  state: string;
  archetype: string;
  pump_count: number;
  delivered_impressions: number;
  active_days: number;
  avg_daily_impressions: number;
  current_target: number;
  last_action_status: string | null;
}

export interface RebalanceAction {
  action_id: number;
  site_id: number;
  site_name: string;
  previous_daily_target: number | null;
  new_daily_target: number;
  impressions_reallocated: number;
  action_type: string;
  reason: string | null;
  created_by: string;
  status: string;
  created_at_utc: string;
}

export interface MakeGood {
  make_good_id: number;
  campaign_id: number;
  campaign_name: string;
  advertiser: string;
  shortfall_impressions: number;
  shortfall_dollars: number;
  make_good_type: string;
  make_good_value: number | null;
  contract_clause: string | null;
  notes: string | null;
  created_by: string;
  approved_by: string | null;
  status: string;
  created_at_utc: string;
  approved_at_utc: string | null;
}

export interface MakeGoodKpis {
  pending_approval: number;
  open_value: number;
  committed_value: number;
  total: number;
}

export interface CampaignStore {
  name: string;
  city: string;
  state: string;
}

export interface MakeGoodCandidate {
  campaign_id: number;
  campaign_name: string;
  advertiser: string;
  region: string;
  stores: CampaignStore[];
  status: string;
  risk_level: string;
  shortfall_dollars: number;
  shortfall_impressions: number;
  days_remaining: number;
  delivery_rate_pct: number | null;
  current_daily_rate: number | null;
  required_daily_rate: number | null;
  contract_clause: string | null;
  makegood_threshold: number | null;
  source_file: string | null;
  recommended_type: string;
  recommended_value: number;
}

// ---- Ops Console additions (server/routes/ops/insight-routes.ts) ----
export type Recommendation = 'rebalance' | 'make_good' | 'on_track' | 'over_delivering' | 'none';

export interface NeedsAction extends Campaign {
  cpm_rate: number;
  net_daily: number;
  recovered_usd: number;
  recovered_pct: number;
  recommendation: Recommendation;
}

export interface RegionWeek {
  week: string;
  region: string;
  uptime_pct: number;
  lost_impressions: number;
  impressions: number;
}

export interface ArchetypeRow {
  archetype: string;
  transactions_per_day: number;
  impressions_per_day: number;
  uptime_pct: number;
}

export interface Outage {
  region: string;
  sites: number;
  start_date: string;
  end_date: string;
  uptime_pct: number;
  lost_impressions: number;
  campaigns: number;
}

export interface CampaignEvent {
  type: 'outage' | 'creative';
  from: string;
  to: string;
  label: string;
}

export interface ContractTerms {
  makegood_threshold_pct: number | null;
  makegood_window_days: number | null;
  credit_option_shortfall_pct: number | null;
  makegood_clause_summary: string | null;
  excess_shortfall_remedy: string | null;
  special_terms: string | null;
  makegood_policy_text: string | null;
  io_number: string | null;
  advertiser_legal_name: string | null;
  file_name: string | null;
  /** True when the PDF was uploaded in the app (it can be removed and re-uploaded). */
  uploaded: boolean;
  uploaded_by: string | null;
  extracted_at: string | null;
}

export interface ActivityItem {
  at: string;
  kind: 'rebalance' | 'make_good' | 'approval' | 'milestone';
  title: string;
  detail: string;
  who: string | null;
}

export interface SearchItem {
  campaign_id: number;
  campaign_name: string;
  advertiser: string;
  region: string;
  status: string;
  risk_level: string;
  shortfall_dollars: number;
  stores: CampaignStore[];
}

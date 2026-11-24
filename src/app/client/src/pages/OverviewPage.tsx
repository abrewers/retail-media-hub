// Overview: what needs a decision today, and why delivery moved.
import { useNavigate } from 'react-router';
import { fmt, useFetch } from '../lib/api';
import type { ArchetypeRow, CampaignKpis, NeedsAction, Outage, RegionWeek } from '../lib/types';
import { HBars, RegionChart, Sparkline } from '../components/charts';
import { Notice, RiskBadge, Skel, useGenie, useRefresh } from '../components/ox';

const shortDate = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function firstName(email: string | undefined): string {
  if (!email) return '';
  const n = email.split('@')[0].split(/[._-]/)[0];
  return n ? n[0].toUpperCase() + n.slice(1) : '';
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function ActionButton({ c }: { c: NeedsAction }) {
  const navigate = useNavigate();
  if (c.recommendation === 'rebalance') {
    return (
      <button type="button" className="ox-btn ox-btn-primary" onClick={(e) => { e.stopPropagation(); void navigate(`/campaigns/${c.campaign_id}?rebalance=1`); }}>
        Rebalance now · recovers ~{c.recovered_usd < 1000 ? fmt.usd(c.recovered_usd) : fmt.usdCompact(c.recovered_usd)}
      </button>
    );
  }
  if (c.recommendation === 'make_good') {
    return (
      <button type="button" className="ox-btn ox-btn-warn" onClick={(e) => { e.stopPropagation(); void navigate(`/make-goods?new=${c.campaign_id}`); }}>
        Prepare make-good
      </button>
    );
  }
  return null;
}

export function OverviewPage() {
  const { key } = useRefresh();
  const navigate = useNavigate();
  const genie = useGenie();
  const me = useFetch<{ email: string }>('/api/me');
  const kpis = useFetch<CampaignKpis>('/api/campaigns/kpis', key);
  const actions = useFetch<NeedsAction[]>('/api/overview/needs-action', key);
  const sparks = useFetch<Record<string, number[]>>('/api/campaigns/sparklines');
  const region = useFetch<RegionWeek[]>('/api/overview/region-weekly');
  const arch = useFetch<ArchetypeRow[]>('/api/overview/archetypes');
  const insights = useFetch<{ outages: Outage[] }>('/api/overview/insights');
  const k = kpis.data;
  const name = firstName(me.data?.email);
  const outage = insights.data?.outages[0];
  const critical = (actions.data ?? []).filter((a) => a.risk_level === 'Critical').length;

  return (
    <>
      <div className="ox-page-h">
        <div>
          <h1 className="ox-h1">{greeting()}{name ? `, ${name}` : ''}</h1>
          <p className="ox-muted">
            {actions.data ? `${actions.data.length} campaign${actions.data.length === 1 ? '' : 's'} need a decision today.` : 'Loading today’s campaigns…'}
            {k?.snapshot_at ? ` Data as of ${shortDate(k.snapshot_at)}.` : ''}
          </p>
        </div>
      </div>

      {kpis.error && <Notice>Campaign metrics unavailable: {kpis.error}</Notice>}
      <div className="ox-kpis">
        {[
          ['Active campaigns', k ? fmt.num(k.active_campaigns) : null, '', ''],
          ['Make-good exposure', k ? fmt.usdCompact(k.shortfall_dollars) : null, 'if every campaign ended today', 'accent'],
          ['At risk', k ? fmt.num(k.at_risk) : null, actions.data ? `${critical} critical · pace below 85%` : 'pace below 85%', 'serious'],
          ['Over-delivering', k ? fmt.num(k.over_delivering) : null, 'pace above 110%', ''],
        ].map(([label, value, sub, cls]) => (
          <div key={label} className={`ox-kpi ${cls}`}>
            <div className="ox-kpi-l">{label}</div>
            <div className="ox-kpi-v">{value ?? <Skel h={34} w={90} style={{ marginTop: 4 }} />}</div>
            <div className="ox-kpi-s">{sub}</div>
          </div>
        ))}
      </div>

      <div className="ox-two">
        <section>
          <div className="ox-section-h"><h2 className="ox-h2">Needs action today</h2><span className="ox-muted ox-small">soonest deadline first</span></div>
          {actions.error && <Notice>Needs-action list unavailable: {actions.error}</Notice>}
          <div className="ox-actions">
            {!actions.data && !actions.error && [0, 1, 2, 3].map((i) => <Skel key={i} h={176} />)}
            {actions.data?.map((c) => (
              <article
                key={c.campaign_id}
                className="ox-action"
                role="link"
                tabIndex={0}
                aria-label={`Open ${c.campaign_name}`}
                onClick={() => void navigate(`/campaigns/${c.campaign_id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter') void navigate(`/campaigns/${c.campaign_id}`); }}
              >
                <div className="ox-action-top"><RiskBadge risk={c.risk_level} /><span className={`ox-days ${c.days_remaining <= 5 ? 'hot' : ''}`}>{c.days_remaining} days left</span></div>
                <h3 className="ox-h3">{c.campaign_name}</h3>
                <div className="ox-meta">{c.advertiser} · {c.region}</div>
                <div className="ox-action-mid">
                  <div><span className="ox-mini-l">Delivered</span><b>{fmt.pct(c.delivery_rate_pct)}</b></div>
                  <div><span className="ox-mini-l">Pace</span><b>{fmt.pct(c.pace_adjusted_pct)}</b></div>
                  <div><span className="ox-mini-l">Shortfall</span><b>{fmt.usd(c.shortfall_dollars)}</b></div>
                  <Sparkline values={sparks.data?.[String(c.campaign_id)]} />
                </div>
                <ActionButton c={c} />
              </article>
            ))}
            {actions.data?.length === 0 && <div className="ox-panel ox-empty">Nothing at risk. Every active campaign is on pace.</div>}
          </div>
        </section>

        <aside className="ox-stack">
          <div className="ox-panel">
            <div className="ox-panel-h"><h2 className="ox-h2">Screen uptime by region</h2><span className="ox-muted ox-small">weekly</span></div>
            {region.data ? <RegionChart rows={region.data} /> : region.error ? <Notice>{region.error}</Notice> : <Skel h={220} />}
          </div>
          {outage && (
            <div className="ox-insight">
              <div className="ox-insight-k">Why delivery dipped</div>
              <p>
                <b>{outage.region} screens were mostly offline {shortDate(outage.start_date)} to {shortDate(outage.end_date)}</b> at {outage.sites} sites
                (about {Math.round(outage.uptime_pct)}% online). It cost about {fmt.numCompact(outage.lost_impressions)} impressions across {outage.campaigns} campaigns.
              </p>
              <button type="button" className="ox-link" onClick={() => genie.open(`Why did delivery drop in the ${outage.region} region?`)}>Ask Genie why →</button>
            </div>
          )}
          <div className="ox-panel">
            <div className="ox-panel-h"><h2 className="ox-h2">Traffic by site type</h2><span className="ox-muted ox-small">fuel transactions per site per day</span></div>
            {arch.data ? (
              <HBars items={arch.data.map((a) => ({ label: a.archetype, value: a.transactions_per_day, alt: a.archetype === 'suburban' }))} />
            ) : arch.error ? <Notice>{arch.error}</Notice> : <Skel h={90} />}
            <p className="ox-muted ox-small" style={{ margin: '8px 0 0' }}>Low-traffic sites under-deliver; rebalancing moves delivery to where the traffic is.</p>
          </div>
        </aside>
      </div>
    </>
  );
}

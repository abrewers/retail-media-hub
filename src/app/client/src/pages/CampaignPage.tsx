// Campaign detail: headline numbers, pacing with data-detected events, sites, contract and activity.
import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { fmt, readError, useFetch } from '../lib/api';
import { useAppConfig } from '../lib/config';
import type { ActivityItem, CampaignDetail, CampaignEvent, ContractTerms, PacingPoint, SiteRow } from '../lib/types';
import { HBars, PacingChart } from '../components/charts';
import { RebalanceDrawer } from '../components/RebalanceDrawer';
import { ContractUpload } from '../components/ContractUpload';
import { Notice, RiskBadge, Skel, StatusBadge, useGenie, useRefresh, useToast } from '../components/ox';

const shortDate = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const when = (s: string) => new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
type Tab = 'pacing' | 'sites' | 'contract' | 'activity';

export function CampaignPage() {
  const { id } = useParams();
  const cid = Number(id);
  const valid = Number.isInteger(cid) && cid > 0;
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (['pacing', 'sites', 'contract', 'activity'].includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'pacing'));
  const navigate = useNavigate();
  const genie = useGenie();
  const toast = useToast();
  const { key, bump } = useRefresh();
  const config = useAppConfig();
  const [contractKey, setContractKey] = useState(0);
  const [removing, setRemoving] = useState(false);

  const detail = useFetch<CampaignDetail>(valid ? `/api/campaigns/${cid}` : null, key);
  const pacing = useFetch<PacingPoint[]>(valid ? `/api/campaigns/${cid}/pacing` : null);
  const events = useFetch<CampaignEvent[]>(valid ? `/api/campaigns/${cid}/events` : null);
  const sites = useFetch<SiteRow[]>(valid ? `/api/campaigns/${cid}/sites` : null, key);
  const contract = useFetch<ContractTerms | null>(valid && tab === 'contract' ? `/api/campaigns/${cid}/contract` : null, contractKey + key);
  const activity = useFetch<ActivityItem[]>(valid && tab === 'activity' ? `/api/campaigns/${cid}/activity` : null, key);
  const rebalanceOpen = params.get('rebalance') === '1';
  const onUploaded = useCallback((msg: string) => { setContractKey((k) => k + 1); bump(); toast(msg); }, [bump, toast]);

  if (!valid) return <Notice>Invalid campaign id.</Notice>;
  const c = detail.data;
  const atRisk = c?.risk_level === 'Critical' || c?.risk_level === 'At Risk';
  const siteRows = sites.data ?? [];
  const mix = ['urban', 'highway', 'suburban'].map((a) => ({ label: a, value: siteRows.filter((s) => s.archetype === a).length, alt: a === 'suburban' }));
  const removeUpload = async () => {
    if (!window.confirm('Remove the uploaded IO and its extracted terms? You can upload it again afterwards.')) return;
    setRemoving(true);
    try {
      const r = await fetch(`/api/campaigns/${cid}/contract`, { method: 'DELETE' });
      if (!r.ok) throw new Error(await readError(r));
      setContractKey((k) => k + 1); bump(); toast('Uploaded IO removed');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(false);
    }
  };
  const setRebalance = (open: boolean) => { const p = new URLSearchParams(params); if (open) p.set('rebalance', '1'); else p.delete('rebalance'); setParams(p, { replace: true }); };

  return (
    <>
      <Link to="/campaigns" className="ox-back">← Campaigns</Link>
      {detail.error && <Notice>Campaign unavailable: {detail.error}</Notice>}
      {!c && !detail.error ? <Skel h={96} /> : c && (
        <>
          <div className="ox-detail-h">
            <div>
              <div className="ox-badges">
                <RiskBadge risk={c.risk_level} />
                <span className="ox-pill">{c.advertiser}</span>
                <span className="ox-pill">{c.region}</span>
                <span className="ox-pill">{fmt.label(c.channel)}</span>
                <span className="ox-pill">{shortDate(c.start_date)} → {shortDate(c.end_date)}</span>
                {c.ops_status && <StatusBadge status={c.ops_status} />}
              </div>
              <h1 className="ox-h1">{c.campaign_name}</h1>
            </div>
            <div className="ox-detail-acts">
              <button type="button" className="ox-btn ox-btn-ghost" onClick={() => genie.open(atRisk ? `Why is ${c.campaign_name} behind pace?` : `How is ${c.campaign_name} delivering?`)}>✦ Ask why</button>
              {c.status === 'active' && (
                <button type="button" className="ox-btn ox-btn-primary" onClick={() => setRebalance(true)} disabled={siteRows.length === 0}>Rebalance</button>
              )}
              {c.shortfall_dollars > 0 && (
                <button type="button" className="ox-btn ox-btn-warn" onClick={() => void navigate(`/make-goods?new=${c.campaign_id}`)}>Prepare make-good</button>
              )}
            </div>
          </div>

          <div className="ox-stats">
            <div><span>Delivered</span><b>{fmt.pct(c.delivery_rate_pct)}</b><small>{fmt.numCompact(c.delivered_impressions)} of {fmt.numCompact(c.contracted_impressions)}</small></div>
            <div><span>Pace</span><b>{fmt.pct(c.pace_adjusted_pct)}</b><small>vs where it should be today</small></div>
            <div><span>Days left</span><b>{c.days_remaining > 0 ? c.days_remaining : 'Ended'}</b><small>CPM ${c.cpm_rate.toFixed(2)}</small></div>
            <div><span>Shortfall</span><b>{fmt.usd(c.shortfall_dollars)}</b><small>{fmt.numCompact(c.shortfall_impressions)} impressions</small></div>
          </div>
          {c.ops_action && <p className="ox-muted ox-small" style={{ marginTop: -8 }}>Latest action: {c.ops_action}{c.ops_owner ? ` · ${c.ops_owner}` : ''}</p>}
        </>
      )}

      <div className="ox-tabs" role="tablist">
        {([['pacing', 'Pacing'], ['sites', `Sites${sites.data ? ` (${siteRows.length})` : ''}`], ['contract', 'Contract'], ['activity', 'Activity']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`ox-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'pacing' && (
        <div className="ox-panel">
          {pacing.error && <Notice>Pacing unavailable: {pacing.error}</Notice>}
          {pacing.data ? <PacingChart points={pacing.data} events={events.data ?? []} /> : !pacing.error && <Skel h={300} />}
          <p className="ox-muted ox-small" style={{ margin: '8px 0 0' }}>
            {(events.data ?? []).length > 0 ? 'Shaded bands mark events found in the data: screen outages and late creative approval.' : 'No outages or late creative found for this campaign.'}
          </p>
        </div>
      )}

      {tab === 'sites' && (
        <div className="ox-two">
          <div className="ox-panel ox-table-panel">
            {sites.error && <Notice>Sites unavailable: {sites.error}</Notice>}
            <table className="ox-table compact">
              <thead><tr><th>Site</th><th>Type</th><th className="ox-r">Impressions per day</th><th className="ox-r">Daily target</th><th>Last action</th></tr></thead>
              <tbody>
                {!sites.data && !sites.error && <tr><td colSpan={5}><Skel h={22} /></td></tr>}
                {[...siteRows].sort((a, b) => b.avg_daily_impressions - a.avg_daily_impressions).map((s) => (
                  <tr key={s.site_id}>
                    <td><b>{s.site_name}</b><div className="ox-meta">{s.city}, {s.state} · {s.pump_count} pumps</div></td>
                    <td className="ox-cap">{s.archetype}</td>
                    <td className="ox-r">{fmt.num(s.avg_daily_impressions)}</td>
                    <td className="ox-r">{fmt.num(s.current_target)}</td>
                    <td><StatusBadge status={s.last_action_status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ox-panel">
            <div className="ox-panel-h"><h2 className="ox-h2">Site mix</h2><span className="ox-muted ox-small">sites in the plan</span></div>
            <HBars items={mix} />
            <p className="ox-muted ox-small" style={{ margin: '8px 0 0' }}>Plans that lean on low-traffic suburban sites under-deliver. Rebalancing moves daily targets to urban and highway sites.</p>
          </div>
        </div>
      )}

      {tab === 'contract' && (
        <div className="ox-panel">
          {contract.loading && <Skel h={120} />}
          {contract.error && <Notice>Contract unavailable: {contract.error}</Notice>}
          {!contract.loading && !contract.error && (contract.data ? (
            <>
              <div className="ox-mono ox-small ox-muted">📄 {contract.data.file_name}{contract.data.io_number ? ` · ${contract.data.io_number}` : ''}</div>
              <blockquote className="ox-quote">{contract.data.makegood_clause_summary}</blockquote>
              <div className="ox-stats three">
                <div><span>Make-good owed below</span><b>{contract.data.makegood_threshold_pct ?? '—'}%</b><small>of contracted impressions</small></div>
                <div><span>Delivery window</span><b>{contract.data.makegood_window_days ?? '—'} days</b><small>after flight end</small></div>
                <div><span>Credit option</span><b>{contract.data.credit_option_shortfall_pct ?? '—'}%+</b><small>shortfall</small></div>
              </div>
              {contract.data.special_terms && <p style={{ margin: '0 0 8px' }}><b>Special terms:</b> {contract.data.special_terms}</p>}
              {contract.data.excess_shortfall_remedy && <p style={{ margin: '0 0 8px' }}><b>Remedy above the credit threshold:</b> {contract.data.excess_shortfall_remedy}</p>}
              <div className="ox-row-between">
                <p className="ox-muted ox-small" style={{ margin: 0 }}>
                  Extracted from the signed IO with ai_parse_document and ai_extract
                  {contract.data.uploaded && contract.data.uploaded_by ? ` · uploaded by ${contract.data.uploaded_by}${contract.data.extracted_at ? ` on ${when(contract.data.extracted_at)}` : ''}` : ''}.
                </p>
                {contract.data.uploaded && <button type="button" className="ox-btn ox-btn-danger ox-btn-sm" disabled={removing} onClick={() => void removeUpload()}>{removing ? 'Removing…' : 'Remove uploaded IO'}</button>}
              </div>
            </>
          ) : (
            config.data?.contractUpload
              ? <ContractUpload campaignId={cid} sample={config.data.sampleIoCampaigns.includes(cid)} onDone={onUploaded} />
              : <div className="ox-empty">No signed IO on file for this campaign. Drop the PDF into the contracts volume and re-run setup.</div>
          ))}
        </div>
      )}

      {tab === 'activity' && (
        <div className="ox-panel">
          {activity.error && <Notice>Activity unavailable: {activity.error}</Notice>}
          {!activity.data && !activity.error && <Skel h={120} />}
          {activity.data && (activity.data.length === 0 ? <div className="ox-empty">No activity yet.</div> : (
            <ol className="ox-timeline">
              {activity.data.map((a) => (
                <li key={`${a.at}-${a.title}`}>
                  <span className={`ox-dot ${a.kind}`} aria-hidden="true" />
                  <div><b>{a.title}</b><div className="ox-meta">{when(a.at)}{a.who ? ` · ${a.who}` : ''}</div>{a.detail && <div className="ox-small" style={{ marginTop: 2 }}>{a.detail}</div>}</div>
                </li>
              ))}
            </ol>
          ))}
        </div>
      )}

      {rebalanceOpen && c && sites.data && (
        <RebalanceDrawer
          campaign={c}
          sites={siteRows}
          onClose={() => setRebalance(false)}
          onLogged={(msg) => { setRebalance(false); setTab('activity'); bump(); toast(msg); }}
        />
      )}
    </>
  );
}

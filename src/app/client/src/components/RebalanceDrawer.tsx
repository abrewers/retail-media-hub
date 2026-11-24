// Rebalance planner: edit daily site targets (or start from the suggested plan), see the projected
// recovery update live, review, then log every change to Lakebase in one transaction.
import { useMemo, useState } from 'react';
import { fmt, sendJson } from '../lib/api';
import { suggestTargets } from '../lib/rebalance';
import type { CampaignDetail, SiteRow } from '../lib/types';
import { Drawer, Notice, StatusBadge } from './ox';

function parseTarget(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
}

export function RebalanceDrawer({ campaign: c, sites, onClose, onLogged }: { campaign: CampaignDetail; sites: SiteRow[]; onClose: () => void; onLogged: (msg: string) => void }) {
  const [targets, setTargets] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ordered = useMemo(() => [...sites].sort((a, b) => b.avg_daily_impressions - a.avg_daily_impressions), [sites]);
  const invalid = sites.some((s) => Number.isNaN(parseTarget(targets[s.site_id])));
  const changes = sites.flatMap((s) => {
    const n = parseTarget(targets[s.site_id]);
    return n === null || Number.isNaN(n) || n === s.current_target ? [] : [{ site: s, next: n }];
  });
  const net = changes.reduce((t, ch) => t + ch.next - ch.site.current_target, 0);
  const days = Math.max(c.days_remaining, 0);
  const recImp = Math.min(Math.max(net * days, 0), Math.max(c.shortfall_impressions, 0));
  const recUsd = (recImp * c.cpm_rate) / 1000;
  const recPct = c.shortfall_dollars > 0 ? (recUsd / c.shortfall_dollars) * 100 : 0;
  const canReview = changes.length > 0 && !invalid && reason.trim().length >= 3 && c.status === 'active';

  const suggest = () => {
    // sites must be weakest first for the shared Suggest-plan rule
    const weakestFirst = [...sites].sort((a, b) => a.avg_daily_impressions - b.avg_daily_impressions || a.site_id - b.site_id);
    const next: Record<number, string> = {};
    suggestTargets(weakestFirst).forEach((t, id) => { next[id] = String(t); });
    setTargets(next);
    if (!reason.trim()) setReason('Shift delivery from low-traffic sites to high-traffic sites before flight end');
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await sendJson<{ actions_logged: number; ops_id: number }>(`/api/campaigns/${c.campaign_id}/rebalance`, 'POST', {
        reason: reason.trim(),
        changes: changes.map((ch) => ({ siteId: ch.site.site_id, newDailyTarget: ch.next })),
      });
      onLogged(`Rebalance logged · ${r.actions_logged} site target${r.actions_logged === 1 ? '' : 's'} updated`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReview(false);
    } finally {
      setBusy(false);
    }
  };

  const footer = review ? (
    <>
      <button type="button" className="ox-btn ox-btn-ghost" onClick={() => setReview(false)} disabled={busy}>Back to edit</button>
      <button type="button" className="ox-btn ox-btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? 'Logging…' : 'Confirm and log'}</button>
    </>
  ) : (
    <>
      <button type="button" className="ox-btn ox-btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="ox-btn ox-btn-primary" onClick={() => setReview(true)} disabled={!canReview}>{changes.length ? `Review ${changes.length} change${changes.length === 1 ? '' : 's'}` : 'Review changes'}</button>
    </>
  );

  return (
    <Drawer title={`Rebalance ${c.campaign_name}`} onClose={onClose} footer={footer} width={640}>
      {c.status !== 'active' && <Notice>Only active campaigns can be rebalanced.</Notice>}
      {error && <Notice>{error}</Notice>}
      <div className="ox-meter">
        <div className="ox-meter-l">Projected recovery</div>
        <div className="ox-meter-v">{fmt.usd(recUsd)}</div>
        <div className="ox-meter-bar"><span style={{ width: `${Math.min(recPct, 100)}%` }} /></div>
        <div className="ox-muted ox-small">
          {recPct.toFixed(1)}% of the {fmt.usd(c.shortfall_dollars)} shortfall over {days} day{days === 1 ? '' : 's'} · net {net > 0 ? '+' : ''}{fmt.num(net)} impressions a day
        </div>
      </div>

      {review ? (
        <>
          <h3 className="ox-h3">{changes.length} site change{changes.length === 1 ? '' : 's'}</h3>
          <table className="ox-table compact">
            <thead><tr><th>Site</th><th className="ox-r">Now</th><th className="ox-r">New</th><th className="ox-r">Change</th></tr></thead>
            <tbody>
              {changes.sort((a, b) => (b.next - b.site.current_target) - (a.next - a.site.current_target)).map((ch) => (
                <tr key={ch.site.site_id}>
                  <td><b>{ch.site.site_name}</b><div className="ox-meta ox-cap">{ch.site.archetype}</div></td>
                  <td className="ox-r">{fmt.num(ch.site.current_target)}</td>
                  <td className="ox-r"><b>{fmt.num(ch.next)}</b></td>
                  <td className={`ox-r ${ch.next > ch.site.current_target ? 'ox-up' : 'ox-down'}`}>{fmt.signed(ch.next - ch.site.current_target)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ox-field">Reason<div style={{ color: 'var(--ox-text)', fontWeight: 500 }}>{reason}</div></div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="ox-btn ox-btn-ghost ox-btn-sm" onClick={suggest} disabled={c.status !== 'active'}>Suggest plan</button>
            <button type="button" className="ox-btn ox-btn-ghost ox-btn-sm" onClick={() => setTargets({})} disabled={Object.keys(targets).length === 0}>Clear</button>
            <span className="ox-muted ox-small">Suggested plan: top sites +40%, weakest sites −50%.</span>
          </div>
          <table className="ox-table compact">
            <thead><tr><th>Site</th><th className="ox-r">Per day</th><th className="ox-r">Target</th><th className="ox-r">New target</th></tr></thead>
            <tbody>
              {ordered.map((s) => {
                const v = targets[s.site_id] ?? '';
                const bad = Number.isNaN(parseTarget(v));
                return (
                  <tr key={s.site_id}>
                    <td><b>{s.site_name}</b><div className="ox-meta"><span className="ox-cap">{s.archetype}</span> · {s.city}, {s.state} {s.last_action_status && <StatusBadge status={s.last_action_status} />}</div></td>
                    <td className="ox-r">{fmt.num(s.avg_daily_impressions)}</td>
                    <td className="ox-r">{fmt.num(s.current_target)}</td>
                    <td className="ox-r">
                      <input
                        className="ox-input ox-input-num"
                        inputMode="numeric"
                        aria-label={`New daily target for ${s.site_name}`}
                        aria-invalid={bad}
                        style={bad ? { borderColor: 'var(--ox-critical)' } : undefined}
                        placeholder={String(s.current_target)}
                        value={v}
                        onChange={(e) => setTargets((t) => ({ ...t, [s.site_id]: e.target.value }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <label className="ox-field">
            Reason (stored with each action)
            <input className="ox-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you changing these targets?" aria-label="Reason (stored with each action)" />
          </label>
          {invalid && <Notice>Targets must be whole numbers of 0 or more.</Notice>}
        </>
      )}
    </Drawer>
  );
}

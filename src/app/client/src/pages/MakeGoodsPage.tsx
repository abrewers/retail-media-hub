// Make-goods: finance approval queue plus "Log make-good" with search, contract clause and recommendation.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { fmt, sendJson, useFetch } from '../lib/api';
import { evaluateOptions, TYPE_OPTIONS, typeLabel, type Assessment } from '../lib/makegoods';
import type { MakeGood, MakeGoodCandidate, MakeGoodKpis } from '../lib/types';
import { CampaignPicker } from '../components/CampaignPicker';
import { Drawer, Notice, Skel, StatusBadge, useRefresh, useToast } from '../components/ox';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const ASSESS: Record<Assessment, string> = { Recommended: 'ox-info', Viable: 'ox-neutral', 'Not viable': 'ox-critical' };
type Next = 'approved' | 'fulfilled' | 'disputed';

function LogDrawer({ candidates, loading, preselect, onClose, onSubmitted }: { candidates: MakeGoodCandidate[]; loading: boolean; preselect: string; onClose: () => void; onSubmitted: (msg: string) => void }) {
  const [campaignId, setCampaignId] = useState('');
  const [type, setType] = useState('extension');
  const [value, setValue] = useState('');
  const [clause, setClause] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = candidates.find((c) => String(c.campaign_id) === campaignId);
  const ev = selected ? evaluateOptions(selected) : null;
  const num = Number(value);
  const valueOk = value.trim() !== '' && Number.isFinite(num) && num >= 0;

  const choose = (id: string) => {
    setCampaignId(id);
    const c = candidates.find((x) => String(x.campaign_id) === id);
    if (c) { setValue(String(Math.round(c.shortfall_dollars))); setClause(c.contract_clause ?? ''); setType(c.recommended_type); }
  };
  useEffect(() => {
    if (preselect && !campaignId && candidates.some((c) => String(c.campaign_id) === preselect)) choose(preselect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselect, candidates]);

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const r = await sendJson<{ make_good_id: number }>('/api/make-goods', 'POST', {
        campaignId: selected.campaign_id, makeGoodType: type, makeGoodValue: num,
        contractClause: clause.trim() || undefined, notes: notes.trim() || undefined,
      });
      onSubmitted(`Make-good #${r.make_good_id} for ${selected.campaign_name} submitted for approval`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="Log a make-good"
      onClose={onClose}
      width={600}
      footer={<><button type="button" className="ox-btn ox-btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="ox-btn ox-btn-primary" disabled={!selected || !valueOk || busy} onClick={() => void submit()}>{busy ? 'Submitting…' : 'Submit for approval'}</button></>}
    >
      {error && <Notice>{error}</Notice>}
      <CampaignPicker candidates={candidates} loading={loading} selectedId={campaignId} onSelect={choose} />
      {selected && ev && (
        <>
          <div className="ox-rec">
            <div className="ox-rec-k">Recommended action</div>
            <div className="ox-rec-v">{ev.recommendedLabel}<span>{fmt.usd(selected.recommended_value)}</span></div>
            <p className="ox-small" style={{ margin: '0 0 10px' }}>{ev.summary}</p>
            <div className="ox-stats" style={{ marginBottom: 10 }}>
              <div><span>Delivery vs threshold</span><b style={{ fontSize: 18 }}>{fmt.pct(selected.delivery_rate_pct)}</b><small>{selected.makegood_threshold !== null ? `of ${selected.makegood_threshold}% required` : 'no contract on file'}</small></div>
              <div><span>Shortfall</span><b style={{ fontSize: 18 }}>{compact.format(selected.shortfall_impressions)}</b><small>{fmt.usd(selected.shortfall_dollars)}</small></div>
              <div><span>Days left</span><b style={{ fontSize: 18 }}>{selected.days_remaining > 0 ? selected.days_remaining : 'Ended'}</b><small>in flight</small></div>
              <div><span>Daily pace</span><b style={{ fontSize: 18 }}>{selected.current_daily_rate !== null ? compact.format(selected.current_daily_rate) : '—'}</b><small>{selected.required_daily_rate !== null ? `${compact.format(selected.required_daily_rate)} needed` : 'flight closed'}</small></div>
            </div>
            <table className="ox-table compact">
              <thead><tr><th>Option</th><th>Assessment</th><th>Why</th></tr></thead>
              <tbody>{ev.options.map((o) => <tr key={o.type}><td><b>{o.label}</b></td><td><span className={`ox-badge ${ASSESS[o.assessment]}`}>{o.assessment}</span></td><td className="ox-small">{o.rationale}</td></tr>)}</tbody>
            </table>
            <p className="ox-muted ox-small" style={{ margin: '8px 0 0' }}>Based on governed campaign metrics{selected.source_file ? ` · contract terms extracted from ${selected.source_file.split('/').pop()}` : ''}.</p>
          </div>
          {selected.contract_clause && <div className="ox-clause"><div className="ox-rec-k">Contract clause</div>{selected.contract_clause}</div>}
          <label className="ox-field">Remedy
            <select className="ox-select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Remedy">{TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
          </label>
          <label className="ox-field">Value (USD)
            <input className="ox-input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!valueOk} aria-label="Value (USD)" />
          </label>
          <label className="ox-field">Contract clause
            <input className="ox-input" value={clause} onChange={(e) => setClause(e.target.value)} placeholder="e.g. Section 3.1: make-good if delivery below 95%" aria-label="Contract clause" />
          </label>
          <label className="ox-field">Notes
            <textarea className="ox-textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" />
          </label>
        </>
      )}
    </Drawer>
  );
}

export function MakeGoodsPage() {
  const { key, bump } = useRefresh();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const list = useFetch<MakeGood[]>('/api/make-goods', key);
  const kpis = useFetch<MakeGoodKpis>('/api/make-goods/kpis', key);
  const candidates = useFetch<MakeGoodCandidate[]>('/api/make-goods/candidates', key);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preselect = params.get('new') ?? '';
  const open = params.has('new');
  const setOpen = (v: boolean, id = '') => { const p = new URLSearchParams(params); if (v) p.set('new', id); else p.delete('new'); setParams(p, { replace: true }); };

  const move = async (mg: MakeGood, status: Next) => {
    setBusyId(mg.make_good_id);
    setError(null);
    try {
      await sendJson(`/api/make-goods/${mg.make_good_id}/status`, 'PATCH', { status });
      toast(`Make-good #${mg.make_good_id} ${status}`);
      bump();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const k = kpis.data;
  return (
    <>
      <div className="ox-page-h">
        <div><h1 className="ox-h1">Make-goods</h1><p className="ox-muted">Log, approve and fulfil advertiser make-goods. Shortfall figures come from governed metrics, never typed in.</p></div>
        <button type="button" className="ox-btn ox-btn-primary" onClick={() => setOpen(true)}>+ Log make-good</button>
      </div>
      <div className="ox-kpis" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        <div className="ox-kpi serious"><div className="ox-kpi-l">Waiting for finance</div><div className="ox-kpi-v">{k ? k.pending_approval : <Skel h={34} w={60} />}</div><div className="ox-kpi-s">submitted, not yet approved</div></div>
        <div className="ox-kpi accent"><div className="ox-kpi-l">Open value</div><div className="ox-kpi-v">{k ? fmt.usd(k.open_value) : <Skel h={34} w={100} />}</div><div className="ox-kpi-s">draft + submitted</div></div>
        <div className="ox-kpi"><div className="ox-kpi-l">Committed value</div><div className="ox-kpi-v">{k ? fmt.usd(k.committed_value) : <Skel h={34} w={100} />}</div><div className="ox-kpi-s">approved + fulfilled</div></div>
      </div>
      {(error || list.error) && <Notice>{error ?? `Make-goods unavailable: ${list.error}`}</Notice>}
      <div className="ox-panel ox-table-panel">
        <table className="ox-table">
          <thead><tr><th>#</th><th>Campaign</th><th>Remedy</th><th className="ox-r">Value</th><th>Clause</th><th>Logged</th><th>Status</th><th className="ox-r">Actions</th></tr></thead>
          <tbody>
            {!list.data && !list.error && <tr><td colSpan={8}><Skel h={22} /></td></tr>}
            {list.data?.map((m) => (
              <tr key={m.make_good_id}>
                <td className="ox-muted">{m.make_good_id}</td>
                <td><b>{m.campaign_name}</b><div className="ox-meta">{m.advertiser} · {fmt.usd(m.shortfall_dollars)} short</div>{m.notes && <div className="ox-small ox-muted" style={{ maxWidth: 320 }}>{m.notes}</div>}</td>
                <td>{typeLabel(m.make_good_type)}</td>
                <td className="ox-r"><b>{fmt.usd(m.make_good_value)}</b></td>
                <td className="ox-small" style={{ maxWidth: 260 }}>{m.contract_clause ?? '—'}</td>
                <td className="ox-small">{m.created_at_utc} UTC<div className="ox-meta">{m.created_by}{m.approved_by ? ` · approved by ${m.approved_by}` : ''}</div></td>
                <td><StatusBadge status={m.status} /></td>
                <td className="ox-r" style={{ whiteSpace: 'nowrap' }}>
                  {(m.status === 'submitted' || m.status === 'draft') && <button type="button" className="ox-btn ox-btn-primary ox-btn-sm" disabled={busyId === m.make_good_id} onClick={() => void move(m, 'approved')}>Approve</button>}
                  {m.status === 'approved' && <button type="button" className="ox-btn ox-btn-ghost ox-btn-sm" disabled={busyId === m.make_good_id} onClick={() => void move(m, 'fulfilled')}>Mark fulfilled</button>}
                  {(m.status === 'submitted' || m.status === 'approved') && <button type="button" className="ox-btn ox-btn-danger ox-btn-sm" style={{ marginLeft: 6 }} disabled={busyId === m.make_good_id} onClick={() => void move(m, 'disputed')}>Dispute</button>}
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && <tr><td colSpan={8} className="ox-empty">No make-goods logged yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && (
        <LogDrawer
          candidates={candidates.data ?? []}
          loading={candidates.loading}
          preselect={preselect}
          onClose={() => setOpen(false)}
          onSubmitted={(msg) => { setOpen(false); bump(); toast(msg); }}
        />
      )}
    </>
  );
}

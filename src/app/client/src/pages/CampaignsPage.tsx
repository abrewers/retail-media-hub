// Campaigns: every campaign with filters, sort, search and paging (server-side, /api/campaigns).
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileUp, Info } from 'lucide-react';
import { useNavigate } from 'react-router';
import { fmt, useFetch } from '../lib/api';
import type { CampaignPage } from '../lib/types';
import { Sparkline } from '../components/charts';
import { Notice, RiskBadge, Skel, StatusBadge, useRefresh, useToast } from '../components/ox';
import { useAppConfig } from '../lib/config';
import { isBusy, uploadContract, type UploadState } from '../lib/contractUpload';

const STATUSES = [['active', 'Active'], ['completed', 'Completed'], ['paused', 'Paused'], ['all', 'All']] as const;
const RISKS = ['all', 'Critical', 'At Risk', 'On Track', 'Over-Delivering'];
const PAGE = 15;

export function CampaignsPage() {
  const { key, bump } = useRefresh();
  const toast = useToast();
  const config = useAppConfig();
  const fileInput = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<{ id: number; name: string } | null>(null);
  const [uploads, setUploads] = useState<Record<number, UploadState>>({});
  const [added, setAdded] = useState<Record<number, true>>({}); // shown as On file until the status refetch lands
  const navigate = useNavigate();
  const [status, setStatus] = useState('active');
  const [risk, setRisk] = useState('all');
  const [sort, setSort] = useState('shortfall');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = window.setTimeout(() => { setQuery(q); setPage(1); }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const url = `/api/campaigns?status=${status}&risk=${encodeURIComponent(risk)}&sort=${sort}&q=${encodeURIComponent(query)}&page=${page}&pageSize=${PAGE}`;
  const data = useFetch<CampaignPage>(url, key);
  const sparks = useFetch<Record<string, number[]>>('/api/campaigns/sparklines');
  const contracts = useFetch<Record<string, { uploaded: boolean }>>('/api/contracts/status', key);
  const canUpload = Boolean(config.data?.contractUpload);

  const pick = (id: number, name: string) => { setTarget({ id, name }); fileInput.current?.click(); };
  const upload = async (file: File | undefined) => {
    const t = target;
    if (!file || !t) return;
    const final = await uploadContract(t.id, file, (st) => setUploads((u) => ({ ...u, [t.id]: st })));
    setUploads((u) => { const next = { ...u }; delete next[t.id]; return next; });
    if (final.state === 'done') { setAdded((a) => ({ ...a, [t.id]: true })); bump(); toast(`${t.name}: signed IO extracted. Genie and make-goods now use it.`); }
    else toast(`${t.name}: ${final.message}`);
  };
  const total = data.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <>
      <div className="ox-page-h">
        <div><h1 className="ox-h1">Campaigns</h1><p className="ox-muted">{data.data ? `${total} campaign${total === 1 ? '' : 's'}` : 'Loading…'} · governed metric view</p></div>
      </div>
      <div className="ox-toolbar">
        <div className="ox-chips" role="group" aria-label="Status">
          {STATUSES.map(([v, l]) => (
            <button key={v} type="button" className={`ox-chip ${status === v ? 'on' : ''}`} aria-pressed={status === v} onClick={() => { setStatus(v); setPage(1); }}>{l}</button>
          ))}
        </div>
        <select className="ox-select" aria-label="Risk level" value={risk} onChange={(e) => { setRisk(e.target.value); setPage(1); }}>
          {RISKS.map((r) => <option key={r} value={r}>{r === 'all' ? 'All risk levels' : r}</option>)}
        </select>
        <select className="ox-select" aria-label="Sort by" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}>
          <option value="shortfall">Largest shortfall</option>
          <option value="pace">Lowest pace</option>
          <option value="days">Fewest days left</option>
        </select>
        <input className="ox-input" style={{ minWidth: 280, flex: 1 }} placeholder="Search campaign or brand" aria-label="Search campaign or brand" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {data.error && <Notice>Campaigns unavailable: {data.error}</Notice>}
      <div className="ox-panel ox-table-panel">
        <table className="ox-table">
          <thead>
            <tr><th>Campaign</th><th>Risk</th><th>Last 6 weeks</th><th className="ox-r">Delivered</th><th className="ox-r">Pace</th><th className="ox-r">Days left</th><th className="ox-r">Shortfall</th><th>Ops status</th><th>
              <span className="ox-th-tip">Contract (IO)
                <span className="ox-hint" tabIndex={0} role="button" aria-label="What is an IO?" aria-describedby="io-tip"><Info size={13} aria-hidden="true" />
                  <span id="io-tip" role="tooltip" className="ox-hint-body">
                    <b>IO = insertion order</b>, the signed contract for a campaign: impressions, CPM, flight dates and make-good terms.
                    Upload the PDF and the app reads its make-good terms with AI Functions, for the make-good drawer and Genie.
                  </span>
                </span>
              </span>
            </th></tr>
          </thead>
          <tbody>
            {!data.data && !data.error && Array.from({ length: 6 }, (_, i) => <tr key={i}><td colSpan={9}><Skel h={22} /></td></tr>)}
            {data.data?.rows.map((c) => (
              <tr key={c.campaign_id} className="ox-click" onClick={() => void navigate(`/campaigns/${c.campaign_id}`)}>
                <td><b>{c.campaign_name}</b><div className="ox-meta">{c.advertiser} · {c.region} · {fmt.label(c.channel)}</div></td>
                <td><RiskBadge risk={c.risk_level} /></td>
                <td><Sparkline values={sparks.data?.[String(c.campaign_id)]} width={120} height={28} /></td>
                <td className="ox-r">{fmt.pct(c.delivery_rate_pct)}</td>
                <td className="ox-r">{fmt.pct(c.pace_adjusted_pct)}</td>
                <td className="ox-r">{c.days_remaining > 0 ? c.days_remaining : '—'}</td>
                <td className="ox-r"><b>{fmt.usd(c.shortfall_dollars)}</b></td>
                <td><StatusBadge status={c.ops_status} /></td>
                <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                  {(() => {
                    const up = uploads[c.campaign_id];
                    if (isBusy(up)) return <span className="ox-io-busy" aria-live="polite">{up?.state === 'uploading' ? 'Uploading…' : `Extracting… ${up?.seconds ? `${up.seconds}s` : ''}`}</span>;
                    if (contracts.data?.[String(c.campaign_id)] || (added[c.campaign_id] && contracts.loading)) {
                      return <button type="button" className="ox-io-on" onClick={() => void navigate(`/campaigns/${c.campaign_id}?tab=contract`)}><CheckCircle2 size={14} aria-hidden="true" />On file</button>;
                    }
                    if (!canUpload || !contracts.data) return <span className="ox-muted">—</span>;
                    return <button type="button" className="ox-btn ox-btn-ghost ox-btn-sm" onClick={() => pick(c.campaign_id, c.campaign_name)} aria-label={`Upload signed IO for ${c.campaign_name}`}><FileUp size={13} aria-hidden="true" /> Upload IO</button>;
                  })()}
                </td>
              </tr>
            ))}
            {data.data?.rows.length === 0 && <tr><td colSpan={9} className="ox-empty">No campaigns match these filters.</td></tr>}
          </tbody>
        </table>
        <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
        <div className="ox-pager">
          <span>Page {page} of {pages}</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="ox-btn ox-btn-ghost ox-btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <button type="button" className="ox-btn ox-btn-ghost ox-btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </span>
        </div>
      </div>
    </>
  );
}

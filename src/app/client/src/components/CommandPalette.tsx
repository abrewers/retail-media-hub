// ⌘K search across campaigns, brands, stores and regions. Arrow keys + Enter, Escape closes.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useFetch } from '../lib/api';
import type { SearchItem } from '../lib/types';
import { RiskBadge } from './ox';

interface Hit { item: SearchItem; why: string }

export function matchSearch(items: SearchItem[], query: string, limit = 8): Hit[] {
  const q = query.trim().toLowerCase();
  const has = (v: string | null | undefined) => (v ?? '').toLowerCase().includes(q);
  if (!q) {
    return items
      .filter((i) => i.status === 'active' && (i.risk_level === 'Critical' || i.risk_level === 'At Risk'))
      .sort((a, b) => b.shortfall_dollars - a.shortfall_dollars)
      .slice(0, limit)
      .map((item) => ({ item, why: 'Needs action' }));
  }
  const hits: Hit[] = [];
  for (const item of items) {
    if (has(item.campaign_name)) hits.push({ item, why: 'Campaign' });
    else if (has(item.advertiser)) hits.push({ item, why: `Brand · ${item.advertiser}` });
    else if (has(item.region)) hits.push({ item, why: `Region · ${item.region}` });
    else {
      const s = item.stores.filter((x) => has(x.name) || has(x.city) || has(x.state));
      if (s.length) hits.push({ item, why: `Store · ${s[0].name}${s.length > 1 ? ` +${s.length - 1}` : ''}` });
    }
  }
  const rank = (h: Hit) => (h.item.status === 'active' ? 0 : 1);
  return hits.sort((a, b) => rank(a) - rank(b) || b.item.shortfall_dollars - a.item.shortfall_dollars).slice(0, limit);
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const index = useFetch<SearchItem[]>('/api/search-index');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const navigate = useNavigate();
  const hits = useMemo(() => matchSearch(index.data ?? [], q), [index.data, q]);
  const go = (h: Hit | undefined) => { if (h) { onClose(); void navigate(`/campaigns/${h.item.campaign_id}`); } };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="ox-cmdk-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ox-cmdk" role="dialog" aria-label="Search">
        <input
          autoFocus
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === 'Enter') { e.preventDefault(); go(hits[sel]); }
          }}
          placeholder="Search campaigns, brands, stores, regions"
          aria-label="Search campaigns, brands, stores, regions"
        />
        <ul role="listbox">
          {index.loading && <li className="ox-muted ox-small" style={{ padding: 12 }}>Loading…</li>}
          {index.error && <li className="ox-muted ox-small" style={{ padding: 12 }}>Search unavailable: {index.error}</li>}
          {!index.loading && hits.map((h, i) => (
            <li key={h.item.campaign_id}>
              <button type="button" role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''} onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
                <RiskBadge risk={h.item.risk_level} />
                <b>{h.item.campaign_name}</b>
                <small>{h.item.advertiser} · {h.why}</small>
              </button>
            </li>
          ))}
          {!index.loading && !index.error && hits.length === 0 && <li className="ox-muted ox-small" style={{ padding: 12 }}>No matches for “{q}”.</li>}
        </ul>
      </div>
    </div>
  );
}

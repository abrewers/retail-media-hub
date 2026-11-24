// Searchable campaign picker for the Log make-good panel.
// Search by campaign name, brand (advertiser), store (site name, city or state) or region.
import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { fmt } from '../lib/api';
import type { MakeGoodCandidate } from '../lib/types';

type Scope = 'all' | 'campaign' | 'brand' | 'store' | 'region';

const SCOPES: { value: Scope; label: string }[] = [
  { value: 'all', label: 'All fields' },
  { value: 'campaign', label: 'Campaign' },
  { value: 'brand', label: 'Brand' },
  { value: 'store', label: 'Store' },
  { value: 'region', label: 'Region' },
];

interface Match {
  c: MakeGoodCandidate;
  /** Why the row matched, when it isn't obvious from the row itself (store matches). */
  hint: string | null;
}

function matchCandidate(c: MakeGoodCandidate, q: string, scope: Scope): Match | null {
  if (!q) return { c, hint: null };
  const has = (v: string | null | undefined) => (v ?? '').toLowerCase().includes(q);
  if ((scope === 'all' || scope === 'campaign') && has(c.campaign_name)) return { c, hint: null };
  if ((scope === 'all' || scope === 'brand') && has(c.advertiser)) return { c, hint: null };
  if ((scope === 'all' || scope === 'region') && has(c.region)) return { c, hint: null };
  if (scope === 'all' || scope === 'store') {
    const stores = (c.stores ?? []).filter((s) => has(s.name) || has(s.city) || has(s.state));
    if (stores.length > 0) {
      const first = stores[0];
      const more = stores.length > 1 ? ` +${stores.length - 1} more` : '';
      return { c, hint: `Store: ${first.name} (${first.city}, ${first.state})${more}` };
    }
  }
  return null;
}

export function CampaignPicker({
  candidates,
  loading,
  selectedId,
  onSelect,
}: {
  candidates: MakeGoodCandidate[];
  loading: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const selected = candidates.find((c) => String(c.campaign_id) === selectedId);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates.map((c) => matchCandidate(c, q, scope)).filter((m): m is Match => m !== null);
  }, [candidates, query, scope]);

  if (selected) {
    return (
      <div className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
        Campaign (with a shortfall)
        <div className="flex items-start justify-between gap-3 rounded-md border border-input bg-background px-3 py-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground truncate">{selected.campaign_name}</div>
            <div className="text-xs text-muted-foreground">
              {selected.advertiser} · {selected.region} · <span className="capitalize">{selected.status}</span> ·{' '}
              {fmt.usd(selected.shortfall_dollars)} shortfall
            </div>
          </div>
          <button
            type="button"
            onClick={() => onSelect('')}
            className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 text-xs font-medium text-muted-foreground">
      Campaign (with a shortfall)
      <div className="flex gap-2">
        <label className="relative flex-1">
          <span className="sr-only">Search campaigns</span>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search campaign, brand, store or region"
            className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground"
            autoFocus
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="absolute right-2 top-2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </label>
        <label>
          <span className="sr-only">Search in</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            aria-label="Search in"
          >
            {SCOPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="text-[11px] font-normal">
        {loading ? 'Loading campaigns…' : `${matches.length} of ${candidates.length} campaigns`}
      </div>
      <ul className="max-h-72 overflow-y-auto rounded-md border border-input divide-y divide-border" role="listbox" aria-label="Campaigns">
        {matches.map(({ c, hint }) => (
          <li key={c.campaign_id}>
            <button
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => onSelect(String(c.campaign_id))}
              className="w-full px-3 py-2 text-left hover:bg-muted/60 focus:bg-muted/60 focus:outline-none"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-foreground truncate">{c.campaign_name}</span>
                <span className="shrink-0 text-sm tabular-nums text-foreground">{fmt.usd(c.shortfall_dollars)}</span>
              </div>
              <div className="text-xs font-normal text-muted-foreground">
                {c.advertiser} · {c.region} · <span className="capitalize">{c.status}</span>
                {c.risk_level ? ` · ${c.risk_level}` : ''}
              </div>
              {hint && <div className="text-xs font-normal text-muted-foreground mt-0.5">{hint}</div>}
            </button>
          </li>
        ))}
        {!loading && matches.length === 0 && (
          <li className="px-3 py-4 text-center text-xs font-normal">No campaigns match “{query}”.</li>
        )}
      </ul>
    </div>
  );
}

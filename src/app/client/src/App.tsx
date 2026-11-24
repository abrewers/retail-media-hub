import { useCallback, useEffect, useMemo, useState } from 'react';
import { createBrowserRouter, NavLink, Outlet, RouterProvider } from 'react-router';
import { LayoutDashboard, ListChecks, ReceiptText, RotateCcw, Search, Sparkles } from 'lucide-react';
import { BRAND, markDataUrl } from './config/branding';
import { sendJson, useFetch } from './lib/api';
import { useAppConfig } from './lib/config';
import { CommandPalette } from './components/CommandPalette';
import { GeniePanel } from './components/GeniePanel';
import { GenieCtx, RefreshCtx, ToastProvider, useRefresh, useToast } from './components/ox';
import { OverviewPage } from './pages/OverviewPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { CampaignPage } from './pages/CampaignPage';
import { MakeGoodsPage } from './pages/MakeGoodsPage';
import { GeniePage } from './pages/GeniePage';

const shortDate = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function initials(email: string | undefined): string {
  if (!email) return '·';
  const parts = email.split('@')[0].split(/[._-]/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '·';
}

function ResetDemo() {
  const config = useAppConfig();
  const { bump } = useRefresh();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!config.data?.resetEnabled) return null;
  const reset = async () => {
    if (!window.confirm('Reset demo data? This removes every rebalance, make-good and uploaded IO added in the app and restores the demo seed rows.')) return;
    setBusy(true);
    try {
      await sendJson('/api/admin/reset-demo', 'POST', {});
      bump();
      toast('Demo data reset');
    } catch (err) {
      window.alert(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="ox-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }} onClick={() => void reset()} disabled={busy}>
      <RotateCcw size={13} />{busy ? 'Resetting…' : 'Reset demo'}
    </button>
  );
}

function Shell() {
  const me = useFetch<{ email: string }>('/api/me');
  const config = useAppConfig();
  const retailer = config.data?.retailerName || BRAND.defaultRetailer;
  const mark = useMemo(() => markDataUrl(retailer), [retailer]);
  useEffect(() => {
    document.title = `${retailer} · ${BRAND.appName}`;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) { icon.type = 'image/svg+xml'; icon.href = mark; }
  }, [retailer, mark]);
  const [cmdk, setCmdk] = useState(false);
  const [genie, setGenie] = useState<{ q?: string; n: number } | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdk(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const genieApi = useMemo(() => ({ open: (q?: string) => setGenie((g) => ({ q, n: (g?.n ?? 0) + 1 })) }), []);
  const bump = useCallback(() => setRefresh((r) => r + 1), []);
  const refreshCtx = useMemo(() => ({ key: refresh, bump }), [refresh, bump]);
  const genieOn = config.data?.genieEnabled !== false;

  const nav = [
    { to: '/', end: true, label: 'Overview', icon: <LayoutDashboard /> },
    { to: '/campaigns', end: false, label: 'Campaigns', icon: <ListChecks /> },
    { to: '/make-goods', end: false, label: 'Make-goods', icon: <ReceiptText /> },
    { to: '/genie', end: false, label: 'Ask Genie', icon: <Sparkles /> },
  ];

  return (
    <RefreshCtx.Provider value={refreshCtx}>
      <GenieCtx.Provider value={genieApi}>
        <div className="ox-shell">
          <aside className="ox-side">
            <NavLink to="/" className="ox-brand"><img src={mark} alt="" /><span><b>{retailer}</b><small>{BRAND.appName}</small></span></NavLink>
            <nav className="ox-nav" aria-label="Main">
              {nav.map((n) => <NavLink key={n.to} to={n.to} end={n.end}>{n.icon}{n.label}</NavLink>)}
            </nav>
            <div className="ox-side-foot">
              {config.data?.asOfDate && <span>Data as of {shortDate(config.data.asOfDate)}</span>}
              <ResetDemo />
            </div>
          </aside>
          <div className="ox-main">
            <header className="ox-top">
              <button type="button" className="ox-search" onClick={() => setCmdk(true)}>
                <Search size={15} /> Search campaigns, brands, stores, regions <span className="ox-kbd">⌘K</span>
              </button>
              <div className="ox-who">
                {genieOn && <button type="button" className="ox-btn ox-btn-ghost ox-btn-sm" onClick={() => genieApi.open()}><Sparkles size={14} /> Ask Genie</button>}
                <span title="Signed-in user">{me.data?.email ?? ''}</span>
                <span className="ox-avatar" aria-hidden="true">{initials(me.data?.email)}</span>
              </div>
            </header>
            <main className="ox-page"><Outlet /></main>
          </div>
        </div>
        {cmdk && <CommandPalette onClose={() => setCmdk(false)} />}
        {genie && genieOn && <GeniePanel key={genie.n} question={genie.q} onClose={() => setGenie(null)} />}
      </GenieCtx.Provider>
    </RefreshCtx.Provider>
  );
}

const router = createBrowserRouter([
  {
    element: <ToastProvider><Shell /></ToastProvider>,
    children: [
      { path: '/', element: <OverviewPage /> },
      { path: '/campaigns', element: <CampaignsPage /> },
      { path: '/campaigns/:id', element: <CampaignPage /> },
      { path: '/make-goods', element: <MakeGoodsPage /> },
      { path: '/genie', element: <GeniePage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}

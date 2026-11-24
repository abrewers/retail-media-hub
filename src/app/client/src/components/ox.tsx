// Shared Ops Console building blocks: badges, notices, skeletons, drawer, toasts and the Genie context.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

const RISK: Record<string, { cls: string; label: string; icon: string }> = {
  Critical: { cls: 'ox-critical', label: 'Critical', icon: '▲' },
  'At Risk': { cls: 'ox-serious', label: 'At risk', icon: '●' },
  'On Track': { cls: 'ox-good', label: 'On track', icon: '✓' },
  'Over-Delivering': { cls: 'ox-info', label: 'Over-delivering', icon: '↑' },
};

/** Risk level as an icon + label + colour, never colour alone. */
export function RiskBadge({ risk }: { risk: string | null | undefined }) {
  const m = RISK[risk ?? ''] ?? { cls: 'ox-neutral', label: risk ?? '—', icon: '•' };
  return <span className={`ox-badge ${m.cls}`}><i aria-hidden="true">{m.icon}</i>{m.label}</span>;
}

const STATUS: Record<string, string> = {
  draft: 'ox-neutral', submitted: 'ox-serious', approved: 'ox-info', fulfilled: 'ox-good', disputed: 'ox-critical',
  pending: 'ox-serious', executed: 'ox-good', rejected: 'ox-critical',
  monitoring: 'ox-neutral', rebalancing: 'ox-info', make_good_pending: 'ox-serious', make_good_fulfilled: 'ox-good', closed: 'ox-neutral',
};
export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="ox-muted">—</span>;
  return <span className={`ox-badge ${STATUS[status] ?? 'ox-neutral'}`}>{status.replace(/_/g, ' ')}</span>;
}

export function Notice({ ok, children }: { ok?: boolean; children: ReactNode }) {
  return <div className={`ox-notice ${ok ? 'ok' : 'err'}`} role={ok ? 'status' : 'alert'}>{children}</div>;
}

export function Skel({ h = 18, w = '100%', style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="ox-skel" style={{ height: h, width: w, ...style }} />;
}

/** Right-hand drawer; closes on Escape or a click on the backdrop. */
export function Drawer({ title, onClose, children, footer, width }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="ox-drawer-bg" onClick={onClose} />
      <aside className="ox-drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Panel'} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="ox-drawer-h"><h2 className="ox-h3" style={{ fontSize: 18 }}>{title}</h2><button type="button" className="ox-x" onClick={onClose} aria-label="Close">×</button></div>
        {children}
        {footer && <div className="ox-drawer-f">{footer}</div>}
      </aside>
    </>
  );
}

// ---------- toasts ----------
const ToastCtx = createContext<(msg: string) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className={`ox-toast ${msg ? 'show' : ''}`} role="status" aria-live="polite">{msg}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- Genie: any screen can open the panel with a question ----------
export interface GenieApi { open: (question?: string) => void }
export const GenieCtx = createContext<GenieApi>({ open: () => undefined });
export const useGenie = () => useContext(GenieCtx);

// ---------- data refresh: bump after a write so every screen refetches ----------
export const RefreshCtx = createContext<{ key: number; bump: () => void }>({ key: 0, bump: () => undefined });
export const useRefresh = () => useContext(RefreshCtx);

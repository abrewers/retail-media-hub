import { useEffect, useState } from 'react';

export interface FetchState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
}

export async function readError(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      return body.error;
    }
  } catch {
    // Non-JSON error body; fall through to the status line.
  }
  return `${res.status} ${res.statusText}`;
}

/** GET a JSON endpoint. Bump `reloadKey` to refetch. Keeps the last data while a refetch is in flight. */
export function useFetch<T>(url: string | null, reloadKey = 0): FetchState<T> {
  const key = url === null ? '' : `${url}::${reloadKey}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: '' });

  useEffect(() => {
    if (url === null) return undefined;
    let cancelled = false;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res));
        return (await res.json()) as T;
      })
      .then((data) => {
        if (!cancelled) setState({ key, data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState((prev) => ({ key, data: prev.data, error: err instanceof Error ? err.message : String(err) }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url, key]);

  const settled = state.key === key;
  return { data: state.data, error: settled ? state.error : undefined, loading: url !== null && !settled };
}

export async function sendJson<T>(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdCompactFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const numFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const numCompactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

type Num = number | null | undefined;
const ok = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v);

export const fmt = {
  usd: (v: Num) => (ok(v) ? usdFmt.format(v) : '—'),
  usd2: (v: Num) => (ok(v) ? `$${v.toFixed(2)}` : '—'),
  usdCompact: (v: Num) => (ok(v) ? usdCompactFmt.format(v) : '—'),
  num: (v: Num) => (ok(v) ? numFmt.format(v) : '—'),
  numCompact: (v: Num) => (ok(v) ? numCompactFmt.format(v) : '—'),
  pct: (v: Num) => (ok(v) ? `${v.toFixed(1)}%` : '—'),
  signed: (v: Num) => (ok(v) ? `${v > 0 ? '+' : ''}${numFmt.format(v)}` : '—'),
  label: (v: string | null | undefined) => (v ? v.replace(/_/g, ' ') : '—'),
};

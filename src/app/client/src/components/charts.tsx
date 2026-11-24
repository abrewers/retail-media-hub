// Lightweight SVG charts for the Ops Console. Colours follow the validated categorical palette
// (--ox-s1..s4) and the reserved status colours; every series also has a legend or direct label.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { fmt } from '../lib/api';
import type { CampaignEvent, PacingPoint, RegionWeek } from '../lib/types';

const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`).getTime();
const shortDate = (s: string) =>
  new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** Measures the container width so charts fill their panel. */
function useWidth(fallback = 720): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // ResizeObserver reports the initial size on observe(), so no extra setState is needed here.
    const ro = new ResizeObserver(() => setW(el.clientWidth || fallback));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, w];
}

interface Tip { x: number; y: number; body: ReactNode }
function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="ox-tip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 230), top: Math.max(tip.y - 78, 8) }}>
      {tip.body}
    </div>
  );
}

// ---------- pacing: cumulative delivered vs contracted pace, with event bands ----------
export function PacingChart({ points, events = [], height = 300 }: { points: PacingPoint[]; events?: CampaignEvent[]; height?: number }) {
  const [ref, W] = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <div ref={ref} className="ox-empty">No delivery yet.</div>;
  const H = height;
  const m = { l: 56, r: 124, t: 22, b: 30 };
  const x0 = day(points[0].date);
  const x1 = day(points[points.length - 1].date);
  const last = points[points.length - 1];
  const yMax = Math.max(last.cumulative_target, last.cumulative_delivered, 1) * 1.08;
  const X = (d: string) => m.l + ((day(d) - x0) / Math.max(x1 - x0, 1)) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - (v / yMax) * (H - m.t - m.b);
  const path = (k: 'cumulative_delivered' | 'cumulative_target') =>
    points.map((p, i) => `${i ? 'L' : 'M'}${X(p.date).toFixed(1)},${Y(p[k]).toFixed(1)}`).join('');
  const months: string[] = [];
  for (let t = new Date(x0); t.getTime() <= x1; t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1))) {
    const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)).getTime();
    if (first >= x0) months.push(new Date(first).toISOString().slice(0, 10));
  }
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const hp = hover !== null ? points[hover] : null;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg width={W} height={H} className="ox-viz" role="img" aria-label="Delivered impressions against contracted pace">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} className="g" />
            <text x={m.l - 8} y={Y(v) + 4} className="ax" textAnchor="end">{compact.format(v)}</text>
          </g>
        ))}
        {months.map((d) => <text key={d} x={X(d)} y={H - 8} className="ax" textAnchor="middle">{shortDate(d)}</text>)}
        {events.map((e) => {
          const from = Math.max(day(e.from), x0);
          const to = Math.min(day(e.to), x1);
          if (to < from) return null;
          const fx = X(new Date(from).toISOString()); const tx = X(new Date(to).toISOString());
          return (
            <g key={`${e.type}-${e.from}`}>
              <rect x={fx} y={m.t} width={Math.max(tx - fx, 4)} height={H - m.t - m.b} className={`band-${e.type}`} />
              <text x={fx + 6} y={m.t - 6} className={`band-${e.type}-l`}>{e.label}</text>
            </g>
          );
        })}
        <path d={path('cumulative_target')} className="ln ln-target" />
        <path d={path('cumulative_delivered')} className="ln ln-delivered" />
        <text x={W - m.r + 8} y={Y(last.cumulative_delivered) + 4} className="lbl">Delivered {compact.format(last.cumulative_delivered)}</text>
        <text x={W - m.r + 8} y={Y(last.cumulative_target) + 4} className="lbl m">Contracted pace</text>
        {hp && <line className="cross" x1={X(hp.date)} x2={X(hp.date)} y1={m.t} y2={H - m.b} />}
        <rect
          x={m.l} y={m.t} width={W - m.l - m.r} height={H - m.t - m.b} fill="transparent"
          onMouseMove={(e) => {
            const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
            const f = (e.clientX - r.left - m.l) / (W - m.l - m.r);
            const i = Math.max(0, Math.min(points.length - 1, Math.round(f * (points.length - 1))));
            const p = points[i];
            setHover(i);
            setTip({ x: e.clientX, y: e.clientY, body: <><b>{shortDate(p.date)}</b><br />Delivered {fmt.num(p.cumulative_delivered)}<br />Pace {fmt.num(p.cumulative_target)}</> });
          }}
          onMouseLeave={() => { setHover(null); setTip(null); }}
        />
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---------- sparkline ----------
export function Sparkline({ values, width = 110, height = 30 }: { values: number[] | undefined; width?: number; height?: number }) {
  if (!values || values.length < 2) return <span style={{ width, display: 'inline-block' }} />;
  const max = Math.max(...values) || 1;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * (width - 4) + 2).toFixed(1)},${(height - 3 - (v / max) * (height - 6)).toFixed(1)}`).join('');
  return <svg width={width} height={height} className="ox-spark" aria-hidden="true"><path d={d} /></svg>;
}

// ---------- region lines: 4 series, legend + direct labels ----------
const REGIONS = ['Southwest', 'Southeast', 'Midwest', 'Northeast'];
export function RegionChart({ rows, height = 220 }: { rows: RegionWeek[]; height?: number }) {
  const [ref, W] = useWidth(420);
  const [tip, setTip] = useState<Tip | null>(null);
  const weeks = [...new Set(rows.map((r) => r.week))].sort();
  if (weeks.length < 2) return <div ref={ref} className="ox-empty">No data yet.</div>;
  // Known regions first, then any others; capped at 4 series (the validated palette size).
  const present = [...new Set(rows.map((r) => r.region))];
  const regions = [...REGIONS.filter((r) => present.includes(r)), ...present.filter((r) => !REGIONS.includes(r))].slice(0, 4);
  const H = height;
  const m = { l: 40, r: 88, t: 10, b: 26 };
  const vals = rows.map((r) => r.uptime_pct);
  const yMin = Math.floor((Math.min(...vals) - 5) / 10) * 10;
  const yMax = 100;
  const X = (i: number) => m.l + (i / (weeks.length - 1)) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - ((v - yMin) / (yMax - yMin)) * (H - m.t - m.b);
  const series = regions.map((reg, k) => ({
    reg, k,
    pts: weeks.flatMap((wk, i) => { const r = rows.find((x) => x.week === wk && x.region === reg); return r ? [[i, r.uptime_pct] as [number, number]] : []; }),
  }));
  const labels = series.map((s) => ({ s, y: Y(s.pts[s.pts.length - 1]?.[1] ?? yMax) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
  return (
    <div ref={ref}>
      <div className="ox-legend">{series.map((s) => <span key={s.reg}><i className={`ox-sw s${s.k + 1}`} />{s.reg}</span>)}</div>
      <svg width={W} height={H} className="ox-viz" role="img" aria-label="Screen uptime by week and region">
        {[yMin, (yMin + yMax) / 2, yMax].map((v) => (
          <g key={v}><line x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} className="g" /><text x={m.l - 6} y={Y(v) + 4} className="ax" textAnchor="end">{Math.round(v)}%</text></g>
        ))}
        {weeks.map((wk, i) => (i % 3 === 0 ? <text key={wk} x={X(i)} y={H - 6} className="ax" textAnchor="middle">{shortDate(wk)}</text> : null))}
        {series.map((s) => <path key={s.reg} className={`ln s${s.k + 1}`} d={s.pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')} />)}
        {labels.map(({ s, y }) => <text key={s.reg} x={W - m.r + 8} y={y + 4} className="lbl">{s.reg}</text>)}
        <rect
          x={m.l} y={m.t} width={W - m.l - m.r} height={H - m.t - m.b} fill="transparent"
          onMouseMove={(e) => {
            const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
            const i = Math.max(0, Math.min(weeks.length - 1, Math.round(((e.clientX - r.left - m.l) / (W - m.l - m.r)) * (weeks.length - 1))));
            const wk = weeks[i];
            setTip({ x: e.clientX, y: e.clientY, body: <><b>Week of {shortDate(wk)}</b>{regions.map((reg, k) => { const x = rows.find((q) => q.week === wk && q.region === reg); return x ? <div key={reg}><i className={`ox-sw s${k + 1}`} /> {reg}: {x.uptime_pct}%</div> : null; })}</> });
          }}
          onMouseLeave={() => setTip(null)}
        />
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---------- horizontal bars ----------
export function HBars({ items, format = fmt.num }: { items: { label: string; value: number; alt?: boolean }[]; format?: (v: number) => string }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div>
      {items.map((i) => (
        <div key={i.label} className="ox-hbar" title={`${i.label}: ${format(i.value)}`}>
          <span className="ox-cap">{i.label}</span>
          <span className="ox-hbar-track"><span className={`ox-hbar-fill ${i.alt ? 'alt' : ''}`} style={{ width: `${Math.max((i.value / max) * 100, 1.5)}%` }} /></span>
          <span className="ox-hbar-value">{format(i.value)}</span>
        </div>
      ))}
    </div>
  );
}

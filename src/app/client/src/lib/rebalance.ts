// Shared rebalance math, used by the Rebalance screen and the Triage campaign pop-up
// so both always show the same projected recovery.
import type { SiteRow } from './types';

/** Suggest-plan rule: top ~35% of sites (min 5) +40%, bottom ~25% (min 3) -50%.
 *  `sites` must be ordered weakest first (the /api/campaigns/:id/sites order). */
export function suggestTargets(sites: SiteRow[]): Map<number, number> {
  const next = new Map<number, number>();
  if (sites.length === 0) return next;
  const boostCount = Math.max(5, Math.ceil(sites.length * 0.35));
  const cutCount = Math.max(3, Math.ceil(sites.length * 0.25));
  sites.slice(-boostCount).forEach((s) => next.set(s.site_id, Math.round(s.current_target * 1.4)));
  sites
    .slice(0, Math.min(cutCount, Math.max(sites.length - boostCount, 0)))
    .forEach((s) => next.set(s.site_id, Math.round(s.current_target * 0.5)));
  return next;
}

/** Net change in daily impressions across all sites for a set of new targets. */
export function netDailyChange(sites: SiteRow[], targets: Map<number, number>): number {
  return sites.reduce((sum, s) => {
    const t = targets.get(s.site_id);
    return t === undefined ? sum : sum + t - s.current_target;
  }, 0);
}

/** Impressions and dollars recovered over the days left, capped at the shortfall. */
export function projectedRecovery(
  netDaily: number,
  daysRemaining: number,
  shortfallImpressions: number,
  cpmRate: number,
): { impressions: number; usd: number } {
  const days = Math.max(daysRemaining, 0);
  const impressions = Math.min(Math.max(netDaily * days, 0), Math.max(shortfallImpressions, 0));
  return { impressions, usd: (impressions * cpmRate) / 1000 };
}

export type Recommendation = 'rebalance' | 'make_good' | 'on_track' | 'over_delivering' | 'inactive';

/** Demo rules (assumptions agreed for the demo):
 *  - at risk with 5 or fewer days left and a rebalance recovering < 25% -> prepare a make-good
 *  - at risk otherwise -> rebalance now
 *  - on track -> no action; over-delivering (> 110% of pace) -> pull delivery back */
export function recommend(args: {
  status: string;
  riskLevel: string;
  daysRemaining: number;
  recoveryPct: number;
}): Recommendation {
  if (args.status !== 'active') return 'inactive';
  if (args.riskLevel === 'Over-Delivering') return 'over_delivering';
  if (args.riskLevel !== 'Critical' && args.riskLevel !== 'At Risk') return 'on_track';
  if (args.daysRemaining <= 5 && args.recoveryPct < 25) return 'make_good';
  return 'rebalance';
}

// Make-good settlement logic: scores the four remedies against governed delivery numbers.
// Mirrors the server rule in governed.ts (makeGoodCandidates) so the pre-filled type matches the recommendation.
import { fmt } from './api';
import type { MakeGoodCandidate } from './types';

export const TYPE_OPTIONS = [
  { value: 'extension', label: 'Flight extension' },
  { value: 'bonus_impressions', label: 'Bonus impressions' },
  { value: 'credit', label: 'Credit memo' },
  { value: 'rate_adjustment', label: 'Rate adjustment' },
];

export type Assessment = 'Recommended' | 'Viable' | 'Not viable';

interface OptionAssessment {
  type: string;
  label: string;
  assessment: Assessment;
  rationale: string;
}

export interface Evaluation {
  recommendedLabel: string;
  summary: string;
  options: OptionAssessment[];
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function typeLabel(type: string): string {
  return TYPE_OPTIONS.find((t) => t.value === type)?.label ?? type;
}

// Scores all four settlement options against the governed delivery snapshot.
// Mirrors the server rule in CANDIDATES_SQL so the pre-filled type always matches the recommendation.
export function evaluateOptions(c: MakeGoodCandidate): Evaluation {
  const days = c.days_remaining;
  const ended = c.status === 'completed' || days <= 0;
  const cur = c.current_daily_rate;
  const req = c.required_daily_rate;
  const paceRatio = cur && req ? req / cur : null;
  const paceCovers = paceRatio !== null && paceRatio <= 1;
  const usd = fmt.usd(c.shortfall_dollars);
  const rec = c.recommended_type;
  const pick = (type: string, fallback: Assessment): Assessment => (type === rec ? 'Recommended' : fallback);

  let extension: OptionAssessment;
  if (ended) {
    extension = { type: 'extension', label: '', assessment: 'Not viable', rationale: 'Flight has closed.' };
  } else if (paceRatio !== null) {
    extension = {
      type: 'extension',
      label: '',
      assessment: pick('extension', paceCovers ? 'Viable' : 'Not viable'),
      rationale: paceCovers
        ? `Current pace of ${compact.format(cur ?? 0)}/day covers the ${compact.format(req ?? 0)}/day required.`
        : `Requires ${compact.format(req ?? 0)}/day against current ${compact.format(cur ?? 0)}/day (${paceRatio.toFixed(1)}x).`,
    };
  } else {
    extension = {
      type: 'extension',
      label: '',
      assessment: pick('extension', days > 5 ? 'Viable' : 'Not viable'),
      rationale: `${days} days remain in flight.`,
    };
  }

  const options: OptionAssessment[] = [
    extension,
    {
      type: 'bonus_impressions',
      label: '',
      assessment: pick('bonus_impressions', 'Viable'),
      rationale: `Delivers ${compact.format(c.shortfall_impressions)} impressions post-flight; uses future inventory.`,
    },
    {
      type: 'credit',
      label: '',
      assessment: pick('credit', 'Viable'),
      rationale: ended
        ? `Settles ${usd} against the next insertion order.`
        : `Settles ${usd}; normally issued after flight close.`,
    },
    {
      type: 'rate_adjustment',
      label: '',
      assessment: pick('rate_adjustment', 'Viable'),
      rationale: ended
        ? `Settles ${usd} against a closed invoice.`
        : days <= 5
          ? `Settles ${usd} on the current invoice before flight close.`
          : `Discounts ${usd} while ${days} days of delivery remain.`,
    },
  ].map((o) => ({ ...o, label: typeLabel(o.type) }));

  const threshold = c.makegood_threshold !== null ? `${c.makegood_threshold}%` : 'contracted';
  const delivered = c.delivery_rate_pct !== null ? `${c.delivery_rate_pct.toFixed(1)}%` : 'current';
  let summary: string;
  if (ended) {
    summary = `Flight closed at ${delivered} delivery against a ${threshold} threshold.`;
  } else if (paceRatio !== null && !paceCovers) {
    summary = `Closing the gap in ${days} days requires ${paceRatio.toFixed(1)}x the current daily pace.`;
  } else if (paceRatio !== null) {
    summary = `Current daily pace closes the remaining gap within ${days} days.`;
  } else {
    summary = `${days} days remain in flight.`;
  }

  return { recommendedLabel: typeLabel(rec), summary, options };
}


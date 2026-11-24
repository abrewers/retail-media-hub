// Branding and Genie prompts: the one place to re-skin the app.
// The retailer name comes from the setup job (retailer_name, asked by scripts/configure.sh) via /api/config;
// the data itself (advertisers, campaigns) is configured in config/seed_config.yml.

export const BRAND = {
  /** Used until /api/config answers, and when setup hasn't run yet. Keep in sync with seed_config.yml retailer.name. */
  defaultRetailer: 'Waypoint Fuel & Market',
  appName: 'Retail Media Command Center',
  /** Fill colour of the lettermark. Red is kept for "critical" elsewhere in the app. */
  markColor: '#0F766E',
};

/** Up to two initials, skipping words like "&", "and", "of", "the": "Waypoint Fuel & Market" -> "WF". */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w) && !/^(and|of|the)$/i.test(w));
  return words.slice(0, 2).map((w) => w.replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase()).join('') || 'RM';
}

/** Square lettermark as an SVG string (used for the sidebar logo and the browser-tab icon). */
export function markSvg(name: string): string {
  const t = initials(name);
  const size = t.length > 1 ? 13 : 16;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${BRAND.markColor}"/>` +
    `<text x="16" y="16" dy="0.35em" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${size}" font-weight="700" fill="#fff">${t}</text></svg>`;
}

export const markDataUrl = (name: string) => `data:image/svg+xml,${encodeURIComponent(markSvg(name))}`;

export interface GeniePrompt {
  label: string;
  question: string;
  demo?: boolean;
}

/** Genie tab keypad. `demo: true` marks the scripted questions in DEMO_GUIDE.md. */
export const GENIE_PROMPT_GROUPS: { group: string; prompts: GeniePrompt[] }[] = [
  {
    group: 'Why',
    prompts: [
      { label: 'Why is Summer Fuel-Up behind?', question: 'Why is FizzCo Summer Fuel-Up so far behind pace?', demo: true },
      { label: 'Why is Holiday Refresh critical?', question: 'Why is FizzCo Holiday Refresh critical when it still has 10 days left?', demo: true },
      { label: 'Why do suburban sites lag?', question: 'Why do suburban sites underperform on impressions?', demo: true },
    ],
  },
  {
    group: 'Campaign risk',
    prompts: [
      { label: 'At-risk campaigns', question: 'Which active campaigns are most at risk of a make-good, and how much is the shortfall?' },
      { label: 'Shortfall by advertiser', question: 'What is the total shortfall in dollars by advertiser for active campaigns?' },
    ],
  },
  {
    group: 'Contracts',
    prompts: [
      { label: 'Summer Fuel-Up make-good clause', question: 'What does the FizzCo Summer Fuel-Up contract say about make-goods, and is one owed today?' },
    ],
  },
  {
    group: 'Sites',
    prompts: [
      { label: 'Weakest Summer Fuel-Up sites', question: 'Which sites are delivering the fewest impressions for FizzCo Summer Fuel-Up, and why?' },
    ],
  },
];

/** Quick-question chips in the Ask Genie side panel. */
export const GENIE_PANEL_PROMPTS: GeniePrompt[] = [
  { label: 'At-risk campaigns', question: GENIE_PROMPT_GROUPS[1].prompts[0].question },
  { label: 'Why is Summer Fuel-Up behind?', question: GENIE_PROMPT_GROUPS[0].prompts[0].question },
  { label: 'Summer Fuel-Up make-good clause', question: GENIE_PROMPT_GROUPS[2].prompts[0].question },
];

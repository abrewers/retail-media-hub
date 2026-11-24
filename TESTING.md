# Test checklist

A full pass over the app after any change. Expected values assume the default synthetic data, so they repeat on every deploy. Run it against a deployed copy, signed in as a workspace user.

**Last full pass:** Ops Console UI (branch `ui-v2`), fresh deploy to a new schema, Lakebase project and app. **Result: all 55 checks passed.** Two cosmetic issues were found and fixed (marked *fixed*).

## Build and deploy

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| B1 | `tsc` (server and client), `eslint`, server and client builds | No errors | Pass |
| B2 | `databricks bundle validate` | Validation OK! | Pass |
| B3 | `bundle deploy` to a fresh target | 6 resources created | Pass |
| B4 | `bundle run setup` | TERMINATED SUCCESS; preflight, extraction and Genie checks pass | Pass |
| B5 | `bundle run app`, app logs | `app_ops schema ready`, server running, no errors | Pass |
| B6 | `scripts/check_anonymized.sh` | Passes | Pass |
| B7 | Default branding (`retailer_name` empty) | Sidebar, tab title and icon show *Waypoint Fuel & Market* / WF; store names *Waypoint Fuel & Market Phoenix #13*; IO PDFs name *Waypoint Fuel & Market, Inc.* as publisher | Pass |
| U1 | Contract tab, campaign without an IO | Upload area; *download this campaign's sample IO* link on Holiday Refresh | Pass |
| U2 | Upload a non-PDF / unknown campaign / campaign with an IO on file | 415 *not a PDF* / 404 / 409 *already has a signed IO* | Pass |
| U3 | Upload a PDF that isn't an IO | *No make-good terms were found*; file deleted, no row | Pass |
| U4 | Upload Holiday Refresh's sample IO | Extracted in about 30 s: 95% · 21 days · 10%+, matching seed_config.yml; Activity entry with uploader | Pass |
| U5 | After upload | Make-good drawer *of 95% required* and clause; Genie quotes the IO and says a make-good is owed | Pass |
| U6 | Remove uploaded IO, then upload again | File and row removed; upload works again | Pass |
| U9 | Campaigns > Contract (IO) column, with the ⓘ tooltip on hover and keyboard focus | *On file* (3 setup IOs) / **Upload IO**; upload from a row goes Uploading → Extracting → On file with no flash; *On file* opens the Contract tab; row click still opens the campaign | Pass |
| U7 | Re-run setup with an uploaded IO present | Setup passes; the upload keeps its campaign and uploader | Pass |
| U8 | Reset demo with an uploaded IO present | IO file and terms removed; Holiday Refresh back to the upload area | Pass |
| B8 | Re-run setup with another `retailer_name`, restart the app | Name, initials, store names, own-brand campaigns, PDFs and Genie title all switch; extraction re-runs on the changed PDFs | Pass *(fixed: Genie update failed when another space in the folder had the same title)* |

## Overview

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| O1 | KPI tiles | 35 active · $242.9K exposure · 8 at risk (2 critical) · 2 over-delivering | Pass |
| O2 | Needs action today | 8 cards, soonest deadline first, each with a sparkline | Pass |
| O3 | Recommendation buttons | Summer Fuel-Up, Zero Sugar Push, VoltRush Pit Stop: *Prepare make-good*; Holiday Refresh: *Rebalance now · ~$1.5K* | Pass |
| O4 | Amounts under $1K on buttons | Whole dollars (for example ~$311) | Pass *(fixed: was ~$310.8)* |
| O5 | Why delivery dipped | Southwest, Oct 9 to Oct 29, 15 sites, about 33% online, about 2.1M impressions across 10 campaigns (matches SQL) | Pass |
| O6 | Screen uptime by region | 4 lines, legend and direct labels, hover tooltip | Pass |
| O7 | Traffic by site type | urban 2,246 · highway 2,231 · suburban 171 | Pass |
| O8 | Card click and button click | Card opens the campaign; button opens the planner or the make-good drawer | Pass |

## Campaigns

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| C1 | Default list | 35 active, 15 per page, sorted by shortfall | Pass |
| C2 | Status chips | Completed 10 · Paused 2 · Active 35 | Pass |
| C3 | Risk filter *Critical* | 2 (Holiday Refresh, Crestline Energy Launch) | Pass |
| C4 | Search `fizzco` | 3 active campaigns | Pass |
| C5 | Sort by pace | Ascending pace across pages (72.1% first) | Pass |
| C6 | Paging | 15 + 15 + 5 = 35; Previous and Next work | Pass |

## Campaign page

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| P1 | Summer Fuel-Up header | 76.3% · 78.6% · 3 days · $14,783; Ask why, Rebalance and Prepare make-good buttons | Pass |
| P2 | Summer Fuel-Up pacing | A *Screen outage* band (found in the data) where delivery flattens | Pass |
| P3 | Holiday Refresh header and pacing | 62.5% · 74.3% · 10 days · $15,208; *Creative approved 5 days late* band | Pass |
| P4 | Sites tab | 35 sites (Summer Fuel-Up); 19 with 16 suburban (Holiday Refresh) | Pass |
| P5 | Contract tab | Summer Fuel-Up: 100% / 30 days / 15%+ from `IO-2026-0731_...pdf`; Holiday Refresh: no IO on file | Pass |
| P6 | Activity tab | Seeded rebalance and flight milestones; creative approval on Holiday Refresh | Pass |

## Rebalance planner

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| R1 | Open from the Overview card | Planner opens on Holiday Refresh, $0 projected, Review disabled | Pass |
| R2 | Invalid target (`abc`) | Error shown, Review stays disabled | Pass |
| R3 | Suggest plan | $1,546 (10.2%), net +12,376 a day, 12 changes, default reason | Pass |
| R4 | Review button label | *Review 12 changes*; *Review changes* when nothing is changed | Pass *(fixed: double space)* |
| R5 | Review then Confirm and log | Drawer closes; Activity shows *Rebalanced 12 site(s)*; status *rebalancing* | Pass |
| R6 | Sites after logging | New target saved (Detroit #112: 12,050 → 16,870, pending) | Pass |

## Server rules (called from the signed-in page)

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| S1 | Rebalance with a reason under 3 characters | 400 | Pass |
| S2 | Rebalance a site not in the campaign | 400 *Site … does not serve this campaign* | Pass |
| S3 | Rebalance an inactive campaign | 409 | Pass |
| S4 | The same site twice | 400 | Pass |
| S5 | Bad and missing campaign ID | 400 / 404 | Pass |
| S6 | Make-good for a campaign with no shortfall | 404 | Pass |
| S7 | Invalid status move (fulfilled → approved) | 409 | Pass |
| S8 | `/api/campaigns/sparklines` not caught by `/api/campaigns/:id` | 200, 35 campaigns | Pass |

## Make-goods

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| M1 | Seeded state | Waiting 1 · open $4,454 · committed $1,933 | Pass |
| M2 | *Prepare make-good* from the Overview | Drawer opens with Summer Fuel-Up preselected | Pass |
| M3 | Recommendation | Rate adjustment $14,783; 10.5x the current pace; 4 options assessed; clause and PDF name | Pass |
| M4 | Submit | New row submitted; waiting 2, open $19,237 | Pass |
| M5 | Approve, Mark fulfilled, Dispute | Status moves; only valid buttons shown; KPIs update; approver recorded | Pass |
| M6 | Picker search | `Phoenix` 10 with store names · Brand `voltrush` 2 · Region `midwest` 10 | Pass |
| M7 | Escape | Closes the drawer | Pass |

## Search and Genie

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| K1 | ⌘K with no text | Needs-action campaigns | Pass |
| K2 | ⌘K `phoenix` | Campaigns matched by store | Pass |
| K3 | Arrow keys and Enter | Opens the selected campaign | Pass |
| G1 | *Ask why* on Summer Fuel-Up | Side panel answers: Southwest screen downtime, about 309K (urban) and 137K (highway) impressions lost | Pass |
| G2 | Genie page question *Why do suburban sites underperform?* | Traffic, not screens: about 171 against 2,246 transactions a day; suburban uptime 100% | Pass |

## Reset and errors

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| X1 | Sidebar *Reset demo* | Make-goods back to the 2 seeds; test rebalance gone from Activity | Pass |
| X2 | Browser page errors and console errors | None | Pass |
| X3 | Server 5xx or failed operations in the app logs | None | Pass |

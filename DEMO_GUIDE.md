# Demo guide

A 30–45 minute walkthrough: one campaign you can't save, one you can, and why each one happened.

The numbers below come from a default deploy, where the seed config sets "today" to the setup day. They repeat exactly on every deploy, because the generator is deterministic.

## Before the demo

1. Run the setup job if the config changed, or if you want "today" to move.
2. In the app sidebar, click **Reset demo** to clear earlier rehearsal clicks.
3. Warm up about 10 minutes before:
   1. Start the SQL warehouse.
   2. Open the app's **Overview**, one campaign page and **Make-goods**. This wakes the warehouse and Lakebase.
   3. Ask one Genie question.
4. Open these tabs in order:
   1. The app, on Overview
   2. The dashboard
   3. Catalog Explorer on `metric_view_campaign_delivery`
   4. The `contracts` volume
   5. `dim_contract_terms`
   6. The Genie space

## The numbers

| | |
| --- | --- |
| Active campaigns | **35** |
| At risk (pace below 85%) | **8** |
| Over-delivering (pace above 110%) | **2** |
| Make-good exposure if every campaign ended today | **$242,925** |
| **FizzCo Summer Fuel-Up** | 76.3% delivered, 78.6% pace, **3 days left**, $14,783 shortfall, At Risk |
| **FizzCo Holiday Refresh** | 62.5% delivered, 74.3% pace, **10 days left**, $15,208 shortfall, **Critical** |

## Run of show

| Segment | Show | Say / click |
| --- | --- | --- |
| **1. The hook** | App, Overview | "35 active campaigns, 8 at risk, about $243K of make-good exposure." Under *Needs action today*, **FizzCo Summer Fuel-Up** shows **Prepare make-good**: a rebalance with 3 days left recovers only about $327 (2%). "This one we can't save." Point at Holiday Refresh: Critical, but 10 days left, **Rebalance now · ~$1.5K**. "This one we can. We'll come back." Point at *Why delivery dipped*: the Southwest outage. |
| **2. One definition** | Catalog Explorer: `metric_view_campaign_delivery`, then the dashboard | Shortfall, pace and risk thresholds (75 / 85 / 110%) are defined once, in Unity Catalog. The app, the dashboard and Genie all read them, which is why the dashboard shows the same 35 / 8 / $243K. Change it once and every surface changes. |
| **3. Why it happened** | Genie | On FizzCo Summer Fuel-Up click **Ask why** (the panel opens with the answer), then the **Ask Genie** page for the other two "why" questions (below). Click **Show SQL** once. |
| **4. Contracts from PDFs** | Volume `contracts/contracts/`, then `dim_contract_terms` | Signed IOs in a volume. `ai_parse_document` and `ai_extract` pull the make-good terms into a table in SQL, with no ML pipeline. Thresholds differ: FizzCo 100%, VoltRush 95%, Apex 90%. `source_file` traces every row to its PDF. |
| **5. Act: save one** | App, Holiday Refresh | Click its **Rebalance now** card. The Pacing tab shows the *Creative approved 5 days late* band; the Sites tab shows 16 of 19 sites suburban, the strongest urban site at about 12,000 impressions a day against about 400 at the weakest suburban sites. In the planner click **Suggest plan** (about $1,546, 10%), **Review 12 changes**, **Confirm and log**. The Activity tab shows the rebalance. |
| **6. Act: the make-good** | App, Make-goods | **Approve** the Maple & Main make-good (finance). Then **Log make-good** and search for the campaign by name, brand, store or region (try a store city like "Phoenix"). Pick FizzCo Summer Fuel-Up: **Rate adjustment, $14,783**. Closing the gap in 3 days needs **10.5x** the current pace (37.4K/day against 394.2K/day required). The clause auto-fills from the extracted IO, and the footer names the PDF. |
| **7. Live contract upload** (optional) | App, Holiday Refresh > Contract | "No signed IO on file." Click **download this campaign's sample IO**, then drop it on **Upload the signed IO** (or use **Upload IO** on its row in **Campaigns**; the row turns *On file*). About 30 seconds later ai_parse_document and ai_extract have read it: 95% threshold, 21-day window, 10% credit option. Open **Make-goods > Log make-good** for Holiday Refresh (now *of 95% required*) or ask Genie *What does the FizzCo Holiday Refresh contract say about make-goods, and is one owed?* Afterwards click **Remove uploaded IO** to reset. |
| **8. Value** | Dashboard, ROI Model | Avoided make-goods (from the data) plus analyst hours (labelled as an assumption). The basis column separates data from assumptions. |

## The three "why" questions (Genie)

| Ask | Genie should find |
| --- | --- |
| *Why is FizzCo Summer Fuel-Up so far behind pace?* | Screens were mostly offline at 15 high-traffic Southwest sites from about 6 weeks before "today" for 3 weeks (uptime about 33%). That cost about **446K impressions ($5.6K), roughly 43% of the pace gap**. Every Southwest campaign dipped in the same weeks, so it's a network issue on the retailer's side. That's why a make-good is owed. |
| *Why is FizzCo Holiday Refresh critical when it still has 10 days left?* | Creative was approved **5 days after flight start**, with no impressions before then, and **16 of its 19 sites are suburban**, where traffic is low. Urban and highway sites have room, so rebalancing is the fix. |
| *Why do suburban sites underperform on impressions?* | Suburban sites average about **170 fuel transactions a day, against about 2,200** at urban and highway sites (about 13x). Screen uptime is not the problem, since suburban uptime is 100%. It's traffic, which is why the app's rebalance shifts delivery to high-traffic sites. |

Genie's wording varies from run to run; the numbers don't. Stick to the scripted questions in front of an audience.

## Share with an advertiser (Delta Sharing)

Show the advertiser the same governed numbers, live, instead of a CSV or screenshots. This needs a metastore admin, or the `CREATE SHARE` and `CREATE RECIPIENT` privileges:

```sql
CREATE VIEW <catalog>.retail_media.v_fizzco_campaign_delivery AS
  SELECT campaign_name, start_date, end_date, contracted_impressions, delivered_impressions,
         delivery_rate_pct, pace_adjusted_pct, days_remaining, risk_level
  FROM <catalog>.retail_media.v_campaign_delivery WHERE advertiser = 'FizzCo';
CREATE SHARE fizzco_retail_media;
ALTER SHARE fizzco_retail_media ADD VIEW <catalog>.retail_media.v_fizzco_campaign_delivery;
CREATE RECIPIENT fizzco;            -- prints an activation link for the advertiser
GRANT SELECT ON SHARE fizzco_retail_media TO RECIPIENT fizzco;
```

## Fallbacks

- **App slow on first load:** the warehouse is warming up. The dashboard shows the same numbers.
- **Genie tab unavailable:** use the Genie space directly in the workspace.
- **A rehearsal left extra actions:** click **Reset demo**.

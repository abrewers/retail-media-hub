# Databricks notebook source
# MAGIC %md
# MAGIC # Retail Media Hub: setup
# MAGIC
# MAGIC One idempotent notebook that builds everything under the app. It runs as the bundle job `rmcc_setup` and is safe to re-run.
# MAGIC
# MAGIC | Step | What it does |
# MAGIC | --- | --- |
# MAGIC | 1. Preflight | Checks the warehouse type, AI Functions, Lakebase, and the app. Stops with a plain message if something is missing |
# MAGIC | 2. Demo date | Writes `cfg_demo_config.as_of_date`, the single switch that freezes or rolls the demo |
# MAGIC | 3. Generate data | (`generate_data=true`) Builds sites, campaigns, daily site activity and impressions from `config/seed_config.yml` |
# MAGIC | 4. Contract PDFs | (`generate_data=true`) Renders the insertion orders (IOs) into the volume. Make-good terms exist **only** in the PDF text |
# MAGIC | 5. Views + metric views | Defines delivery, shortfall, pace and risk **once**, in Unity Catalog |
# MAGIC | 6. Extract contracts | `ai_parse_document` + `ai_extract` on new or changed PDFs only, merged into `dim_contract_terms` |
# MAGIC | 7. Genie agent | Creates or updates the Genie space; grants the app and viewers access |
# MAGIC | 8. Validate | Headline KPIs, the three "why" stories, extraction vs. config, Genie smoke test |
# MAGIC
# MAGIC To connect real data instead of synthetic data: set `generate_data=false` and point `source_catalog` / `source_schema` at tables with the same shape (for example a Snowflake foreign catalog). See README.md.

# COMMAND ----------

# MAGIC %pip install -q fpdf2==2.8.3 pyyaml "psycopg[binary]>=3.1" -U databricks-sdk
# MAGIC %restart_python

# COMMAND ----------

# DBTITLE 1,Parameters
import datetime as dt
import json
import os
import time

import numpy as np
import pandas as pd
import yaml
from databricks.sdk import WorkspaceClient

for name, default in [
    ("catalog", ""), ("schema", "retail_media"), ("source_catalog", ""), ("source_schema", ""),
    ("volume", "contracts"), ("config_path", ""), ("as_of_date", ""), ("generate_data", "true"),
    ("warehouse_id", ""), ("app_name", ""), ("lakebase_project", ""), ("viewer_group", "users"),
    ("genie_title", "Retail Media Hub"), ("run_genie_check", "true"),
    ("strict_extraction_check", "true"), ("retailer_name", ""),
]:
    dbutils.widgets.text(name, default)

P = {k: dbutils.widgets.get(k).strip() for k in [
    "catalog", "schema", "source_catalog", "source_schema", "volume", "config_path", "as_of_date",
    "generate_data", "warehouse_id", "app_name", "lakebase_project", "viewer_group", "genie_title",
    "run_genie_check", "strict_extraction_check", "retailer_name"]}
assert P["catalog"], "catalog is required"
P["source_catalog"] = P["source_catalog"] or P["catalog"]
P["source_schema"] = P["source_schema"] or P["schema"]
truthy = lambda v: v.lower() in ("true", "1", "yes")
GENERATE = truthy(P["generate_data"])

q = lambda *parts: ".".join(f"`{p}`" for p in parts)          # quoted identifier
G = q(P["catalog"], P["schema"])                                  # governed schema: cfg, views, metric views, contract terms
S = q(P["source_catalog"], P["source_schema"])                    # source tables (synthetic, or your own)
G_RAW = f"{P['catalog']}.{P['schema']}"                            # unquoted, for Genie and API identifiers
VOL = f"/Volumes/{P['catalog']}/{P['schema']}/{P['volume']}"

cfg_path = P["config_path"] or os.path.abspath(os.path.join(os.getcwd(), "..", "..", "config", "seed_config.yml"))
CFG = yaml.safe_load(open(cfg_path))
RETAILER = P["retailer_name"] or CFG["retailer"]["name"]          # branding: app header, store names, IO PDFs, Genie
def _brand(o):
    if isinstance(o, str): return o.replace("{retailer}", RETAILER)
    if isinstance(o, list): return [_brand(x) for x in o]
    if isinstance(o, dict): return {k: _brand(v) for k, v in o.items()}
    return o
CFG = _brand(CFG)
CFG["retailer"]["name"] = RETAILER
AS_OF = dt.date.fromisoformat(P["as_of_date"]) if P["as_of_date"] else dt.date.today()
w = WorkspaceClient()
print(f"retailer={RETAILER!r}  governed={G}  source={S}  volume={VOL}  as_of={AS_OF}  generate_data={GENERATE}")

# COMMAND ----------

# MAGIC %md ## 1. Preflight

# COMMAND ----------

checks = []
def check(name, fn, required=True):
    try:
        detail = fn() or "ok"
        checks.append((name, "PASS", detail))
    except Exception as e:  # noqa: BLE001 - report every failure, then decide
        checks.append((name, "FAIL" if required else "WARN", str(e).split("\n")[0][:300]))

def _warehouse():
    assert P["warehouse_id"], "warehouse_id parameter is empty"
    wh = w.warehouses.get(P["warehouse_id"])
    wtype = str(wh.warehouse_type.value if wh.warehouse_type else "")
    assert "REALTIME" not in wtype.upper(), (
        f"warehouse {wh.name} is type {wtype}; Lakehouse RT warehouses can't query metric views. "
        "Set the bundle variable warehouse_id to a Pro or Serverless SQL warehouse.")
    return f"{wh.name} ({wtype}, serverless={wh.enable_serverless_compute})"

def _ai_functions():
    for fn in ("ai_parse_document", "ai_extract"):
        spark.sql(f"DESCRIBE FUNCTION {fn}").collect()
    return "ai_parse_document, ai_extract available"

def _lakebase():
    if not P["lakebase_project"]:
        return "skipped (no lakebase_project parameter)"
    proj = w.postgres.get_project(name=f"projects/{P['lakebase_project']}")
    return f"project {proj.name} found"

def _app():
    if not P["app_name"]:
        return "skipped (no app_name parameter)"
    app = w.apps.get(P["app_name"])
    scopes = getattr(app, "user_api_scopes", None) or getattr(app, "effective_user_api_scopes", None) or []
    return f"app {app.name} found; user scopes: {', '.join(scopes) or 'none (the Apps user-authorization preview may be off)'}"

check("SQL warehouse is not Lakehouse RT", _warehouse)
check("AI Functions (PDF parsing and extraction)", _ai_functions)
check("Lakebase project (app write-back)", _lakebase)
check("Databricks App deployed", _app, required=False)
check("Governed schema exists", lambda: spark.sql(f"DESCRIBE SCHEMA {G}").collect() and "ok")
check("Contracts volume exists", lambda: os.listdir(VOL) is not None and "ok")

display(pd.DataFrame(checks, columns=["check", "result", "detail"]))
failed = [c for c in checks if c[1] == "FAIL"]
assert not failed, "Preflight failed: " + "; ".join(f"{c[0]}: {c[2]}" for c in failed) + " (see README.md, Requirements)"

# COMMAND ----------

# MAGIC %md ## 2. Demo date (`cfg_demo_config`)

# COMMAND ----------

spark.sql(f"""
CREATE TABLE IF NOT EXISTS {G}.cfg_demo_config (
  as_of_date DATE COMMENT 'The demo''s "today". Every view computes days remaining, pace and risk as of this date.',
  genie_space_id STRING COMMENT 'Genie space created by setup; read by the app at startup.',
  app_seed STRING COMMENT 'JSON demo seed rows for the app (from seed_config.yml app_seed); used on first start and by Reset demo data.',
  updated_at TIMESTAMP,
  retailer_name STRING COMMENT 'Retailer name shown in the app header and browser tab (setup parameter retailer_name).',
  extract_spec STRING COMMENT 'JSON: the contract extraction schema, instructions, contracts folder and sample IOs; used by the app to extract uploaded PDFs the same way setup does.')
COMMENT 'One-row demo settings. Change as_of_date to freeze or roll the demo; re-run setup to regenerate data for a new date.'""")
for col, comment in [("retailer_name", "Retailer name shown in the app header and browser tab."),        # tables created
                     ("extract_spec", "JSON contract extraction spec used by the app for uploaded PDFs.")]:  # before these columns
    if col not in spark.table(f"{G}.cfg_demo_config").columns:
        spark.sql(f"ALTER TABLE {G}.cfg_demo_config ADD COLUMNS ({col} STRING COMMENT '{comment}')")
prev = spark.table(f"{G}.cfg_demo_config").limit(1).collect()
GENIE_ID = prev[0].genie_space_id if prev else None
spark.sql(f"DELETE FROM {G}.cfg_demo_config")
genie_sql = f"'{GENIE_ID}'" if GENIE_ID else "NULL"
seed = dict(CFG["app_seed"], as_of_date=str(AS_OF))
sql_str = lambda v: "'" + v.replace("\\", "\\\\").replace("'", "\\'") + "'"
seed_sql = sql_str(json.dumps(seed))
spark.sql(f"INSERT INTO {G}.cfg_demo_config (as_of_date, genie_space_id, app_seed, updated_at, retailer_name) "
          f"VALUES (DATE'{AS_OF}', {genie_sql}, {seed_sql}, current_timestamp(), {sql_str(RETAILER)})")
print("as_of_date =", AS_OF, "| existing Genie space:", GENIE_ID)

# COMMAND ----------

# MAGIC %md ## 3. Generate synthetic data
# MAGIC Impressions are **derived from drivers**, never assigned: `fuel transactions x share of screens online x campaign share x noise`, then scaled per campaign to its delivered total. The "why" stories (screen outage, late creative approval, suburban traffic) live in the drivers, so Genie has to find them with normal SQL.

# COMMAND ----------

def generate():
    rng = np.random.default_rng(CFG["random_seed"])
    sc = CFG["sites"]
    d0 = AS_OF + dt.timedelta(days=CFG["data_start_offset"])
    days = pd.date_range(d0, AS_OF - dt.timedelta(days=1), freq="D")

    # --- sites ---
    rows, sid = [], 0
    for region, rc in sc["regions"].items():
        n = sc["per_region"]
        counts = {a: int(round(n * m)) for a, m in sc["archetype_mix"].items()}
        counts["suburban"] += n - sum(counts.values())
        archetypes = rng.permutation([a for a, c in counts.items() for _ in range(c)])
        for k, arch in enumerate(archetypes):
            sid += 1
            state, city = rc["state_cities"][k % len(rc["state_cities"])]
            pumps = int(rng.integers(sc["pumps"][arch][0], sc["pumps"][arch][1] + 1))
            rows.append(dict(site_id=sid, site_name=f"{CFG['retailer']['name']} {city} #{sid}", city=city, state=state,
                             region=region, archetype=arch, pump_count=pumps,
                             screens_installed=pumps * sc["screens_per_pump"],
                             base_tx=float(rng.uniform(*sc["daily_fuel_transactions"][arch]))))
    sites = pd.DataFrame(rows)

    # --- campaigns and site plans ---
    camps = pd.DataFrame(CFG["campaigns"]).rename(columns={"id": "campaign_id", "name": "campaign_name"})
    camps["start_date"] = camps.start_offset.map(lambda o: AS_OF + dt.timedelta(days=int(o)))
    camps["end_date"] = camps.end_offset.map(lambda o: AS_OF + dt.timedelta(days=int(o)))
    story = CFG["stories"]
    delay = {story["late_creative"]["campaign_id"]: story["late_creative"]["delay_days"]}
    camps["creative_approved_date"] = [r.start_date + dt.timedelta(days=delay.get(r.campaign_id, 0)) for r in camps.itertuples()]
    overrides = {int(k): v for k, v in story.get("site_plan_overrides", {}).items()}
    plan = []
    for c in camps.itertuples():
        pool = sites[sites.region == c.region]
        mix = overrides.get(c.campaign_id, sc["archetype_mix"])
        per_arch = pool.archetype.value_counts()
        p = pool.archetype.map(lambda a: mix[a] / per_arch[a]).to_numpy()
        chosen = rng.choice(pool.site_id.to_numpy(), size=min(c.sites, len(pool)), replace=False, p=p / p.sum())
        plan += [dict(campaign_id=c.campaign_id, site_id=int(s)) for s in sorted(chosen)]
    plan = pd.DataFrame(plan)

    # --- story 1: screen outage at the highest-traffic sites of the anchor campaign ---
    o = story["screen_outage"]
    anchor_sites = sites[sites.site_id.isin(plan[plan.campaign_id == o["anchor_campaign_id"]].site_id) & (sites.region == o["region"])]
    outage_sites = set(anchor_sites.nlargest(o["sites"], "base_tx").site_id)
    o_start = AS_OF + dt.timedelta(days=o["start_offset"])
    o_end = o_start + dt.timedelta(days=o["days"] - 1)

    # --- daily site activity ---
    act = sites[["site_id", "archetype", "screens_installed", "base_tx"]].merge(pd.DataFrame({"activity_date": days}), how="cross")
    weekend = act.activity_date.dt.dayofweek >= 5
    wf = act.archetype.map(sc["weekend_factor"]).where(weekend, 1.0)
    act["fuel_transactions"] = np.round(act.base_tx * wf * rng.uniform(0.9, 1.1, len(act))).astype(int)
    uptime = rng.uniform(*sc["baseline_uptime"], len(act))
    in_outage = act.site_id.isin(outage_sites) & act.activity_date.dt.date.between(o_start, o_end)
    uptime = np.where(in_outage, rng.uniform(*o["uptime"], len(act)), uptime)
    act["screens_online"] = np.maximum(np.round(act.screens_installed * uptime), 0).astype(int)

    # --- impressions: drivers, then scaled to each campaign's delivered total ---
    imps = []
    for c in camps.itertuples():
        live_start = max(c.creative_approved_date, d0)
        live_end = min(c.end_date, AS_OF - dt.timedelta(days=1))
        if c.status == "paused":
            live_end = min(live_end, c.start_date + dt.timedelta(days=CFG["paused_after_days"]))
        if c.delivered <= 0 or live_end < live_start:
            continue
        a = act[act.site_id.isin(plan[plan.campaign_id == c.campaign_id].site_id)
                & act.activity_date.dt.date.between(live_start, live_end)].copy()
        raw = a.fuel_transactions * a.screens_online / a.screens_installed * rng.uniform(0.85, 1.15, len(a))
        scaled = raw * (c.delivered / raw.sum())
        a["impression_count"] = np.floor(scaled).astype(np.int64)
        a.loc[scaled.idxmax(), "impression_count"] += int(c.delivered - a.impression_count.sum())
        a["campaign_id"] = c.campaign_id
        imps.append(a[["campaign_id", "site_id", "activity_date", "impression_count"]].rename(columns={"activity_date": "impression_date"}))
    imps = pd.concat(imps, ignore_index=True)
    imps = imps[imps.impression_count > 0]

    camps = camps[["campaign_id", "campaign_name", "advertiser", "region", "channel", "status", "start_date", "end_date",
                   "creative_approved_date", "contracted", "cpm"]].rename(columns={"contracted": "contracted_impressions", "cpm": "cpm_rate"})
    act = act[["site_id", "activity_date", "fuel_transactions", "screens_online"]]
    sites = sites.drop(columns=["base_tx"])
    return sites, camps, plan, act, imps, outage_sites

TABLE_DOCS = {
    "dim_sites": ("Retail sites with digital screens (one row per site). archetype drives traffic: suburban sites see far fewer fuel transactions than urban or highway sites.",
                  {"site_id": "Site identifier", "archetype": "urban, highway or suburban", "screens_installed": "Digital screens at the site (one per pump)", "region": "US region"}),
    "dim_campaigns": ("Retail media campaigns booked by advertisers (one row per campaign): contracted impressions, CPM and flight dates.",
                      {"contracted_impressions": "Impressions the advertiser bought", "cpm_rate": "Price per 1,000 impressions, USD",
                       "creative_approved_date": "Date the advertiser's creative was approved. No impressions run before it, even if the flight started earlier",
                       "status": "active, completed or paused"}),
    "dim_campaign_sites": ("Site plan: which sites each campaign is booked to run on.", {}),
    "fact_site_daily_activity": ("Daily operating data per site: fuel transactions (traffic) and how many screens were online.",
                                 {"fuel_transactions": "Fuel transactions that day (site traffic)",
                                  "screens_online": "Screens working that day. Compare with dim_sites.screens_installed for uptime"}),
    "fact_pump_impressions": ("Daily delivered ad impressions per campaign and site.", {"impression_count": "Impressions delivered that day"}),
}

def write(pdf, name, date_cols=()):
    pdf = pdf.copy()
    for col in date_cols:
        pdf[col] = pd.to_datetime(pdf[col]).dt.date
    spark.createDataFrame(pdf).write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{S}.{q(name)}")
    tdoc, cdocs = TABLE_DOCS[name]
    spark.sql(f"COMMENT ON TABLE {S}.{q(name)} IS '{tdoc.replace(chr(39), chr(39) * 2)}'")
    for col, doc in cdocs.items():
        spark.sql(f"ALTER TABLE {S}.{q(name)} ALTER COLUMN {col} COMMENT '{doc.replace(chr(39), chr(39) * 2)}'")
    print(f"{S}.{name}: {len(pdf):,} rows")

OUTAGE_SITES = set()
if GENERATE:
    sites, camps, plan, act, imps, OUTAGE_SITES = generate()
    write(sites, "dim_sites")
    write(camps, "dim_campaigns", ["start_date", "end_date", "creative_approved_date"])
    write(plan, "dim_campaign_sites")
    write(act, "fact_site_daily_activity", ["activity_date"])
    write(imps, "fact_pump_impressions", ["impression_date"])
else:
    print("generate_data=false: using existing source tables in", S)

# COMMAND ----------

# MAGIC %md ## 4. Contract PDFs (insertion orders)
# MAGIC The make-good terms are written into normal contract language. They are not stored in any table; step 6 has to extract them.

# COMMAND ----------

from fpdf import FPDF

def render_io(k, camp):
    r = CFG["retailer"]
    start, end = camp["start_date"], camp["end_date"]
    effective = AS_OF + dt.timedelta(days=k["effective_offset"])
    ci, cpm = int(camp["contracted_impressions"]), float(camp["cpm_rate"])
    trigger = int(round(ci * k["makegood_threshold_pct"] / 100))
    pdf = FPDF(format="Letter")
    # fixed metadata so an unchanged contract renders to identical bytes (keeps extraction incremental)
    pdf.set_creation_date(dt.datetime.combine(effective, dt.time(12, 0), tzinfo=dt.timezone.utc))
    pdf.set_producer("Retail Media Hub setup")
    pdf.set_margins(22, 20, 22)
    pdf.add_page()
    def h(text, size=11):
        pdf.set_font("Helvetica", "B", size); pdf.multi_cell(0, 6, text); pdf.ln(1)
    def p(text):
        pdf.set_font("Helvetica", "", 10); pdf.multi_cell(0, 5, text); pdf.ln(2)
    h(f"{r['network_name'].upper()} - INSERTION ORDER", 15)
    p(f"IO number: {k['io_number']}        Effective date: {effective:%B %d, %Y}")
    p(f"This Insertion Order (the \"IO\") is entered into between {r['publisher_legal_name']} (\"Publisher\"), operator of "
      f"the {r['network_name']} network, and {k['advertiser_legal_name']} (\"Advertiser\").")
    h("1. Campaign details")
    for label, value in [("Campaign name", camp["campaign_name"]), ("Flight start date", f"{start:%B %d, %Y}"),
                         ("Flight end date", f"{end:%B %d, %Y}"), ("Contracted impressions", f"{ci:,}"),
                         ("CPM rate", f"USD {cpm:,.2f}"), ("Total contract value", f"USD {ci * cpm / 1000:,.2f}"),
                         ("Geography", f"{camp['region']} region, participating {r['name']} sites"),
                         ("Delivery channel", str(camp["channel"]).replace("_", " "))]:
        pdf.set_font("Helvetica", "B", 10); pdf.cell(55, 6, label)
        pdf.set_font("Helvetica", "", 10); pdf.cell(0, 6, value, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)
    h("2. Delivery")
    p("Publisher will deliver the Contracted Impressions evenly across the flight on the participating sites. An impression "
      "is counted each time the Advertiser's creative is displayed in full on a working screen.")
    h("3. Make-good policy")
    p(f"3.1 If delivered impressions at the flight end date are below {k['makegood_threshold_pct']}% of the Contracted "
      f"Impressions ({trigger:,} impressions), Publisher shall deliver make-good impressions equal to the shortfall within "
      f"{k['makegood_window_days']} calendar days after the flight end date, at no additional cost to Advertiser.")
    p(f"3.2 If the shortfall exceeds {k['credit_option_shortfall_pct']}% of the Contracted Impressions, Advertiser may "
      f"instead elect {k['excess_remedy']}.")
    p(f"3.3 {k['special_terms']}")
    p("3.4 Publisher shall notify Advertiser in writing within five (5) business days of identifying a projected shortfall, "
      "including the cause where known.")
    h("4. Reporting")
    p("Publisher will provide weekly delivery reporting by site and day, and a final reconciliation within ten (10) business "
      "days after the flight end date.")
    h("5. Payment and cancellation")
    p("Invoices are issued monthly in arrears and payable net 45 days. Either party may cancel with fourteen (14) days' "
      "written notice; Advertiser pays for impressions delivered through the cancellation date.")
    h("6. Signatures")
    for party, who in [(r["publisher_legal_name"], r["publisher_signatory"]), (k["advertiser_legal_name"], k["advertiser_signatory"])]:
        p(f"For {party}:  {who['name']}, {who['title']}    Date: {effective:%B %d, %Y}")
    return bytes(pdf.output())

def pdf_name(k, camp):
    return f"{k['io_number']}_{camp['campaign_name'].lower().replace(' ', '_').replace('&', 'and')}.pdf"

if GENERATE:
    camp_rows = {r.campaign_id: r.asDict() for r in spark.table(f"{S}.dim_campaigns").collect()}
    for k in CFG["contracts"]:
        folder = os.path.join(VOL, k["folder"])
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, pdf_name(k, camp_rows[k["campaign_id"]]))
        data = render_io(k, camp_rows[k["campaign_id"]])
        if not (os.path.exists(path) and open(path, "rb").read() == data):   # unchanged PDFs keep their timestamp
            with open(path, "wb") as f:
                f.write(data)
        print(("contracts" if k["folder"] == "contracts" else "samples  ") + " ->", path)

# COMMAND ----------

# MAGIC %md ## 5. Views and metric views (business rules defined once)

# COMMAND ----------

spark.sql(f"""
CREATE OR REPLACE VIEW {G}.v_campaign_delivery
COMMENT 'One row per campaign as of cfg_demo_config.as_of_date: delivered, shortfall, pace and risk. The single definition used by the app, the dashboard and Genie.'
AS
WITH cfg AS (SELECT as_of_date FROM {G}.cfg_demo_config),
d AS (
  SELECT i.campaign_id, SUM(i.impression_count) AS delivered, MIN(i.impression_date) AS first_impression_date,
         COUNT(DISTINCT i.impression_date) AS days_live
  FROM {S}.fact_pump_impressions i CROSS JOIN cfg
  WHERE i.impression_date < cfg.as_of_date
  GROUP BY i.campaign_id),
b AS (
  SELECT c.*, cfg.as_of_date, COALESCE(d.delivered, 0) AS delivered_impressions, d.first_impression_date,
         COALESCE(d.days_live, 0) AS days_live,
         DATEDIFF(c.end_date, cfg.as_of_date) AS days_remaining,
         GREATEST(DATEDIFF(c.end_date, c.start_date), 1) AS flight_days,
         DATEDIFF(LEAST(cfg.as_of_date, c.end_date), c.start_date) AS elapsed_days,
         GREATEST(DATEDIFF(c.creative_approved_date, c.start_date), 0) AS creative_delay_days
  FROM {S}.dim_campaigns c CROSS JOIN cfg LEFT JOIN d USING (campaign_id)),
p AS (
  SELECT *, GREATEST(0, contracted_impressions - delivered_impressions) AS shortfall_impressions,
         ROUND(GREATEST(0, contracted_impressions - delivered_impressions) * cpm_rate / 1000.0, 2) AS shortfall_dollars,
         ROUND(delivered_impressions * 100.0 / contracted_impressions, 1) AS delivery_rate_pct,
         ROUND(delivered_impressions * 100.0 / contracted_impressions / (elapsed_days * 1.0 / flight_days), 1) AS pace_adjusted_pct
  FROM b)
SELECT *,
  CASE WHEN pace_adjusted_pct < 75 THEN 'Critical'
       WHEN pace_adjusted_pct < 85 THEN 'At Risk'
       WHEN pace_adjusted_pct > 110 THEN 'Over-Delivering'
       ELSE 'On Track' END AS risk_level
FROM p""")

spark.sql(f"""
CREATE OR REPLACE VIEW {G}.v_campaign_site_daily
COMMENT 'Campaign x site x day: impressions next to their drivers (fuel transactions, screens online). Use it to explain why delivery changed.'
AS
SELECT i.campaign_id, c.campaign_name, c.advertiser, c.status AS campaign_status, i.site_id, s.site_name, s.city, s.state,
       s.region, s.archetype, s.pump_count, i.impression_date, i.impression_count AS impressions, a.fuel_transactions,
       a.screens_online, s.screens_installed,
       ROUND(i.impression_count * s.screens_installed / GREATEST(a.screens_online, 1)) AS expected_impressions_full_uptime
FROM {S}.fact_pump_impressions i
JOIN {S}.dim_sites s USING (site_id)
JOIN {S}.dim_campaigns c USING (campaign_id)
JOIN {S}.fact_site_daily_activity a ON a.site_id = i.site_id AND a.activity_date = i.impression_date
WHERE i.impression_date < (SELECT as_of_date FROM {G}.cfg_demo_config)""")

def metric_view(name, yaml_body):
    spark.sql(f"CREATE OR REPLACE VIEW {G}.{q(name)} WITH METRICS LANGUAGE YAML AS $$\n{yaml_body}\n$$")
    print("metric view", name)

metric_view("metric_view_campaign_delivery", f"""
version: 1.1
comment: "Campaign delivery and make-good exposure as of the demo date. Risk thresholds: Critical below 75% pace, At Risk below 85%, Over-Delivering above 110%."
source: {G_RAW}.v_campaign_delivery
dimensions:
  - name: Campaign ID
    expr: campaign_id
  - name: Campaign Name
    expr: campaign_name
  - name: Advertiser
    expr: advertiser
  - name: Region
    expr: region
  - name: Channel
    expr: channel
  - name: Campaign Status
    expr: status
  - name: Days Remaining
    expr: days_remaining
  - name: Creative Delay Days
    expr: creative_delay_days
  - name: Risk Level
    expr: risk_level
measures:
  - name: Contracted Impressions
    expr: SUM(contracted_impressions)
  - name: Delivered Impressions
    expr: SUM(delivered_impressions)
  - name: Shortfall Impressions
    expr: SUM(shortfall_impressions)
  - name: Shortfall Dollars
    expr: SUM(shortfall_dollars)
  - name: Campaign Count
    expr: COUNT(1)
  - name: Campaigns At Risk
    expr: COUNT(1) FILTER (WHERE pace_adjusted_pct < 85)
  - name: Campaigns Over-Delivering
    expr: COUNT(1) FILTER (WHERE pace_adjusted_pct > 110)
  - name: Delivery Rate
    expr: SUM(delivered_impressions) * 100.0 / SUM(contracted_impressions)
  - name: Pace Adjusted Pct
    expr: SUM(delivered_impressions) * 100.0 / SUM(contracted_impressions) / (SUM(elapsed_days) * 1.0 / SUM(flight_days))
""")

metric_view("metric_view_site_delivery", f"""
version: 1.1
comment: "Daily delivery by campaign and site with its drivers. Screen uptime and fuel transactions explain why impressions rise or fall."
source: {G_RAW}.v_campaign_site_daily
dimensions:
  - name: Campaign Name
    expr: campaign_name
  - name: Advertiser
    expr: advertiser
  - name: Campaign Status
    expr: campaign_status
  - name: Site Name
    expr: site_name
  - name: City
    expr: city
  - name: Region
    expr: region
  - name: Site Archetype
    expr: archetype
  - name: Impression Date
    expr: impression_date
  - name: Impression Week
    expr: DATE_TRUNC('WEEK', impression_date)
measures:
  - name: Impressions
    expr: SUM(impressions)
  - name: Fuel Transactions
    expr: SUM(fuel_transactions)
  - name: Screen Uptime Pct
    expr: SUM(screens_online) * 100.0 / SUM(screens_installed)
  - name: Impressions per 1K Transactions
    expr: SUM(impressions) * 1000.0 / SUM(fuel_transactions)
  - name: Expected Impressions at Full Uptime
    expr: SUM(expected_impressions_full_uptime)
  - name: Impressions Lost to Downtime
    expr: SUM(expected_impressions_full_uptime - impressions)
  - name: Site Days
    expr: COUNT(1)
""")

# COMMAND ----------

# MAGIC %md ## 6. Extract contract terms from the PDFs
# MAGIC Incremental: only PDFs that are new or changed since the last extraction get an AI call. Drop a signed IO into `contracts/` and re-run the job.

# COMMAND ----------

FIELDS = {
    "io_number": {"type": "string"},
    "campaign_name": {"type": "string"},
    "advertiser_legal_name": {"type": "string", "description": "Legal entity name of the Advertiser party"},
    "effective_date": {"type": "string", "description": "IO effective date, YYYY-MM-DD"},
    "flight_start_date": {"type": "string", "description": "YYYY-MM-DD"},
    "flight_end_date": {"type": "string", "description": "YYYY-MM-DD"},
    "contracted_impressions": {"type": "integer"},
    "cpm_rate": {"type": "number", "description": "CPM rate in USD"},
    "total_contract_value": {"type": "number", "description": "Total contract value in USD"},
    "makegood_threshold_pct": {"type": "number", "description": "Delivery % of contracted impressions below which a make-good is owed, e.g. 100, 95 or 90"},
    "makegood_window_days": {"type": "integer", "description": "Calendar days after flight end to deliver make-good impressions"},
    "credit_option_shortfall_pct": {"type": "number", "description": "Shortfall % above which the Advertiser may elect a credit or other remedy instead of make-good impressions"},
    "excess_shortfall_remedy": {"type": "string", "description": "The remedy the Advertiser may elect when the shortfall exceeds credit_option_shortfall_pct, verbatim"},
    "special_terms": {"type": "string", "description": "Any additional make-good condition or exception (section 3.3), verbatim"},
    "makegood_clause_summary": {"type": "string", "description": "One-sentence plain-English summary of the make-good obligation: threshold, window and credit option"},
    "makegood_policy_text": {"type": "string", "description": "The full make-good policy section text, verbatim"},
    "publisher_signatory_name": {"type": "string"},
    "publisher_signatory_title": {"type": "string"},
    "advertiser_signatory_name": {"type": "string"},
    "advertiser_signatory_title": {"type": "string"},
}
CASTS = {"contracted_impressions": "BIGINT", "makegood_window_days": "INT", "effective_date": "DATE",
         "flight_start_date": "DATE", "flight_end_date": "DATE", "cpm_rate": "DOUBLE", "total_contract_value": "DOUBLE",
         "makegood_threshold_pct": "DOUBLE", "credit_option_shortfall_pct": "DOUBLE"}
INSTR = ("These are retail media advertising insertion orders (IOs) between a retailer (Publisher) and a brand "
         "(Advertiser). Extract values exactly as stated in the document; return null for anything not stated.")

col_ddl = ",\n  ".join(f"{c} {CASTS.get(c, 'STRING')}" for c in FIELDS)
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {G}.dim_contract_terms (
  campaign_id INT COMMENT 'From the c<id>__ file-name prefix (app uploads), else matched to dim_campaigns by campaign name',
  {col_ddl},
  source_file STRING COMMENT 'The PDF these terms were extracted from',
  file_modified TIMESTAMP,
  extracted_at TIMESTAMP,
  uploaded_by STRING COMMENT 'Who uploaded the PDF in the app; NULL for PDFs placed by setup')
COMMENT 'Contract terms extracted from signed IO PDFs with ai_parse_document and ai_extract. One row per contract; source_file traces each row to its PDF.'""")

if "uploaded_by" not in spark.table(f"{G}.dim_contract_terms").columns:
    spark.sql(f"ALTER TABLE {G}.dim_contract_terms ADD COLUMNS (uploaded_by STRING COMMENT 'Who uploaded the PDF in the app')")
contracts_dir = f"{VOL}/contracts/"
os.makedirs(contracts_dir, exist_ok=True)
todo = spark.sql(f"""
  SELECT f.path, f.modificationTime AS file_modified
  FROM (SELECT _metadata.file_path AS path, _metadata.file_modification_time AS modificationTime
        FROM READ_FILES('{contracts_dir}', format => 'binaryFile', pathGlobFilter => '*.pdf')) f
  LEFT JOIN {G}.dim_contract_terms t ON t.source_file = f.path AND t.file_modified = f.modificationTime
  WHERE t.source_file IS NULL""").collect() if os.listdir(contracts_dir) else []
print(f"{len(todo)} new or changed PDF(s) to extract")

if todo:
    schema_str = json.dumps(FIELDS).replace("'", "''")
    paths = ", ".join(f"'{r.path}'" for r in todo)
    ext = spark.sql(f"""
      WITH files AS (
        SELECT _metadata.file_path AS path, _metadata.file_modification_time AS file_modified, content
        FROM READ_FILES('{contracts_dir}', format => 'binaryFile', pathGlobFilter => '*.pdf')),
      parsed AS (
        SELECT path, file_modified, ai_parse_document(content, MAP('version', '2.0')) AS parsed
        FROM files WHERE path IN ({paths}))
      SELECT path, file_modified,
             ai_extract(parsed, '{schema_str}', MAP('version', '2.1', 'instructions', '{INSTR}')) AS x
      FROM parsed""").collect()
    recs = []
    for r in ext:
        d = json.loads(r.x.toJson()) if hasattr(r.x, "toJson") else json.loads(r.x)
        assert d.get("error_message") is None, (r.path, d.get("error_message"))
        rec = {k: (v.get("value") if isinstance(v, dict) else v) for k, v in d["response"].items()}
        rec.update(source_file=r.path, file_modified=r.file_modified)
        recs.append(rec)
    new = pd.DataFrame(recs).reindex(columns=list(FIELDS) + ["source_file", "file_modified"])
    spark.createDataFrame(new.astype(object).where(new.notna(), None)).createOrReplaceTempView("new_terms")
    sel = ", ".join(f"CAST(n.{c} AS {CASTS[c]}) AS {c}" if c in CASTS else f"n.{c}" for c in FIELDS)
    spark.sql(f"""
      MERGE INTO {G}.dim_contract_terms t
      USING (SELECT COALESCE(CAST(NULLIF(regexp_extract(n.source_file, '/c([0-9]+)__[^/]*$', 1), '') AS INT), c.campaign_id) AS campaign_id,
                    {sel}, n.source_file, CAST(n.file_modified AS TIMESTAMP) AS file_modified,
                    current_timestamp() AS extracted_at, o.uploaded_by
             FROM new_terms n
             LEFT JOIN {S}.dim_campaigns c ON lower(trim(c.campaign_name)) = lower(trim(n.campaign_name))
             LEFT JOIN {G}.dim_contract_terms o ON o.source_file = n.source_file) s
      ON t.source_file = s.source_file
      WHEN MATCHED THEN UPDATE SET *
      WHEN NOT MATCHED THEN INSERT *""")

# contracts whose PDF was removed from the folder are removed from the table
spark.sql(f"""DELETE FROM {G}.dim_contract_terms WHERE source_file NOT IN
  (SELECT _metadata.file_path FROM READ_FILES('{contracts_dir}', format => 'binaryFile', pathGlobFilter => '*.pdf'))""") if os.listdir(contracts_dir) else None
display(spark.sql(f"SELECT campaign_id, campaign_name, makegood_threshold_pct, makegood_window_days, credit_option_shortfall_pct, makegood_clause_summary, source_file FROM {G}.dim_contract_terms ORDER BY campaign_id"))

# The app extracts PDFs uploaded on a campaign's Contract tab with this same spec (see contract-upload-routes.ts).
camp_names = {r.campaign_id: r.asDict() for r in spark.table(f"{S}.dim_campaigns").select("campaign_id", "campaign_name").collect()}
samples = {}
for k in CFG["contracts"]:
    if k["folder"] == "samples" and k["campaign_id"] in camp_names:
        sp_path = os.path.join(VOL, "samples", pdf_name(k, camp_names[k["campaign_id"]]))
        if os.path.exists(sp_path):
            samples[str(k["campaign_id"])] = sp_path
spec = {"fields": FIELDS, "casts": CASTS, "instructions": INSTR, "contracts_dir": contracts_dir, "samples": samples}
spark.sql(f"UPDATE {G}.cfg_demo_config SET extract_spec = {sql_str(json.dumps(spec))}, updated_at = current_timestamp()")
print("extract_spec written; sample IOs:", samples or "none")

# COMMAND ----------

# MAGIC %md ## 7. Genie agent
# MAGIC Created here rather than by the bundle because Genie rejects a space whose tables don't exist yet.

# COMMAND ----------

GENIE_TEXT = f"""## PURPOSE
- Answer {CFG['retailer']['network_name']} questions on campaign delivery, make-good exposure, the drivers behind delivery (traffic, screen uptime, creative timing) and advertiser contract terms.
- Users are retail media operations, sales and finance leaders; assume retail media fluency.

## DISAMBIGUATION
- "Today" is the as_of_date in cfg_demo_config. Never use CURRENT_DATE(); Days Remaining and Risk Level are already calculated as of that date.
- "At risk" means Risk Level 'At Risk' or 'Critical' (pace-adjusted delivery below 85%).
- "Shortfall" or "make-good exposure" means the Shortfall Dollars measure: the make-good cost if the campaign ended today.
- Default campaign questions to active campaigns unless the user asks about completed or paused ones.
- Contract, clause, IO, credit or signatory questions use dim_contract_terms. Cite source_file when quoting terms.

## ANSWERING "WHY" QUESTIONS
- Break the gap down by its drivers using metric_view_site_delivery: Screen Uptime Pct and Impressions Lost to Downtime (screens offline), Fuel Transactions and Impressions per 1K Transactions (traffic), by Region, Site Archetype and Impression Week.
- Check creative timing in metric_view_campaign_delivery (Creative Delay Days): no impressions run before the creative is approved.
- Quantify each driver in impressions and dollars (impressions x CPM / 1000) and say how much of the gap it explains.
- Compare site archetypes on Fuel Transactions per site day and Screen Uptime Pct. If uptime is similar but traffic differs, the gap is traffic, not screens; moving delivery to high-traffic sites (rebalancing) is the fix.

## SUMMARIES
- State totals in USD rounded to whole dollars and percentages to one decimal place.
- For recommendation questions, present the supporting numbers first, then a clearly labelled suggestion for human review.
"""

WHY_QUESTIONS = [
    "Why is FizzCo Summer Fuel-Up so far behind pace?",
    "Why is FizzCo Holiday Refresh critical when it still has 10 days left?",
    "Why do suburban sites underperform on impressions?",
]
SAMPLES = WHY_QUESTIONS + [
    "Which active campaigns are most at risk of a make-good, and how much is the shortfall?",
    "What does the FizzCo Summer Fuel-Up contract say about make-goods, and is one owed today?",
]
mvc, mvs = f"{G_RAW}.metric_view_campaign_delivery", f"{G_RAW}.metric_view_site_delivery"
EXAMPLES = [
    ("Which active campaigns are most at risk of a make-good, and how much is the shortfall?",
     f"SELECT `Campaign Name`, `Advertiser`, `Risk Level`, `Days Remaining`, MEASURE(`Delivery Rate`) AS delivery_rate, "
     f"MEASURE(`Shortfall Dollars`) AS shortfall_dollars FROM {mvc} WHERE `Campaign Status` = 'active' "
     f"AND `Risk Level` IN ('Critical', 'At Risk') GROUP BY ALL ORDER BY shortfall_dollars DESC"),
    ("How did screen uptime and impressions change by week for FizzCo Summer Fuel-Up in each region?",
     f"SELECT `Impression Week`, `Region`, MEASURE(`Screen Uptime Pct`) AS uptime_pct, MEASURE(`Impressions`) AS impressions, "
     f"MEASURE(`Impressions Lost to Downtime`) AS lost_to_downtime FROM {mvs} WHERE `Campaign Name` = 'FizzCo Summer Fuel-Up' "
     f"GROUP BY ALL ORDER BY `Impression Week`, `Region`"),
    ("How do traffic, screen uptime and impressions compare by site archetype?",
     f"SELECT `Site Archetype`, MEASURE(`Fuel Transactions`) / MEASURE(`Site Days`) AS avg_daily_transactions, "
     f"MEASURE(`Impressions`) / MEASURE(`Site Days`) AS avg_daily_impressions, MEASURE(`Screen Uptime Pct`) AS uptime_pct "
     f"FROM {mvs} WHERE `Campaign Status` = 'active' GROUP BY ALL ORDER BY avg_daily_transactions DESC"),
]

def nid(i):
    return f"{i:032x}"

space = {
    "version": 2,
    "config": {"sample_questions": [{"id": nid(i + 1), "question": [t]} for i, t in enumerate(SAMPLES)]},
    "data_sources": {"tables": sorted([{"identifier": f"{G_RAW}.{t}"} for t in
        ["metric_view_campaign_delivery", "metric_view_site_delivery", "dim_contract_terms", "cfg_demo_config"]] +
        [{"identifier": f"{P['source_catalog']}.{P['source_schema']}.{t}"} for t in ["dim_campaigns", "dim_sites"]],
        key=lambda t: t["identifier"])},
    "instructions": {
        "text_instructions": [{"id": nid(100), "content": [GENIE_TEXT]}],
        "example_question_sqls": [{"id": nid(200 + i), "question": [qq], "sql": [s]} for i, (qq, s) in enumerate(EXAMPLES)],
        "join_specs": [{"id": nid(300),
                        "left": {"identifier": f"{G_RAW}.dim_contract_terms", "alias": "dim_contract_terms"},
                        "right": {"identifier": f"{P['source_catalog']}.{P['source_schema']}.dim_campaigns", "alias": "dim_campaigns"},
                        "sql": ["`dim_contract_terms`.`campaign_id` = `dim_campaigns`.`campaign_id`", "--rt=FROM_RELATIONSHIP_TYPE_MANY_TO_ONE--"]}],
    },
}
body = {"title": P["genie_title"], "warehouse_id": P["warehouse_id"], "serialized_space": json.dumps(space),
        "description": f"{CFG['retailer']['network_name']}: campaign delivery, make-good exposure, delivery drivers and IO contract terms."}

def space_exists(sid):
    try:
        w.api_client.do("GET", f"/api/2.0/genie/spaces/{sid}")
        return True
    except Exception:  # noqa: BLE001
        return False

if GENIE_ID and space_exists(GENIE_ID):
    # Keep the existing title: Genie suffixes a timestamp when another space in the folder has the same title,
    # and renaming back to the plain title would fail with AlreadyExists.
    w.api_client.do("PATCH", f"/api/2.0/genie/spaces/{GENIE_ID}", body={k: v for k, v in body.items() if k != "title"})
    print("updated Genie space", GENIE_ID)
else:
    GENIE_ID = w.api_client.do("POST", "/api/2.0/genie/spaces", body=body)["space_id"]
    print("created Genie space", GENIE_ID)
spark.sql(f"UPDATE {G}.cfg_demo_config SET genie_space_id = '{GENIE_ID}', updated_at = current_timestamp()")

# access for the app's service principal (required) and for viewers (best effort)
# The all-users group is "users" in workspace ACLs (Genie) and "account users" in Unity Catalog.
grants = []  # (genie ACL key, genie principal, UC principal, required)
if P["app_name"]:
    try:
        sp = w.apps.get(P["app_name"]).service_principal_client_id
        grants.append(("service_principal_name", sp, sp, True))
    except Exception as e:  # noqa: BLE001
        print("app not found yet, skipping app grants (re-run setup after deploying the app):", e)
if P["viewer_group"]:
    g = P["viewer_group"]
    all_users = g.lower() in ("users", "account users")
    grants.append(("group_name", "users" if all_users else g, "account users" if all_users else g, False))
GRANT_WARNINGS = []
for kind, genie_principal, uc_principal, required in grants:
    try:
        w.api_client.do("PATCH", f"/api/2.0/permissions/genie/{GENIE_ID}",
                        body={"access_control_list": [{kind: genie_principal, "permission_level": "CAN_RUN"}]})
        who = f"`{uc_principal}`"
        schemas = {(P["catalog"], P["schema"]), (P["source_catalog"], P["source_schema"])}
        for cat in {c for c, _ in schemas}:
            spark.sql(f"GRANT USE CATALOG ON CATALOG {q(cat)} TO {who}")
        for cat, sch in schemas:
            spark.sql(f"GRANT USE SCHEMA, SELECT ON SCHEMA {q(cat, sch)} TO {who}")
        if required:   # the app: write uploaded IO PDFs and their extracted terms
            spark.sql(f"GRANT READ VOLUME, WRITE VOLUME ON VOLUME {q(P['catalog'], P['schema'], P['volume'])} TO {who}")
            spark.sql(f"GRANT MODIFY ON TABLE {G}.dim_contract_terms TO {who}")
        print(f"granted Genie CAN_RUN to {genie_principal} and SELECT to {uc_principal}" + (" (+ contract upload)" if required else ""))
    except Exception as e:  # noqa: BLE001
        if required:
            raise
        GRANT_WARNINGS.append(f"viewer grant for {uc_principal} skipped: {str(e).splitlines()[0][:200]}")
        print("WARNING:", GRANT_WARNINGS[-1])

# Lakebase: the app creates its write-back schema (app_ops) and AppKit's cache schema (appkit) on
# first start. If the app is ever recreated it gets a new service principal that can't use what the
# previous one created. Grant the current app identity full use of app_ops (keeps the action history)
# and drop the disposable appkit cache so the app rebuilds it.
if P["app_name"] and P["lakebase_project"]:
    import psycopg
    app_sp = w.apps.get(P["app_name"]).service_principal_client_id
    branch = f"projects/{P['lakebase_project']}/branches/production"
    ep = next(iter(w.postgres.list_endpoints(parent=branch)))
    token = w.postgres.generate_database_credential(endpoint=ep.name).token
    me = w.current_user.me().user_name
    with psycopg.connect(host=ep.status.hosts.host, port=5432, dbname="databricks_postgres", user=me,
                         password=token, sslmode="require", autocommit=True) as pg:
        owner = lambda sch: (pg.execute("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = %s", (sch,)).fetchone() or [None])[0]
        if not pg.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (app_sp,)).fetchone():
            print("app role not in Lakebase yet (the app hasn't started); nothing to grant")
        else:
            if owner("app_ops") not in (None, app_sp):
                for stmt in (f'GRANT USAGE, CREATE ON SCHEMA app_ops TO "{app_sp}"',
                             f'GRANT ALL ON ALL TABLES IN SCHEMA app_ops TO "{app_sp}"',
                             f'GRANT ALL ON ALL SEQUENCES IN SCHEMA app_ops TO "{app_sp}"'):
                    pg.execute(stmt)
                print(f"Lakebase app_ops: granted to the current app identity ({app_sp})")
            if owner("appkit") not in (None, app_sp):
                try:
                    pg.execute("DROP SCHEMA appkit CASCADE")
                    print("Lakebase appkit cache from a previous app identity dropped; the app rebuilds it on start")
                except Exception as e:  # noqa: BLE001
                    GRANT_WARNINGS.append(f"could not reset the appkit cache schema: {str(e).splitlines()[0][:200]}")

# COMMAND ----------

# MAGIC %md ## 8. Validate

# COMMAND ----------

results = []
def expect(name, ok, detail):
    results.append((name, "OK" if ok else "FAIL", detail))

for msg in GRANT_WARNINGS:
    results.append(("Viewer access", "WARN", msg))

k = spark.sql(f"""SELECT MEASURE(`Campaign Count`) n, MEASURE(`Campaigns At Risk`) at_risk,
  MEASURE(`Campaigns Over-Delivering`) over, ROUND(MEASURE(`Shortfall Dollars`)) sf
  FROM {G}.metric_view_campaign_delivery WHERE `Campaign Status` = 'active'""").first()
expect("Headline KPIs", k.n > 0 and k.sf > 0, f"{k.n} active, {k.at_risk} at risk, {k.over} over-delivering, ${k.sf:,.0f} shortfall")

if GENERATE:
    # story 1: outage share of the anchor campaign's pace gap
    a1 = CFG["stories"]["screen_outage"]["anchor_campaign_id"]
    c1 = spark.sql(f"SELECT * FROM {G}.v_campaign_delivery WHERE campaign_id = {a1}").first()
    lost = spark.sql(f"SELECT SUM(expected_impressions_full_uptime - impressions) l FROM {G}.v_campaign_site_daily WHERE campaign_id = {a1}").first().l
    expected_to_date = c1.contracted_impressions * c1.elapsed_days / c1.flight_days
    gap = expected_to_date - c1.delivered_impressions
    expect("Story 1: screen outage", lost > 0 and gap > 0,
           f"{c1.campaign_name}: {c1.delivery_rate_pct}% delivered, {c1.days_remaining} days left; lost to downtime "
           f"{lost:,.0f} impressions (${lost * c1.cpm_rate / 1000:,.0f}) = {lost / gap * 100:.0f}% of the {gap:,.0f}-impression pace gap")
    # story 2: late creative
    c3 = spark.sql(f"SELECT * FROM {G}.v_campaign_delivery WHERE campaign_id = {CFG['stories']['late_creative']['campaign_id']}").first()
    sub = spark.sql(f"""SELECT ROUND(AVG(CASE WHEN s.archetype = 'suburban' THEN 1.0 ELSE 0 END) * 100) pct
                        FROM {S}.dim_campaign_sites p JOIN {S}.dim_sites s USING (site_id) WHERE p.campaign_id = {c3.campaign_id}""").first().pct
    expect("Story 2: late creative", c3.creative_delay_days > 0 and c3.risk_level == "Critical",
           f"{c3.campaign_name}: {c3.risk_level}, {c3.days_remaining} days left, creative {c3.creative_delay_days} days late, "
           f"first impression {c3.first_impression_date}, {sub:.0f}% of planned sites suburban")
    # story 3: traffic, not screens (uptime compared outside the outage sites)
    outage_list = ",".join(str(x) for x in OUTAGE_SITES) or "-1"
    arch = {r.archetype: r for r in spark.sql(f"""SELECT archetype, SUM(fuel_transactions) / COUNT(1) tx_per_day,
        SUM(impressions) / COUNT(1) imp_per_day,
        SUM(CASE WHEN site_id NOT IN ({outage_list}) THEN screens_online END) * 100.0
          / SUM(CASE WHEN site_id NOT IN ({outage_list}) THEN screens_installed END) uptime
        FROM {G}.v_campaign_site_daily WHERE campaign_status = 'active' GROUP BY archetype""").collect()}
    ratio = arch["urban"].tx_per_day / arch["suburban"].tx_per_day
    up_gap = max(r.uptime for r in arch.values()) - min(r.uptime for r in arch.values())
    expect("Story 3: suburban traffic", ratio >= 5 and up_gap < 3,
           f"urban sites get {ratio:.0f}x the daily transactions of suburban sites and {arch['urban'].imp_per_day / arch['suburban'].imp_per_day:.0f}x "
           f"the impressions; screen uptime differs by only {up_gap:.1f} points across archetypes")

    # extraction vs config
    terms = {r.campaign_id: r for r in spark.table(f"{G}.dim_contract_terms").collect()}
    for kk in [c for c in CFG["contracts"] if c["folder"] == "contracts"]:
        t = terms.get(kk["campaign_id"])
        ok = t is not None and (t.makegood_threshold_pct, t.makegood_window_days, t.credit_option_shortfall_pct) == (
            kk["makegood_threshold_pct"], kk["makegood_window_days"], kk["credit_option_shortfall_pct"])
        got = "missing" if t is None else f"{t.makegood_threshold_pct:g}% / {t.makegood_window_days} days / {t.credit_option_shortfall_pct:g}%"
        expect(f"Extraction: {kk['io_number']}", ok, f"extracted {got}; config {kk['makegood_threshold_pct']}% / "
               f"{kk['makegood_window_days']} days / {kk['credit_option_shortfall_pct']}%")

if truthy(P["run_genie_check"]):
    for question in WHY_QUESTIONS:
        try:
            m = w.api_client.do("POST", f"/api/2.0/genie/spaces/{GENIE_ID}/start-conversation", body={"content": question})
            cid, mid = m["conversation_id"], m["message_id"]
            for _ in range(60):
                msg = w.api_client.do("GET", f"/api/2.0/genie/spaces/{GENIE_ID}/conversations/{cid}/messages/{mid}")
                if msg["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
                    break
                time.sleep(5)
            text = " ".join(a.get("text", {}).get("content", "") for a in msg.get("attachments", []) if a.get("text"))
            has_sql = any(a.get("query") for a in msg.get("attachments", []))
            expect(f"Genie: {question}", msg["status"] == "COMPLETED" and has_sql, (text or msg["status"])[:300])
        except Exception as e:  # noqa: BLE001
            expect(f"Genie: {question}", False, str(e)[:300])

display(pd.DataFrame(results, columns=["check", "result", "detail"]))
bad = [r for r in results if r[1] == "FAIL" and (truthy(P["strict_extraction_check"]) or not r[0].startswith("Extraction"))]
assert not bad, "Validation failed: " + "; ".join(r[0] for r in bad)
print("Setup complete. Genie space:", GENIE_ID)

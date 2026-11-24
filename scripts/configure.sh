#!/usr/bin/env bash
# Retail Media Hub: guided setup.
#
# Picks the workspace, SQL warehouse, catalog and schema, checks that the app and Lakebase names
# are free, asks the optional variables (with recommendations), writes targets/<name>.yml and
# can then validate, deploy, run setup and start the app for you.
#
# Usage:  ./scripts/configure.sh
# Works with macOS bash 3.2, Linux and WSL. Needs the Databricks CLI and jq (or python3).
set -euo pipefail

cd "$(dirname "$0")/.."

# Prompts read the user's answers from fd 3 (the original stdin), because menus get their options on a pipe.
exec 3<&0

# ---------- output helpers ----------
if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B= D= G= Y= R= N=; fi
say()   { printf '%s\n' "$*"; }
head1() { printf '\n%s== %s ==%s\n' "$B" "$*" "$N"; }
ok()    { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn()  { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
die()   { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# ask "Question" "default" -> echoes the answer (default if empty)
ask() {
  local q="$1" def="${2:-}" a
  if [ -n "$def" ]; then printf '%s %s[%s]%s: ' "$q" "$D" "$def" "$N" >&2; else printf '%s: ' "$q" >&2; fi
  IFS= read -r a <&3 || true
  printf '%s' "${a:-$def}"
}

# yesno "Question" "Y|N" -> returns 0 for yes
yesno() {
  local q="$1" def="$2" a hint
  [ "$def" = "Y" ] && hint="Y/n" || hint="y/N"
  printf '%s [%s]: ' "$q" "$hint" >&2
  IFS= read -r a <&3 || true
  a="${a:-$def}"
  case "$a" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# choose "Prompt" "default_index" < lines   (lines: "value<TAB>label") -> echoes the chosen value
choose() {
  local prompt="$1" def="${2:-1}" i=0 line pick
  local values=() labels=()
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    values+=("${line%%$'\t'*}")
    labels+=("${line#*$'\t'}")
  done
  [ "${#values[@]}" -gt 0 ] || die "nothing to choose from for: $prompt"
  for i in "${!values[@]}"; do printf '  %2d) %s\n' "$((i + 1))" "${labels[$i]}" >&2; done
  while :; do
    pick=$(ask "$prompt (1-${#values[@]})" "$def")
    if [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "${#values[@]}" ]; then
      printf '%s' "${values[$((pick - 1))]}"
      return
    fi
    warn "Enter a number between 1 and ${#values[@]}." >&2
  done
}

# json <jq filter> : jq if available, else python3 with a few supported filters
json() {
  if command -v jq >/dev/null 2>&1; then jq -r "$1"; return; fi
  python3 -c '
import json, sys
f = sys.argv[1]; d = json.load(sys.stdin)
rows = {
 "profiles": lambda: [f"{p[\"name\"]}\t{p.get(\"host\",\"\")}" for p in d.get("profiles", [])],
 "warehouses": lambda: ["\t".join(str(w.get(k, "")) for k in ("id","name","warehouse_type","enable_serverless_compute","state","cluster_size")) for w in d],
 "catalogs": lambda: [c["name"] for c in d if c.get("catalog_type") == "MANAGED_CATALOG"],
 "user": lambda: [d.get("userName", "")],
}[f]()
print("\n".join(rows))' "$2"
}

# Non-interactive CLI calls must not read stdin (they would swallow the user's typed or piped answers).
dbx() { databricks "$@" </dev/null; }

# ---------- 0. prerequisites ----------
head1 "Checking tools"
command -v databricks >/dev/null 2>&1 || die "Databricks CLI not found. Install: https://docs.databricks.com/dev-tools/cli/install.html"
cli_ver=$(dbx --version 2>/dev/null | sed -E 's/.*v([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
major=${cli_ver%%.*}; rest=${cli_ver#*.}; minor=${rest%%.*}
if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 17 ]; }; then
  die "Databricks CLI v$cli_ver is too old; v1.17 or later is required (brew upgrade databricks, or see the install link)."
fi
ok "Databricks CLI v$cli_ver"
if command -v jq >/dev/null 2>&1; then ok "jq"; elif command -v python3 >/dev/null 2>&1; then ok "python3 (jq not found; using python3)"; else die "Install jq or python3."; fi

# ---------- 1. workspace ----------
head1 "1. Workspace"
say "Pick a Databricks CLI profile, or sign in to a new workspace."
profiles=$(dbx auth profiles --skip-validate -o json 2>/dev/null | json '.profiles[] | "\(.name)\t\(.host)"' profiles || true)
choice=$( { [ -n "$profiles" ] && printf '%s\n' "$profiles" | awk -F'\t' '{printf "%s\t%s  %s\n", $1, $1, $2}'; printf '__new__\tSign in to a new workspace\n'; } | choose "Workspace" 1)
if [ "$choice" = "__new__" ]; then
  host=$(ask "Workspace URL (e.g. https://adb-1234567890123456.7.azuredatabricks.net)" "")
  host="${host%/}"
  [[ "$host" =~ ^https:// ]] || die "The workspace URL must start with https://"
  profile=$(ask "Name for this CLI profile" "rmcc")
  databricks auth login --host "$host" --profile "$profile"
else
  profile="$choice"
fi
me=$(dbx current-user me --profile "$profile" -o json 2>/dev/null | json '.userName' user) || true
if [ -z "${me:-}" ]; then
  warn "Profile '$profile' isn't signed in (or its login expired)."
  yesno "Sign in now in the browser?" "Y" || die "Sign in with: databricks auth login --profile $profile, then re-run."
  host=$(dbx auth profiles --skip-validate -o json | json '.profiles[] | "\(.name)\t\(.host)"' profiles | awk -F'\t' -v p="$profile" '$1==p{print $2}')
  databricks auth login --host "$host" --profile "$profile"
  me=$(dbx current-user me --profile "$profile" -o json | json '.userName' user)
fi
host=$(dbx auth profiles --skip-validate -o json | json '.profiles[] | "\(.name)\t\(.host)"' profiles | awk -F'\t' -v p="$profile" '$1==p{print $2}')
host="${host%/}"
ok "Signed in to $host as $me (profile: $profile)"

# ---------- 2. SQL warehouse ----------
head1 "2. SQL warehouse"
say "Used by the app, the dashboard and Genie. ${B}Recommended: a serverless Pro warehouse.${N} Lakehouse RT warehouses can't query metric views and are not listed."
wh_rows=$(dbx warehouses list --profile "$profile" -o json | json '.[] | "\(.id)\t\(.name)\t\(.warehouse_type)\t\(.enable_serverless_compute)\t\(.state)\t\(.cluster_size)"' warehouses)
usable=$(printf '%s\n' "$wh_rows" | awk -F'\t' '$3 != "REALTIME" && $1 != ""')
[ -n "$usable" ] || die "No Pro or Serverless SQL warehouse found. Ask an admin to create one (SQL > SQL Warehouses), then re-run."
best=$(printf '%s\n' "$usable" | awk -F'\t' '{ s = ($4=="true" ? 2 : 0) + ($3=="PRO" ? 1 : 0); print s "\t" NR }' | sort -t$'\t' -k1,1nr -k2,2n | head -1 | cut -f2)
warehouse_id=$(printf '%s\n' "$usable" | awk -F'\t' -v best="$best" '{
  kind = ($4=="true" ? "serverless " : "") tolower($3)
  rec = (NR==best ? "  <- recommended" : "")
  printf "%s\t%-34s %-16s %-8s %s%s\n", $1, $2, kind, $6, tolower($5), rec }' | choose "Warehouse" "$best")
ok "Warehouse $warehouse_id"

# ---------- 3. catalog ----------
head1 "3. Catalog"
say "The bundle creates a new schema in this catalog (you need USE CATALOG and CREATE SCHEMA on it)."
cats=$(dbx catalogs list --profile "$profile" -o json | json '.[] | select(.catalog_type=="MANAGED_CATALOG") | .name' catalogs)
[ -n "$cats" ] || die "No catalogs found that you can create a schema in. Ask an admin for one."
def_cat=$(printf '%s\n' "$cats" | awk '$0=="main"{print NR; exit}'); def_cat=${def_cat:-1}
catalog=$(printf '%s\n' "$cats" | awk '{printf "%s\t%s\n", $0, $0}' | choose "Catalog" "$def_cat")
ok "Catalog $catalog"

# ---------- 4. names (must be unique) ----------
head1 "4. Names"
exists_schema()  { dbx schemas get "$catalog.$1" --profile "$profile" >/dev/null 2>&1; }
exists_app()     { dbx apps get "$1" --profile "$profile" >/dev/null 2>&1; }
exists_project() { dbx postgres get-project "projects/$1" --profile "$profile" >/dev/null 2>&1; }
free_name() {  # free_name <check-fn> <base> <sep> -> base, or base<sep>2, <sep>3 ...
  local fn="$1" base="$2" sep="$3" n=2 cand="$2"
  while "$fn" "$cand"; do cand="${base}${sep}${n}"; n=$((n + 1)); done
  printf '%s' "$cand"
}
pick_name() {  # pick_name <label> <check-fn> <base> <sep> <regex> <rule>
  local label="$1" fn="$2" base="$3" sep="$4" re="$5" rule="$6" sug val
  sug=$(free_name "$fn" "$base" "$sep")
  [ "$sug" != "$base" ] && say "  ${D}'$base' already exists in this workspace; suggesting '$sug'.${N}" >&2
  while :; do
    val=$(ask "$label" "$sug")
    if ! [[ "$val" =~ $re ]]; then warn "$rule" >&2; continue; fi
    if "$fn" "$val"; then warn "'$val' already exists; pick another name." >&2; continue; fi
    printf '%s' "$val"; return
  done
}
schema=$(pick_name "Schema (created by the bundle)" exists_schema "retail_media" "_" '^[a-z][a-z0-9_]{0,62}$' "Use lowercase letters, numbers and underscores.")
app_name=$(pick_name "App name" exists_app "retail-media-hub" "-" '^[a-z][a-z0-9-]{1,25}$' "Use lowercase letters, numbers and hyphens, 26 characters max.")
lakebase_project=$(pick_name "Lakebase project ID" exists_project "retail-media-hub-ops" "-" '^[a-z][a-z0-9-]{1,62}$' "Use lowercase letters, numbers and hyphens.")
ok "Schema $catalog.$schema · app $app_name · Lakebase project $lakebase_project"

# ---------- 5. optional variables ----------
head1 "5. Optional settings"

say ""
say "${B}Retailer name (retailer_name)${N}: shown in the app header and browser tab, and used for store names,"
say "  the retailer's own-brand campaigns and the publisher on the generated contract PDFs."
say "  Recommended: your retail media network's retailer name. Empty = the fictional \"Waypoint Fuel & Market\"."
while :; do
  retailer_name=$(ask "retailer_name" "")
  [ "${#retailer_name}" -le 40 ] && break
  warn "Keep it to 40 characters or fewer."
done

say ""
say "${B}Demo date (as_of_date)${N}: the demo's \"today\". Days left, pace and risk are calculated as of this date."
say "  Recommended: leave empty, so it's the day setup runs and the demo always looks current."
say "  Set a date (YYYY-MM-DD) only to freeze the numbers for a specific presentation."
while :; do
  as_of_date=$(ask "as_of_date (empty = setup day)" "")
  [ -z "$as_of_date" ] || [[ "$as_of_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && break
  warn "Use YYYY-MM-DD, or leave it empty."
done

say ""
say "${B}Data source (generate_data)${N}"
say "  Recommended: synthetic data (yes). It builds the full demo story: campaigns, sites, contracts, the \"why\" cases."
say "  Choose no only if you already have tables with the same shape (see README, Connect real data)."
source_catalog=""; source_schema=""
if yesno "Generate synthetic demo data?" "Y"; then
  generate_data="true"
else
  generate_data="false"
  say "  Where are your source tables (dim_campaigns, dim_sites, dim_campaign_sites, fact_pump_impressions, fact_site_daily_activity)?"
  source_catalog=$(ask "  Source catalog" "$catalog")
  source_schema=$(ask "  Source schema" "")
  [ -n "$source_schema" ] || die "A source schema is required when generate_data is false."
  dbx tables get "$source_catalog.$source_schema.dim_campaigns" --profile "$profile" >/dev/null 2>&1 \
    && ok "Found $source_catalog.$source_schema.dim_campaigns" \
    || warn "$source_catalog.$source_schema.dim_campaigns not found; setup will fail until the source tables exist."
fi

say ""
say "${B}Who can see it (viewer_group)${N}: this group gets read access to the demo data and the Genie space."
say "  Recommended: 'users' (everyone in the workspace) for a demo; the data is synthetic."
say "  Use a specific group to limit access, or 'none' so only you and the app can see it."
viewer_group=$(ask "viewer_group ('users', a group name, or 'none')" "users")
[ "$viewer_group" = "none" ] && viewer_group=""

# ---------- 6. write the target ----------
head1 "6. Write the target file"
target=$(ask "Target name (used as -t <name>)" "mine")
[[ "$target" =~ ^[a-zA-Z0-9_-]+$ ]] || die "Use letters, numbers, hyphens or underscores for the target name."
file="targets/$target.yml"
if [ -e "$file" ]; then
  cp "$file" "$file.bak"; warn "$file existed; saved a copy as $file.bak"
fi
{
  printf '# Written by scripts/configure.sh on %s. Re-run the script to change it.\n' "$(date +%Y-%m-%d)"
  printf 'targets:\n  %s:\n    workspace:\n      host: %s\n    variables:\n' "$target" "$host"
  printf '      catalog: %s\n      schema: %s\n      warehouse_id: "%s"\n' "$catalog" "$schema" "$warehouse_id"
  printf '      app_name: %s\n      lakebase_project: %s\n' "$app_name" "$lakebase_project"
  printf '      as_of_date: "%s"\n      generate_data: "%s"\n' "$as_of_date" "$generate_data"
  printf '      source_catalog: "%s"\n      source_schema: "%s"\n' "$source_catalog" "$source_schema"
  printf '      viewer_group: "%s"\n' "$viewer_group"
  printf '      retailer_name: "%s"\n' "$(printf '%s' "$retailer_name" | sed 's/[\\"]/\\&/g')"
} > "$file"
ok "Wrote $file"
sed 's/^/    /' "$file"

# ---------- 7. validate / deploy / setup / app ----------
head1 "7. Deploy"
run() { say "${D}\$ $*${N}"; "$@"; }
run dbx bundle validate -t "$target" --profile "$profile" || die "Validation failed; fix $file and re-run."
if yesno "Deploy the bundle now (creates the schema, volume, Lakebase project, app, job and dashboard)?" "Y"; then
  run databricks bundle deploy -t "$target" --profile "$profile"
  if yesno "Run setup now (about 5-10 minutes: data, PDFs, views, AI extraction, Genie)?" "Y"; then
    run databricks bundle run rmcc_setup -t "$target" --profile "$profile"
    if yesno "Start the app now?" "Y"; then
      run databricks bundle run rmcc_app -t "$target" --profile "$profile"
      say ""
      ok "Done. Open the app URL above and approve the Permission Requested prompt the first time."
      say "Next: README step 9 lists what each screen should show."
      exit 0
    fi
  fi
fi
say ""
say "Next steps (README steps 6-8):"
say "  databricks bundle deploy -t $target --profile $profile"
say "  databricks bundle run rmcc_setup -t $target --profile $profile"
say "  databricks bundle run rmcc_app -t $target --profile $profile"

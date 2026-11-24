#!/usr/bin/env bash
# Fails if the repo contains names or identifiers that shouldn't be published.
# Run before every push:  ./scripts/check_anonymized.sh
# Patterns: the generic list below, plus scripts/denylist.local if present (git-ignored; one extended
# regex per line, # for comments). Put real brand, customer, people and workspace names there.
# Binary files (images) are skipped: compressed bytes give false matches. Check images by eye.
set -euo pipefail
cd "$(dirname "$0")/.."
PATTERN='@databricks\.com|cloud\.databricks\.com/\?o=|dapi[0-9a-f]{32}'
if [ -f scripts/denylist.local ]; then
  extra=$(grep -v -E '^\s*(#|$)' scripts/denylist.local | paste -sd '|' -)
  [ -z "$extra" ] || PATTERN="$PATTERN|$extra"
fi
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  files=$(git ls-files --cached --others --exclude-standard)
else
  files=$(find . -type f -not -path './.databricks/*' -not -path '*/node_modules/*' -not -path '*/dist/*' \
          -not -path './targets/local.yml' -not -name 'build.log' -not -name '*.png' -not -name '*.ico')
fi
hits=$(echo "$files" | grep -v -E '(^|/)(pnpm-lock\.yaml|check_anonymized\.sh|denylist\.local)$' | xargs grep -I -n -i -E "$PATTERN" 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "Anonymization check FAILED:"; echo "$hits"; exit 1
fi
echo "Anonymization check passed ($(echo "$files" | wc -l | tr -d ' ') files$([ -f scripts/denylist.local ] && echo ', with scripts/denylist.local'))."

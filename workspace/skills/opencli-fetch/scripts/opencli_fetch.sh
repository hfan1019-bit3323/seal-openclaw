#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <url> [output_dir]" >&2
  exit 64
fi

URL="$1"
OUTDIR="${2:-./exports/opencli-fetch}"
mkdir -p "$OUTDIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
SLUG="$(printf '%s' "$URL" | sed 's#https\?://##' | tr '/:?&=%' '-' | tr -cd '[:alnum:]-._' | cut -c1-80)"
JOBDIR="$OUTDIR/${STAMP}-${SLUG}"
mkdir -p "$JOBDIR"

if ! command -v opencli >/dev/null 2>&1; then
  cat <<EOF
status=error
mode=opencli
reason=opencli_not_installed
message=OpenCLI is not installed.
EOF
  exit 69
fi

set +e
opencli web read --url "$URL" --output "$JOBDIR" -f json >"$JOBDIR/result.json" 2>"$JOBDIR/error.log"
RC=$?
set -e

if [[ $RC -eq 0 ]]; then
  MD_FILE="$(find "$JOBDIR" -type f \( -name '*.md' -o -name '*.markdown' \) | head -n 1 || true)"
  JSON_FILE="$JOBDIR/result.json"
  echo "status=ok"
  echo "mode=opencli"
  echo "jobdir=$JOBDIR"
  [[ -n "$MD_FILE" ]] && echo "markdown_file=$MD_FILE"
  [[ -f "$JSON_FILE" ]] && echo "json_file=$JSON_FILE"
  exit 0
fi

if rg -q "Browser Bridge extension not connected|BROWSER_CONNECT" "$JOBDIR/error.log" 2>/dev/null; then
  cat <<EOF
status=error
mode=opencli
reason=browser_bridge_not_connected
message=OpenCLI is installed, but Browser Bridge is not connected.
jobdir=$JOBDIR
error_log=$JOBDIR/error.log
EOF
  exit 69
fi

cat <<EOF
status=error
mode=opencli
reason=opencli_failed
message=OpenCLI fetch failed.
jobdir=$JOBDIR
error_log=$JOBDIR/error.log
EOF
exit $RC

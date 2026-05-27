#!/usr/bin/env bash
set -euo pipefail

PACKAGE_PATH="${1:?Package path is required}"
PRE_RELEASE_FLAG="${2:-}"
VSCE_PAT="${VSCE_PAT:?VSCE_PAT must be set}"

max_attempts="${VSCE_MAX_ATTEMPTS:-4}"
initial_delay_seconds="${VSCE_INITIAL_DELAY_SECONDS:-15}"

attempt=1
delay_seconds="$initial_delay_seconds"

while true; do
  echo "Publishing VSIX to Marketplace (attempt ${attempt}/${max_attempts})..."

  publish_args=(--packagePath "$PACKAGE_PATH" --pat "$VSCE_PAT")
  if [ "$PRE_RELEASE_FLAG" = "--pre-release" ]; then
    publish_args=(--pre-release "${publish_args[@]}")
  fi

  if npx @vscode/vsce publish "${publish_args[@]}"; then
    echo "Marketplace publish completed."
    exit 0
  fi

  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "Marketplace publish failed after ${attempt} attempts."
    exit 1
  fi

  echo "Marketplace publish failed. Retrying in ${delay_seconds}s..."
  sleep "$delay_seconds"
  attempt=$((attempt + 1))
  delay_seconds=$((delay_seconds * 2))
done

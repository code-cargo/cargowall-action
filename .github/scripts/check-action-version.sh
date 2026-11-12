#!/usr/bin/env bash
# Fails unless ACTION_VERSION, in src/version.ts and in the built dist, equals
# the release tag given, with any -rc.N suffix removed. The setup log prints it
# as the action's version, so a release must carry its own.
set -euo pipefail

tag="${1:?usage: check-action-version.sh <tag>}"
want="${tag%-rc.*}"

src=$(sed -n "s/^export const ACTION_VERSION = '\([^']*\)'.*/\1/p" src/version.ts)
if [ "$src" != "$want" ]; then
  echo "::error::src/version.ts has ACTION_VERSION '$src', but tag $tag needs '$want'. Bump ACTION_VERSION in the release PR."
  exit 1
fi
if ! grep -qF "ACTION_VERSION = \"$want\"" dist/main/index.js; then
  echo "::error::dist/main/index.js doesn't carry ACTION_VERSION '$want'. Run npm run build and commit dist/."
  exit 1
fi
echo "ACTION_VERSION $want matches tag $tag"

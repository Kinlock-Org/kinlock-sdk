#!/bin/sh
# If REGISTRY_GIT_URL is set, clone the public registry and point REGISTRY_DIR at
# REGISTRY_SUBDIR inside it (e.g. "fixtures" on testnet). Registry changes apply on restart.
set -eu
if [ -n "${REGISTRY_GIT_URL:-}" ]; then
  rm -rf /tmp/registry
  git clone --quiet --depth 1 "$REGISTRY_GIT_URL" /tmp/registry
  REGISTRY_DIR="/tmp/registry/${REGISTRY_SUBDIR:-.}"
  export REGISTRY_DIR
  echo "registry: $(git -C /tmp/registry rev-parse --short HEAD) -> $REGISTRY_DIR"
fi
exec "$@"

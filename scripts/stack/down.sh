#!/usr/bin/env bash
# Stops the local stack and deletes its data volume.
set -euo pipefail
cd "$(dirname "$0")/../.."
JWT_SECRET=unused docker compose -f scripts/stack/compose.yml down -v --remove-orphans

#!/usr/bin/env bash
# Create the parallel-agent work-queue labels.
# Requires a gh token with `Issues: write` on the repo (a fine-grained PAT needs
# the "Issues" repository permission set to Read and write).
# Run once: bash .github/setup-labels.sh
set -euo pipefail

gh label create ready       --color 0E8A16 --description "Groomed, grabbable by an agent"      --force
gh label create in-progress --color FBCA04 --description "Claimed (assignee) and being worked"  --force
gh label create review      --color 1D76DB --description "PR open, awaiting review/merge"       --force
gh label create blocked     --color B60205 --description "Waiting on a dependency or decision"  --force

echo "Labels created."

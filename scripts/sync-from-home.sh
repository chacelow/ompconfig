#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
omp_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"

cp -p "$omp_agent_dir/config.yml" "$repo_root/omp/agent/config.yml"
cp -p "$HOME/.claude/CLAUDE.md" "$repo_root/claude/CLAUDE.md"
rm -rf "$repo_root/skills/finding-unknowns"
cp -R "$omp_agent_dir/skills/finding-unknowns" "$repo_root/skills/finding-unknowns"

echo "Updated tracked configuration. Review with: git diff --check && git diff"

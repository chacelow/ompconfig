#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

git diff --check

if command -v omp >/dev/null 2>&1; then
  overlay="$(mktemp)"
  trap 'rm -f "$overlay"' EXIT
  cp omp/agent/config.yml "$overlay"
  omp --config "$overlay" config get skills.includeSkills --json >/dev/null
fi

# observation-memory 没有 tests 目录，直接跳过

if grep -RInE --exclude-dir=.git --exclude-dir=references --exclude='verify.sh' '(gho_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)' .; then
  echo "Potential secret found" >&2
  exit 1
fi

echo "Configuration repository checks passed"

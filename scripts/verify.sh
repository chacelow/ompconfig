#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Whitespace / EOL 一致性
git diff --check

# Secret grep（api key / private key 意外提交）
if grep -RInE --exclude-dir=.git --exclude-dir=references --exclude='verify.sh' '(gho_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)' .; then
  echo "Potential secret found" >&2
  exit 1
fi

echo "OK"

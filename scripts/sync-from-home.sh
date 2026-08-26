#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
omp_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"

# 本仓库不追踪 config.yml / settings.json / models.yml — 只 sync 可分享的
# Skills / Extensions / CLAUDE.md。

# CLAUDE.md：把本机改动 push 到仓库。
if [[ -f "$HOME/.claude/CLAUDE.md" ]]; then
  cp -p "$HOME/.claude/CLAUDE.md" "$repo_root/claude/CLAUDE.md"
fi

# 追踪的 Matt Pocock Chinese skills（还有个人 override 的三个）
matt_skills=(
  ask-matt code-review codebase-design diagnosing-bugs domain-modeling
  grill-with-docs implement improve-codebase-architecture prototype research
  resolving-merge-conflicts setup-matt-pocock-skills tdd to-spec to-tickets
  triage wayfinder wizard git-guardrails-claude-code migrate-to-shoehorn
  scaffold-exercises setup-pre-commit grill-me grilling handoff teach
  to-questionnaire wait-what writing-for-agents claude-handoff loop-me
  setup-ts-deep-modules writing-beats writing-fragments writing-shape
)

tracked_skills=(finding-unknowns youtube-transcript "${matt_skills[@]}")

for skill in "${tracked_skills[@]}"; do
  [[ -f "$repo_root/skills/$skill/SKILL.md" ]] || {
    echo "Missing tracked skill: $skill" >&2
    exit 1
  }
done

# Extensions：把本机改动 push 到仓库。
extensions_root="$repo_root/extensions"
mkdir -p "$extensions_root"
for extension in observation-memory; do
  src="$omp_agent_dir/extensions/$extension"
  if [[ ! -d "$src" ]]; then
    echo "Missing tracked extension: $extension" >&2
    exit 1
  fi
  dest="$extensions_root/$extension"
  rm -rf "$dest"
  cp -R "$src" "$dest"
done

echo "Synced: CLAUDE.md + skills + extensions（config 类文件由每台机器自己维护）"

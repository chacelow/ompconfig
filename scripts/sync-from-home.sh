#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
omp_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"

cp -p "$omp_agent_dir/config.yml" "$repo_root/omp/agent/config.yml"
cp -p "$HOME/.claude/CLAUDE.md" "$repo_root/claude/CLAUDE.md"
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
  rm -rf "$repo_root/skills/$skill"
  if [[ -d "$omp_agent_dir/skills/$skill" ]]; then
    cp -R "$omp_agent_dir/skills/$skill" "$repo_root/skills/$skill"
  elif [[ -d "$HOME/.agents/skills/$skill" ]]; then
    cp -R "$HOME/.agents/skills/$skill" "$repo_root/skills/$skill"
  else
    echo "Missing tracked skill: $skill" >&2
    exit 1
  fi
done

for skill in "${matt_skills[@]}"; do
  [[ -f "$repo_root/skills/$skill/SKILL.md" ]] || {
    echo "Incomplete Matt skill snapshot: $skill" >&2
    exit 1
  }
done

echo "Updated tracked configuration. Review with: git diff --check && git diff"

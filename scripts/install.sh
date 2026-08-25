#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
omp_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
claude_dir="$HOME/.claude"

backup_file() {
  local target="$1"
  if [[ -e "$target" && ! -L "$target" ]]; then
    cp -p "$target" "$target.backup.$(date +%Y%m%d%H%M%S)"
  fi
}

install_file() {
  local source="$1"
  local target="$2"
  mkdir -p "$(dirname "$target")"
  backup_file "$target"
  cp -p "$source" "$target"
}

install_tree() {
  local source="$1"
  local target="$2"
  mkdir -p "$(dirname "$target")"
  if [[ -e "$target" && ! -d "$target" ]]; then
    echo "Refusing to replace non-directory: $target" >&2
    exit 1
  fi
  rm -rf "$target"
  cp -R "$source" "$target"
}


install_file "$repo_root/omp/agent/config.yml" "$omp_agent_dir/config.yml"
install_file "$repo_root/claude/CLAUDE.md" "$claude_dir/CLAUDE.md"
for skill_dir in "$repo_root"/skills/*; do
  install_tree "$skill_dir" "$HOME/.agents/skills/$(basename "$skill_dir")"
done

if command -v uv >/dev/null 2>&1; then
  uv tool install yt-dlp || echo "Warning: yt-dlp installation failed" >&2
elif ! command -v yt-dlp >/dev/null 2>&1; then
  echo "Warning: install yt-dlp to use youtube-transcript" >&2
fi

if command -v omp >/dev/null 2>&1; then
  omp plugin marketplace add MohamedAbdallah-14/unslop || true
  omp plugin install --scope user unslop@unslop-marketplace || true
fi

echo "Installed OMP configuration from $repo_root"

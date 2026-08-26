#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
omp_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
claude_dir="$HOME/.claude"

# 只在目标缺失时创建；已存在则不动，让用户显式 sync。
install_file_if_missing() {
  local source="$1"
  local target="$2"
  mkdir -p "$(dirname "$target")"
  if [[ -e "$target" ]]; then
    if ! cmp -s "$source" "$target"; then
      echo "[skip] $target 已存在且内容不同；仓库版本未强制覆盖。" >&2
      echo "  想 pull 仓库改动：cp -p '$source' '$target'（先备份）" >&2
    fi
    return 0
  fi
  cp -p "$source" "$target"
  echo "[install] $target"
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

# CLAUDE.md：只在缺失时创建，不覆盖用户改动。
install_file_if_missing "$repo_root/claude/CLAUDE.md" "$claude_dir/CLAUDE.md"

# Skills：直接覆盖到 ~/.agents/skills/（每个 skill 是独立目录，覆盖是预期行为）。
for skill_dir in "$repo_root"/skills/*; do
  install_tree "$skill_dir" "$HOME/.agents/skills/$(basename "$skill_dir")"
done

# Extensions：直接覆盖到 ~/.omp/agent/extensions/。
extensions_root="$repo_root/extensions"
if [[ -d "$extensions_root" ]]; then
  for src in "$extensions_root"/*; do
    [[ -d "$src" ]] || continue
    name="$(basename "$src")"
    dest="$omp_agent_dir/extensions/$name"
    mkdir -p "$(dirname "$dest")"
    rm -rf "$dest"
    cp -R "$src" "$dest"
    # tsconfig / SPEC / tests 只在仓库里存在，不进 runtime。
    rm -rf "$dest/SPEC.md" "$dest/tests" "$dest/tsconfig.json"
  done
fi

# 外部依赖（best-effort，需要网络）
if command -v uv >/dev/null 2>&1; then
  uv tool install yt-dlp || echo "Warning: yt-dlp installation failed" >&2
elif ! command -v yt-dlp >/dev/null 2>&1; then
  echo "Warning: install yt-dlp to use youtube-transcript" >&2
fi

if command -v omp >/dev/null 2>&1; then
  omp plugin marketplace add MohamedAbdallah-14/unslop || true
  omp plugin install --scope user unslop@unslop-marketplace || true
fi

echo ""
echo "已装：Skills + Extensions + CLAUDE.md（缺失才装）"
echo "本仓库不管 config.yml / settings.json / models.yml — 那是每台机器自己的私有配置。"

# ompconfig

Private source repository for personal OMP and Claude agent configuration.

## Tracked

- `omp/agent/config.yml`: portable OMP settings and skill allowlist
- `claude/CLAUDE.md`: global agent instructions
- `skills/`: personally maintained skills
- `plugins/manifest.yml`: third-party marketplace/plugin declarations
- `scripts/`: install, sync, and verification commands
- Matt Pocock Chinese bundle: all 35 upstream skills are vendored; `ask-matt`, `grilling`, and `prototype` contain personal overrides
- `youtube-transcript`: vendored from `amosblomqvist/pi-config`, adapted for multilingual captions; requires `yt-dlp`
- `extensions/observation-memory/`: pi-observational-memory 的 in-process 移植（用 OMP native subagent 替换独立子进程 IPC，`/om` 二级下拉，中文 UI）

Runtime databases, sessions, memories, caches, credentials, and machine-local MCP paths are intentionally excluded.

## Install on a machine

```bash
./scripts/install.sh
```

Existing configuration files are copied to timestamped backups before replacement. Installation restores every vendored Skill directly, so the Matt Pocock bundle does not depend on upstream network access. Third-party plugin installation remains best-effort because it requires network access.

## Capture local changes

```bash
./scripts/sync-from-home.sh
./scripts/verify.sh
git diff
```

Commit only after reviewing the diff.

## Update another machine

```bash
git pull --ff-only
./scripts/install.sh
```

## 在另一台电脑上让 agent 帮你同步

把下面这段贴给另一台电脑的 OMP/Claude agent，它会跑完整个流程：

````
帮我在这台电脑上同步 ompconfig 私有仓库的配置：

1. 确保 bun + git + ssh key 已配好（`gh auth status` 能看到 chacelow 或
   你已经 `git@github.com:chacelow/ompconfig.git` 能 SSH pull）。
2. `git clone git@github.com:chacelow/ompconfig.git ~/code/ompconfig`
   （如果已存在 → cd 进去 `git pull --ff-only`）
3. 如果 omp CLI 还没装：`bun i -g @oh-my-pi/pi-coding-agent`
4. `cd ~/code/ompconfig && ./scripts/install.sh`
   - 会拷 config.yml、CLAUDE.md、skills/、extensions/ 到 `~/.omp/agent/`
   - 已有配置会自动备份成 `.backup.<timestamp>`
5. 装 provider credentials（install.sh 不同步这个，避免 leak）：
   `omp auth` 或按你原本的登录流程走。至少配置 config.yml 里
   `defaultProvider` 指到的 provider。
6. 验证：`./scripts/verify.sh`
7. 起 `omp`，随便对话一句确认 provider 通了。
8. 想开观察记忆：`/om default on` 一次性设置，以后新会话自动启用。

**不会**从仓库同步的（各自机器独立）：
  * API keys / OAuth credentials（`auth.json`、`agent.db` 里的 provider tokens）
  * session 历史（`~/.omp/agent/sessions/`、`agent.db`）
  * Mnemopi 数据库（`~/.omp/agent/memory-*`）
  * blobs / cache
  * project-local `.omp/` 目录（那是每个项目自己的）
````

粘完后 agent 一般会问你确认关键步骤（比如 install.sh 会覆盖），照它提示走就行。

## Scope rule

Keep cross-project preferences here. Put project-specific instructions, MCP servers, and skills in that project's `.omp/` directory.

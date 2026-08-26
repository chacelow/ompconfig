# ompconfig

个人 OMP + Claude Agent 配置的私有源仓库。

## Scope（明确不管什么）

**只追踪可分享的资产**：

- `claude/CLAUDE.md`：agent 指令（缺失才装、不覆盖用户改动）
- `skills/`：手写 + vendored 的 Skill
- `extensions/`：OMP extension（当前只有 `observation-memory`）
- `plugins/manifest.yml`：第三方 marketplace / plugin 声明
- `scripts/`：install / sync / verify

**明确不追踪**（每台机器自己维护、避免任何跨机器覆盖）：

- `~/.omp/agent/config.yml`
- `~/.omp/agent/settings.json`
- `~/.omp/agent/models.yml`
- `~/.omp/agent/auth.json`
- `~/.omp/agent/agent.db` 及所有 SQLite / blobs / sessions / memory

之前版本里我把 `omp/agent/config.yml` 也 track 了、install 会硬覆盖 —— 现在收窄，`config.yml` 类文件永远由每台机器自己私有维护。

## 装到新机器

```bash
./scripts/install.sh
```

- CLAUDE.md：缺失才创建、已存在会 skip 并提示
- Skills：直接覆盖 `~/.agents/skills/<name>`
- Extensions：直接覆盖 `~/.omp/agent/extensions/<name>`

## 把本机改动 push 回仓库

```bash
./scripts/sync-from-home.sh
```

只同步 CLAUDE.md + skills + extensions，配置文件不动。

## Verify

```bash
./scripts/verify.sh
```

只做两件事：whitespace check + secret grep。

## 在另一台电脑上让 agent 帮你同步

贴给另一台电脑上的 OMP/Claude agent：

````
帮我在这台电脑上同步 ompconfig 私有仓库的配置：

1. `gh auth status` 或 SSH key 就绪
2. `git clone git@github.com:chacelow/ompconfig.git ~/code/ompconfig`
   （已存在 → `git pull --ff-only`）
3. omp 没装：`bun i -g @oh-my-pi/pi-coding-agent`
4. `cd ~/code/ompconfig && ./scripts/install.sh`
5. Provider credentials 本地自己配（`omp` 里走登录流程），仓库不管
6. `./scripts/verify.sh` 走一遍
7. 起 `omp`，发一句话验证 provider 通
8. 想开观察记忆：`/om default on`
````

## 项目内还是全局？

- 跨项目、跨机器共享的偏好 → 这仓库
- 项目专属指令 / MCP server / Skill → 那个项目自己的 `.omp/`

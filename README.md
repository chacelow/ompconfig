# chacelow/ompconfig

一个 OMP plugin marketplace，聚合两个 plugin：

**`ompconfig`**（本仓库自带）
- Skills：Matt Pocock 中文全家桶（35 个）+ `youtube-transcript` + `finding-unknowns`
- Extension：`observation-memory` —— pi-observational-memory 的 in-process 移植

**`pi-vcc`**（引用 [sting8k/pi-vcc](https://github.com/sting8k/pi-vcc)）
- 算法压缩、无 LLM、30-470ms、零成本
- Invisible auto-continue（压完 agent 无缝续跑）
- `vcc_recall` lossless 读原始 JSONL 跨 compact 搜
- 267 stars 上游经过大量真实用户验证

## 装

```bash
omp plugin marketplace add chacelow/ompconfig
omp plugin install ompconfig@chacelow-ompconfig
omp plugin install pi-vcc@chacelow-ompconfig
```

一次搞定 skills + 你自己的 observation-memory + pi-vcc compact。

## 更新

```bash
omp plugin upgrade ompconfig@chacelow-ompconfig
# 或者一键升级所有 marketplace plugin
omp plugin upgrade
```

拉最新版本、自动 symlink 到 `~/.omp/plugins/`，无需重复 clone。

## 装好后

- Skills 自动在 `~/.agents/skills/` 里被 discovered
- Extension 自动通过 `~/.omp/plugins/node_modules/chacelow-ompconfig` symlink 挂到 OMP
- 主 agent `/om` 命令立即可用
- Slash `/reload-plugins` 刷新会话内 skills / 命令

## 可选：只装 Skills，不要 Extension

Plugin 装完后：

```bash
omp plugin disable ompconfig@chacelow-ompconfig   # 关掉 extension
# skills 仍生效（skills 是文件层，不受 plugin enable 状态影响）
```

或者反过来。

## 结构

```
.omp-plugin/marketplace.json    marketplace 声明
package.json                    omp.extensions 声明（让 extension 自动挂）
skills/                          plugin 结构约定：自动 discovered
extensions/observation-memory/   本 repo 的 extension 源码
claude/CLAUDE.md                 我个人的 agent 指令（不打进 plugin）
scripts/                         legacy install / sync（在没装 OMP 前手动 bootstrap 用）
references/                      本地只读源码参考（gitignore）
```

## 不打进 plugin 的

- `claude/CLAUDE.md`：太个人化，靠 `scripts/install.sh` 手工 install，plugin 不管
- `references/`：只是本地 debug 参考

## Legacy 安装（不用 plugin marketplace）

如果不想用 plugin 系统：

```bash
git clone git@github.com:chacelow/ompconfig.git ~/code/ompconfig
cd ~/code/ompconfig
./scripts/install.sh
```

不覆盖你 config.yml / settings.json / models.yml。

## Publish 到 CI

Repo 是 public。任何人 `omp plugin marketplace add chacelow/ompconfig` 就能装。GitHub Actions 后续加，做 marketplace.json / package.json / SKILL.md 的 lint。

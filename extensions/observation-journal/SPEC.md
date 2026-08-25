# Observation Journal — 契约（v0.1，草案）

本文件是 Observation Journal 扩展的**合约**。任何改动必须先修 SPEC，再改代码。
偏离本合约任一条不变量都算未完成，不允许"完成了 20% 就宣布完工"。

---

## 1. 目标

在不接管 OMP 现有 Memory、Compaction 或长期存储的前提下，为长会话补一层：

- **原子 Observation**：把当前会话内发生的决策、事实、失败、偏离、约束、未决问题固化。
- **Branch-aware Ledger**：Observation 存进 OMP 原生 Session 分支，`/tree` 时正确回滚。
- **JOURNEY.md**：一份短、有界、纯描述的当前任务演进史。
- **Compaction Orientation**：压缩前把 Journey 和最近 Observation 作为**追加**上下文注入，不替换 OMP 自身的压缩输出。
- **Bounded Consolidation**：旧 Observation 折叠成 Journey 段落；原始 Session Transcript 永远保留。
- **可控 Promotion**：当且仅当用户明确确认，把候选偏好写入 Mnemopi；默认关闭。

---

## 2. 非目标（明确列出不做）

- **不建立第二个长期 Memory Backend**：不写 `.memory/<sessionId>/<topic>.md`；长期记忆全部落回 Mnemopi。
- **不接管 OMP Compaction 输出**：不返回 `session_before_compact` 的 `compaction` 覆盖，只用 `session.compacting` 的 `context` 追加。
- **不启动 `pi` 子进程**：不调用外部 CLI；LLM 观察器（如需）走 OMP 内部 `task` 子代理，共享进程。
- **不默认写入项目 Git 工作区**：`JOURNEY.md` 只写到 Session artifacts 目录；用户显式选择才落到项目文档。
- **不修改 OMP 核心**：仅通过公开 Extension API。
- **不成为系统指令**：Journey 只描述"发生了什么"，不出现"你必须 X"这种指令句式。

---

## 3. 数据模型

### 3.1 Custom Entry 类型（namespace `com.omp.observation-journal`）

| customType | 用途 | data schema |
|---|---|---|
| `com.omp.observation-journal.enabled` | 会话 On/Off 门 | `{ enabled: boolean }` |
| `com.omp.observation-journal.observation` | 一条原子观察 | `Observation`（见 3.2） |
| `com.omp.observation-journal.cursor` | 观察器已消费到的 entry id | `{ coversUpToEntryId: string, tokensSince: number }` |
| `com.omp.observation-journal.journey-segment` | 已固化的 Journey 段落 | `{ id, timestamp, title, body, sourceObservationIds: string[] }` |
| `com.omp.observation-journal.promotion` | Mnemopi promotion 记录 | `{ observationId, memoryId?, status: "pending"｜"promoted"｜"skipped"｜"failed", note?, reviewedAt }` |

命名空间理由：所有 customType 都以 `com.omp.observation-journal.` 开头，避免和 OMP 核心保留值或其他扩展冲突（见 OMP `custom` 条目引用）。

### 3.2 Observation

```ts
type ObservationCategory =
  | "fact"            // 环境或代码里被确认的事实
  | "decision"        // 用户或 Agent 做出的决定
  | "preference"      // 用户长期偏好候选
  | "failed-attempt"  // 尝试了但不 work
  | "deviation"       // 偏离原计划
  | "constraint"      // 项目或外部约束
  | "open-question";  // 未解决的问题

interface Observation {
  id: string;                     // 8 字节十六进制随机 id
  timestamp: string;              // ISO8601
  sessionId: string;              // ctx.sessionManager.getSessionId()
  category: ObservationCategory;
  content: string;                // 一句话描述；≤ 400 字符
  evidenceEntryIds: string[];     // 至少一个原始 session entry id
  durable: boolean;               // 是否候选 Mnemopi promotion；默认 false
  source: "manual" | "subagent";  // 阶段 1 只允许 "manual"
}
```

**不变量：**

- `content` 必须描述已发生的事实、决定或偏好，**不得**是命令式或规则式（"你要 X"、"以后必须 Y"）。
- `evidenceEntryIds` 非空。没有证据的 Observation 直接拒收（读时忽略、写时 throw）。
- `content` 写入前必须先过 `redactSecrets()`（见 6.2）。

### 3.3 Journey 渲染格式

`JOURNEY.md` 由 Observation + Journey Segment 合并渲染，写到 Session artifact 路径：

```
<session artifacts>/observation-journal/JOURNEY.md
```

结构：

```markdown
# Journey — <session title>

_Last updated: <ISO timestamp>_

## <YYYY-MM-DD> · <segment title>

<segment body，纯描述，≤ 800 字符>

## Recent observations

- [fact] <content>
- [decision] <content>
- [failed-attempt] <content>
- …

## Open questions

- <content>
- …
```

**边界：**

- Segment 数量 ≤ `journeyMaxSegments`（默认 20）。超出则合并最老两段。
- Recent observations 数量 ≤ `recentObservationsMax`（默认 30）。
- 总渲染字节数 ≤ `journeyTargetBytes`（默认 8 KiB）。超出截断，附 `_… truncated_` 标记。

---

## 4. 事件与生命周期

| 事件 | 行为 |
|---|---|
| `session_start` | 从 branch 重放所有 `com.omp.observation-journal.enabled` 条目，取最后一个决定 gate；重放 observation/journey-segment，重建内存视图。 |
| `session_before_branch` / `session_branch` / `session_before_tree` / `session_tree` | 只需要在 `session_start` 之外重新调用 rebuild；不写新 entry。 |
| `turn_end` | 增量扫描新增 entry，累计 token；到达 `observeEveryTokens` 触发一次 flush（阶段 1 只统计，不做自动 LLM 观察）。 |
| `session.compacting` | 若启用，返回 `{ context: [renderCompactionInjection()] }`；不返回 `prompt`，不设 `preserveData`。 |
| `session_compact` | 记录一条 `journey-segment`，标题为 `Post-compaction snapshot`，body 为压缩前 recent observations 摘要。 |
| `session_shutdown` | 最后一次 flush cursor；关闭定时器；不做同步网络请求。 |

不使用的事件（明确列出）：

- `before_provider_request`、`after_provider_response`、`context`、`tool_call`、`tool_result`：Observation Journal **不**拦截模型请求，也不修改工具输出。

---

## 5. Gate（On/Off）

- **默认关闭**。全新会话的第一次调用都是 no-op。
- 命令 `/journey on`、`/journey off`、`/journey`（toggle）改状态。
- Gate 状态持久化为 `com.omp.observation-journal.enabled` custom entry。resume 会话读到什么就是什么。
- 关闭时**所有**事件处理器都在第一行 return，命令入口保留（用于打开）。
- 敏感场景（如收到 `credential_disabled` 事件）自动切换到关闭状态并 notify。

---

## 6. 安全边界

### 6.1 项目 Git 工作区

- `JOURNEY.md` 默认位置：`<session artifacts>/observation-journal/JOURNEY.md`；由 OMP session 管理，不进项目工作区。
- 提供 `/journey export <path>` 命令把当前 Journey 复制到用户指定路径（用户显式选择，进不进 Git 由用户 own）。

### 6.2 Redaction

集中函数 `redactSecrets(raw: string): string`，规则：

- 匹配 `gho_`, `ghp_`, `github_pat_`, `sk-`, `AKIA`, `-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----`, `Bearer [A-Za-z0-9\-_.=]+`, `Authorization: [^\r\n]+`, `password\s*[=:]\s*\S+`, `api[_-]?key\s*[=:]\s*\S+`，替换为 `[REDACTED:<label>]`。
- 匹配 base64 长度 ≥ 40 且以典型 secret 前缀开头（如 `xox`, `ya29`）的字符串，替换为 `[REDACTED]`。
- **任何**写入 Observation.content 或 Journey Segment 的字符串**必须**先经过 `redactSecrets()`。这是不变量：新代码路径若绕过该函数，视为 bug。

### 6.3 Mnemopi 隔离

- Observation Journal 不直接写 Mnemopi。
- Promotion 只发生在 `/journey promote <observationId>` 命令中，并且：
  - 该 Observation 的 `durable === true`；
  - 用户在 promotion 命令中通过 confirm 对话框显式确认；
  - 通过 `ctx.memory.save()`（或等价 API）写入，metadata 中携带 `sourceObservationId`。
- **默认**不提供任何"自动 promote"路径。开启需要配置项 `promotion.autoRetainMatched: true` 且给出白名单模式；本 SPEC 不定义任何默认白名单。

---

## 7. 命令表

| 命令 | 行为 | 阶段 |
|---|---|---|
| `/journey` | 显示 status | 1 |
| `/journey on` \| `/journey off` | 切换 gate | 1 |
| `/journey status` | 显示 `{ enabled, observations, segments, cursor, journeyBytes }` | 1 |
| `/journey show` | 打印当前 Journey 渲染文本 | 1 |
| `/journey add <category> <content>` | 手动新增 Observation（source="manual"） | 1 |
| `/journey mark-durable <observationId>` | 标记候选 promotion | 1 |
| `/journey flush` | 手动触发一次 segment 合并 + 落盘 | 1 |
| `/journey export <path>` | 把 Journey 复制到用户指定路径 | 1 |
| `/journey observe` | 派发一个受限 `task` 子代理生成 Observation 候选（阶段 2） | 2 |
| `/journey candidates` | 列出待 promotion 的 durable Observation | 3 |
| `/journey promote <observationId>` | 交互式确认后写入 Mnemopi | 3 |
| `/journey forget <observationId>` | 标记 Observation 失效（写一条 `invalidated` 状态的 promotion 记录，或从 Journey 隐藏） | 3 |

---

## 8. 分阶段验收

每阶段一次交付；验收清单**全部**满足才算完成。任何一条不满足 → 阶段未完成，不合并。

### Stage 1 · 只读 Observation Journal（无 LLM）

**范围：**

- 扩展目录 `~/.omp/agent/extensions/observation-journal/` 就位。
- `index.ts` 只用公开 Extension API；不访问 OMP 内部路径、不修补原型。
- 事件：`session_start`, `turn_end`, `session_before_branch`, `session_branch`, `session_before_tree`, `session_tree`, `session_shutdown`。
- 命令：`/journey`, `/journey on/off/status/show`, `/journey add`, `/journey mark-durable`, `/journey flush`, `/journey export`。
- 写入路径：Session custom entries + Session artifact `JOURNEY.md`。
- Redaction 集中在 `redaction.ts::redactSecrets`；所有写入路径必须经过它（unit test 强制）。
- 完整 `bun test`：redaction 覆盖 SPEC §6.2 所列每一类模式；rebuild-from-branch 覆盖插入 / 分支跳转 / 关闭再打开。

**验收证据（缺一不可）：**

1. `omp --no-session --no-title -p --tools read` 中读取 `/skill:` 或直接触发命令，能看到 `/journey` 命令注册。
2. 一次真实交互式会话，产生 ≥ 3 条 Observation 和 ≥ 1 段 Journey Segment；`/journey show` 输出可读、包含时间戳、经过 redaction。
3. Session 层测试：`bun test` 全绿；测试覆盖：
   - `Observation.content` 经过 redactSecrets 后不含任何 6.2 所列模式。
   - `rebuildFromBranch` 输入分支跳变后正确回滚（分支 A 上写的 observation 在切换到分支 B 后不出现）。
   - Gate 关闭时 `turn_end` 处理器立即 return（用 spy 验证 append 未被调用）。
4. 未调用 Mnemopi API：test 用 mock 断言 `ctx.memory.save` 从未被触发。
5. 未写项目工作区：test 用 mock 断言 `Bun.write` 到非白名单路径抛出。

### Stage 2 · Compaction Orientation + 可选 Subagent Observer

**范围：**

- 实现 `session.compacting` 追加注入（不返回 `prompt`）。
- 新增命令 `/journey observe`：派发一个 `task` 子代理，返回结构化 Observation 候选列表；用户在同一命令流里 confirm 后追加为 Observation。
- 追加内容严格 ≤ `compactInjectionBytes`（默认 3 KiB）。超出直接截断。
- 关闭 gate 时 `session.compacting` 不注入。

**验收证据：**

1. 手动触发 `/compact` 或自动 compaction 场景下，压缩后 context 中确实出现 Journey 段落；测量注入字节数 ≤ 上限。
2. `session_before_branch` + Compaction + `/tree` 组合场景下，注入内容随分支切换正确。
3. `/journey observe` 触发 `task` 子代理；Agent Hub 中可见该子代理；返回结果被结构化解析成 Observation 候选并等待用户确认。
4. Advisor / Todo / Plan / provider prompt cache 行为不受影响（回归测试）。
5. Test 覆盖：注入超限截断、gate 关闭时不注入、observation cursor 在 branch 切换后正确回滚。

### Stage 3 · Mnemopi Promotion

**范围：**

- 命令 `/journey candidates`、`/journey promote`、`/journey forget`。
- Promotion 走 `ctx.memory.save`（若可用）；不可用则报错并保留候选。
- Promotion 记录以 `com.omp.observation-journal.promotion` custom entry 存证。
- Redaction 再次应用到实际写入 Mnemopi 的字符串（双保险）。

**验收证据：**

1. 一次会话：`/journey candidates` 列出 ≥ 1 条 durable observation；`/journey promote` 后 `recall` 能命中该内容。
2. `memory_edit invalidate` 该记忆后，`/journey candidates` 不再把它当候选。
3. 默认关闭自动 promotion：test 用 spy 断言在没有显式命令的情况下 `ctx.memory.save` 从未被调用。
4. Secret pattern 命中样本（redaction test fixture）在 `promote` 命令流里被 100% 屏蔽（在 save 前抛错或跳过）。

### Delivery · 同步到 ompconfig 私有仓库

- 扩展源码进入 `extensions/observation-journal/`。
- 更新 `scripts/sync-from-home.sh` 和 `scripts/install.sh`，把扩展作为 tracked artifact 恢复到 `~/.omp/agent/extensions/observation-journal/`。
- `plugins/manifest.yml` 记录扩展身份与来源。
- `README.md` 新增章节说明用途、命令、gate、Redaction 边界。
- 一次 `bun test` + `./scripts/verify.sh` 全绿后 commit + push。

---

## 9. 反稀释护栏（技术措施，非承诺）

1. **契约与代码同修**：任何对 §3~§7 的改动 PR 必须同时改 SPEC；否则拒绝合并。
2. **Observer 纯函数**：观察器输入是新增 session entry 快照 + 上一 cursor；输出是 `Observation[]`。不读取 Mnemopi、项目文件、历史 observations 之外的任何状态。用 unit test 固化。
3. **Redaction 集中**：所有向 Observation.content、Journey Segment、Compaction 注入字符串的写入路径必须调用 `redactSecrets`；违反视为 bug，测试对新增写入路径要求经过。
4. **Journey 描述句式**：新增 lint（简单正则）拒绝 Journey 内容中出现 `你必须|你需要|以后要|from now on|must|shall`；不通过则拒收该 Observation。
5. **Compaction 只追加**：`session.compacting` 处理器不使用 `prompt`、`preserveData`；返回值形状被单元测试固化。
6. **Off 分支路径覆盖**：每个事件处理器第一行都是 `if (!gate.enabled) return;`；测试断言在 gate 关闭时所有副作用为零。
7. **Extension 默认关闭**：安装到 `~/.omp/agent/extensions/` 后仍需 `/journey on` 才生效；配置文件不添加"启动即开启"选项。

---

## 10. 配置

放在 `~/.omp/agent/config.yml`（用户级）或项目 `.omp/config.yml`：

```yaml
observationJournal:
  observeEveryTokens: 6000        # 阶段 2 才生效
  journeyMaxSegments: 20
  recentObservationsMax: 30
  journeyTargetBytes: 8192
  compactInjectionBytes: 3072
  promotion:
    autoRetainMatched: false      # 强制 false 是不变量；阶段 3 提供关闭开关但没有默认白名单
    autoWhitelistPatterns: []
```

**不变量：**`promotion.autoRetainMatched` 默认 `false`；SPEC 不定义任何默认 whitelist；启用需用户在 config 中显式列出模式。

---

## 11. 版本与签字

- 版本：v0.1（草案，待用户签字）。
- 签字前**不**开始 Stage 1 代码。
- 签字后任何偏离需要经过：改 SPEC → 用户确认 → 改代码，三步全走。

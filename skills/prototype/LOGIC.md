# Logic and Contract Prototype

用可操作界面验证 state transitions、数据结构和前后端契约。优先把它放进项目实际前端；只有项目没有前端且用户未指定框架时，才退回单一 HTML 文件。

## 运行形态

- **已有或指定前端框架：** 在最终业务路由中实现，用项目现有组件、状态和路由约定。
- **无前端 fallback：** 创建语义命名的单文件 HTML，可使用 Tailwind CSS CDN 和完成状态交互所需的轻量 CDN 脚本。文件应双击可运行，不引入构建系统。

## 先定义候选契约

写 UI 前明确：

- domain types 与 identifiers；
- query/input；
- result shape；
- commands/mutations；
- loading、empty、error、permission 和 stale states；
- state transitions 与非法操作。

这些 type、interface、hook、service 和 method 使用最终业务语义。Mock 只是 provider 当前的内部实现。

```ts
export interface ProjectSessionSource {
  list(input: ListProjectSessionsInput): Promise<ListProjectSessionsResult>;
  archive(id: string): Promise<void>;
}
```

Prototype 阶段可以给这个 interface 绑定内存实现，但不要把公开 interface 命名为 `MockProjectSessionSource`，也不要让调用方知道数据是否来自 Mock。

## 构建可操作场景

界面使用领域语言展示完整相关 state，并提供：

1. 自由操作区，让用户按任意顺序触发 actions。
2. Guided scenarios，覆盖 happy path、关键 edge case 和非法操作。
3. 可切换的数据状态：populated、empty、loading、error、权限不足。
4. 每次 action 后可见的 state/result 变化。

如果同时需要比较界面设计，按 [UI.md](UI.md) 使用语义 variants；所有 variants 共享同一候选契约和 provider。

## Mock Provider 规则

- 数据集中在一个业务语义文件或 provider 内，不散落在页面和组件中。
- 实现内部可使用 `mock*` fixture 名称，明确当前来源。
- 返回值严格符合候选 interface，避免 UI 依赖后端尚未决定的偶然细节。
- Mutation 使用确定性的内存状态或 stub，不触碰真实生产数据。
- 如需模拟延迟和失败，在 provider 内完成。

## 从原型到后端

用户确认交互和数据 shape 后：

1. 文档化用户流程、状态机、types、queries、mutations、错误语义和关键决策。
2. 用确认后的 interface 设计后端 endpoint、procedure 或 repository adapter。
3. 在原 provider 文件内部，把静态返回替换为 REST、GraphQL、tRPC、RPC client 或项目已有数据层调用。
4. 不改正式路由、组件、业务 hook、公开方法和类型名称。
5. 使用原先的 guided scenarios 验证真实后端行为。

若后端无法满足已确认契约，先把冲突作为架构决策显式讨论，不能默默让前端退化为后端偶然结构。

## 禁止事项

- 不默认生成脱离项目的纯 HTML；它只是无前端时的 fallback。
- 不使用 `prototype`、`temp` 或 `mock` 作为业务文件、路由、class、hook 或公开方法的语义。
- 不把 DOM 和业务状态逻辑揉在一起；保持 provider 与 UI 边界。
- 不接真实数据库或不可逆 mutation。
- 不提前泛化未来需求。
- 不把用户已经验证的契约当作一次性代码丢弃。
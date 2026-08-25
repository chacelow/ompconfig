# UI Prototype

在用户最终会使用的**真实业务路由**上生成多个明显不同的 UI variants，通过 URL search parameter 或开发态 filter 切换。目标不是做一套稍后推翻的假页面，而是在真实应用外壳、真实交互约束和候选数据契约中选择设计。

## 选择承载位置

1. 项目已有前端和路由时，使用功能最终所属的语义路由。已有页面就嵌入该页面；新功能需要新页面时，直接创建最终业务路由。
2. 不创建 `/prototype/*`、`/sandbox/*` 或之后必须改名的临时路由。
3. 用户明确指定前端框架时使用该框架。
4. 项目没有前端、用户也未指定框架时，fallback 为单一 HTML 文件。使用语义文件名，例如 `project-sessions.html`；可引入 Tailwind CSS CDN 和必要的轻量 CDN 脚本来完成布局与交互。

## 生成 Variants

默认生成 3 个、最多 5 个结构明显不同的 variants。差异应在 layout、information hierarchy、navigation 或 primary affordance，不只是颜色。

Variant 使用语义 key 和组件名：

- `?variant=table` → `ProjectSessionsTable`
- `?variant=timeline` → `ProjectSessionsTimeline`
- `?variant=split-pane` → `ProjectSessionsSplitPane`

不要使用 `VariantA`、`PrototypePage`、`MockDashboard` 等名称。Variant component 可以在收敛时删除，但其中稳定的业务组件应从一开始就使用最终语义。

## 数据边界

页面依赖稳定的业务数据 API，例如：

```ts
type ProjectSession = {
  id: string;
  projectId: string;
  title: string;
  status: "active" | "archived";
};

export function useProjectSessions(): ProjectSessionsResult {
  // Prototype stage: return deterministic in-memory data here.
}
```

- 文件、hook、service、interface 和 method 按业务职责命名，不以 `mock` 或 `prototype` 命名。
- 可以在实现内部把静态数据命名为 `mockProjectSessions`，明确它是当前数据来源。
- UI 不直接 import fixture，不在 component 内散落假数据。
- Provider 同时模拟 loading、empty、error 和 populated states，让用户评估完整交互。
- 后端接入时只改 provider 内部：改为调用项目已有的 REST、GraphQL、tRPC、RPC 或 repository 层；公开返回 shape 保持不变。

## Variant Filter

在开发环境提供一个共享切换器：

- URL parameter 保持可分享、刷新稳定，例如 `?variant=timeline`。
- 控件显示语义名称，不显示 A/B/C。
- 左右键可循环切换；输入框和可编辑元素聚焦时不拦截按键。
- 切换器不参与被评估设计，并在 production build 中隐藏。
- fallback HTML 直接读取 `URLSearchParams` 并更新 URL；框架项目使用现有 router API。

## 评审与收敛

让用户在实际路由上完成真实任务，而不只看静态截图。记录：

- 哪个 variant 的哪些部分被接受；
- 用户流程和交互状态；
- UI 需要的数据字段与 mutation；
- loading、empty、error 和权限行为；
- 被否决方案及原因。

用户可以组合 variants，例如采用 `timeline` 的信息层级和 `split-pane` 的详情交互。收敛后：

1. 把组合结果整理成唯一正式 UI。
2. 删除 losing variant components、variant filter 和 query parameter 分支。
3. 保留正式路由、业务组件、types、interfaces 和 provider API。
4. 把确认结果写入项目文档或 ADR。
5. 实现后端，只替换 provider 的数据来源，然后重跑相同交互路径。

## 禁止事项

- 不创建之后再改名的 prototype 路由或文件。
- 不让 Mock 语义泄漏进公开 API、组件名、class 名或业务方法名。
- 不把 variants 连接到不可逆的真实 mutation；原型阶段使用 provider 内的确定性 stub。
- 不只做颜色差异。
- 不因为数据是 Mock 就省略可访问性和主要交互状态。
- 不在接入后端时重写已经由用户验证的前端契约。

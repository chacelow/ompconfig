---
name: prototype
description: 构建一次性原型来回答一个设计问题。适用于用户想验证某个 state model 或 logic 是否感觉对，或探索 UI 应该长什么样时。
---

# Prototype

Prototype 用于在实现后端前，把用户体验、交互、数据结构和前端契约变成可以真实操作的东西。它不是命名混乱的临时代码；它是**前端先行、数据暂时由 Mock provider 提供的可演进实现**。

## 选择运行形态

按以下优先级选择，不另起一套技术栈：

1. 当前项目已有前端框架和路由：使用现有框架、真实路由、组件库、样式系统和目录约定。
2. 用户明确指定 React、Vue、Svelte、Next.js 或其他前端：使用指定技术栈。
3. 没有现成前端且用户未指定框架：最后才退回一个可直接打开的 HTML 文件。可以用 Tailwind CSS CDN 和完成交互所需的少量 CDN 脚本；不要为 fallback 引入构建系统。

## 两种问题

- **界面或交互应该是什么样？** 读取 [UI.md](UI.md)。在真实语义路由上提供多个可切换 variants。
- **状态、数据结构或接口契约是否合理？** 读取 [LOGIC.md](LOGIC.md)。优先在实际前端中实现可操作场景；只有没有前端时才生成单文件 HTML。

两者可以组合：UI variants 共享一套候选数据契约，并通过 Mock provider 驱动。

## 稳定语义规则

1. **从第一天使用最终业务语义。** 路由、文件、组件、hook、type、interface、class 和 function 都按业务职责命名。不要使用 `prototype-*`、`mock-page`、`TempComponent`、`VariantA` 之类会在确认后改名的占位语义。
2. **Variant 只表示设计选择。** 使用 `?variant=<semantic-key>`、开发工具栏或等价 filter 切换多个方案。Variant key 使用布局或交互语义，例如 `table`、`timeline`、`split-pane`，不用 `A/B/C`。
3. **Mock 只停留在数据提供边界。** 页面和组件依赖稳定的业务 hook/service/interface，例如 `useProjectSessions()` 或 `ProjectSessionRepository`。该 provider 当前返回内存中的 Mock 数据；文件名和公开 API 不因 Mock 而带临时语义。
4. **数据契约是原型产物。** Types、interfaces、query input、result shape、loading/empty/error states 随交互一起验证。后端实现必须适配这份已确认契约，而不是迫使前端围绕后端重命名或重写。
5. **保持替换点单一。** 接入 REST、GraphQL、tRPC、RPC client 或项目已有中间层时，只替换 provider 内部实现或依赖注入绑定。路由、组件、业务 hook 名称、类型和调用方保持不变。
6. **原型阶段也使用正经设计。** 可访问性、真实布局、真实交互和合理组件边界不能因为数据是 Mock 就省略。可以暂缓持久化、完整错误恢复和后端实现，但不能用假命名掩盖设计债。

## 收敛与文档化

用户通过实际交互选择或组合 variants 后：

1. 把胜出的设计收敛到真实路由，删除其余 variants 和切换器。
2. 保留已确认的业务命名、数据类型、interface 与 provider 边界。
3. 把关键用户流程、状态、数据契约、接口约束和被否决方案写入项目现有文档体系；有 `CONTEXT.md` 或 ADR 约定时遵循它，没有时生成一份紧邻功能的设计说明。
4. 实现后端并替换 Mock provider 的返回来源。
5. 用同一用户路径验证真实数据接入没有改变已确认行为。

不要为了“清理原型”删除已经成为产品契约的前端结构。应删除的是 variants、开发切换器和静态 Mock 数据，不是稳定语义。

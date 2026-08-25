// Observer subagent 单元 + wire 测试。
// 目标：
//  1. resolveObserverModel 三条 fallback 路径都覆盖。
//  2. extractObservations 能吃 SingleResult 常见形状。
//  3. dispatchObserverWithOverride 传对了 modelRole / modelOverride 到伪 runSubprocess。
//  4. handleObserveNow 命令在 SDK 无 runSubprocess 时优雅降级。
//  5. turn_end 累加超阈值不会重复 spawn（in-flight guard）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import observationJournalFactory, {
  _resetStoresForTesting,
  _awaitPendingObserverForTesting,
} from "../index.ts";
import {
  buildObserverTask,
  dispatchObserverWithOverride,
  extractObservations,
  resolveObserverModel,
} from "../observer.ts";
import {
  ENABLED_TYPE,
  OBSERVATION_TYPE,
  type CommandDefinition,
  type EventHandler,
  type ExtensionAPILike,
  type ExtensionContextLike,
  type SessionEntryLike,
} from "../types.ts";

// ---------- Fake host（借用 extension.test 的模式，重写以便 observer 特化 spy） ----------

interface FakeHost {
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, CommandDefinition>;
  api: ExtensionAPILike;
  appended: Array<{ customType: string; data: unknown }>;
  runSubprocessCalls: unknown[];
  runSubprocessResult: unknown;
  runSubprocessThrows?: Error;
}

function makeHost(): FakeHost {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, CommandDefinition>();
  const appended: FakeHost["appended"] = [];
  const runSubprocessCalls: unknown[] = [];
  const api: ExtensionAPILike & { pi?: Record<string, unknown> } = {
    on: (event, handler) => {
      const list = handlers.get(event);
      if (list) list.push(handler);
      else handlers.set(event, [handler]);
    },
    registerCommand: (name, def) => {
      commands.set(name, def);
    },
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
    },
    setLabel: () => {},
    sendUserMessage: async () => {},
  };
  const host: FakeHost = {
    handlers,
    commands,
    api,
    appended,
    runSubprocessCalls,
    runSubprocessResult: {
      structuredOutput: {
        observations: [
          { text: "用户偏好静默 observer。", category: "preference", confidence: "high" },
          { text: "决定 fallback 到当前会话模型。", category: "decision" },
        ],
      },
    },
  };
  // 把伪 runSubprocess 挂在 pi.pi 上。
  api.pi = {
    runSubprocess: async (opts: unknown) => {
      runSubprocessCalls.push(opts);
      if (host.runSubprocessThrows) throw host.runSubprocessThrows;
      return host.runSubprocessResult;
    },
  };
  return host;
}

function makeCtx(
  host: FakeHost,
  options: {
    branch?: SessionEntryLike[];
    activeModel?: { provider: string; id: string };
    contextUsage?: { tokens?: number; contextWindow?: number };
    settings?: Record<string, unknown>;
  } = {},
): {
  ctx: ExtensionContextLike;
  branch: SessionEntryLike[];
  notifications: Array<{ message: string; level: string }>;
} {
  const branch = options.branch ?? [];
  const notifications: Array<{ message: string; level: string }> = [];

  // Mirror appended entries into branch so rebuildFromBranch picks them up.
  const originalAppend = host.api.appendEntry;
  host.api.appendEntry = (customType, data) => {
    originalAppend(customType, data);
    branch.push({
      type: "custom",
      id: `e${branch.length + 1}`,
      customType,
      data,
    });
  };

  const ctx: ExtensionContextLike = {
    hasUI: true,
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level: level ?? "info" });
      },
    },
    sessionManager: {
      getSessionId: () => "session-observer",
      getBranch: () => branch,
      getSessionTitle: () => "observer test",
      getLeafEntryId: () => branch.at(-1)?.id,
    },
    settings: {
      get: (name: string) => (options.settings ?? {})[name],
    },
    getContextUsage: () => options.contextUsage,
  };
  // 把当前主会话模型挂到 ctx 上（observer.ts 通过 ctx.getModel 读取）。
  Object.defineProperty(ctx, "getModel", {
    value: () => options.activeModel,
    enumerable: false,
  });
  return { ctx, branch, notifications };
}

async function fire(
  host: FakeHost,
  name: string,
  ctx: ExtensionContextLike,
): Promise<void> {
  for (const h of host.handlers.get(name) ?? []) await h(undefined, ctx);
}

async function runCmd(
  host: FakeHost,
  name: string,
  args: string,
  ctx: ExtensionContextLike,
): Promise<void> {
  const def = host.commands.get(name);
  if (!def) throw new Error(`command ${name} not registered`);
  await def.handler(args, ctx);
}

// ---------- 纯函数单元 ----------

describe("resolveObserverModel", () => {
  test("显式 @role → modelRole", () => {
    expect(resolveObserverModel("@smol", undefined)).toEqual({ modelRole: "@smol" });
    expect(resolveObserverModel("@advisor", { provider: "x", id: "y" })).toEqual({
      modelRole: "@advisor",
    });
  });

  test("显式 provider/id → modelOverride", () => {
    expect(resolveObserverModel("openrouter/z-ai/glm-5.3", undefined)).toEqual({
      modelOverride: "openrouter/z-ai/glm-5.3",
    });
  });

  test("未设 + 主会话有活动模型 → fallback modelOverride", () => {
    expect(
      resolveObserverModel(undefined, { provider: "anthropic", id: "claude-opus-4-7" }),
    ).toEqual({ modelOverride: "anthropic/claude-opus-4-7" });
  });

  test("未设 + 无活动模型 → 兜底 @smol", () => {
    expect(resolveObserverModel(undefined, undefined)).toEqual({ modelRole: "@smol" });
    expect(resolveObserverModel("   ", { provider: "", id: "" })).toEqual({
      modelRole: "@smol",
    });
  });
});

describe("extractObservations", () => {
  test("从 structuredOutput 取", () => {
    const r = extractObservations({
      structuredOutput: {
        observations: [
          { text: "hello", category: "fact" },
          { text: "world", category: "decision", confidence: "medium" },
        ],
      },
    });
    expect(r).toHaveLength(2);
    expect(r[0].category).toBe("fact");
    expect(r[1].confidence).toBe("medium");
  });

  test("从 structuredOutput.data 取（OMP SingleResult 官方形状）", () => {
    const r = extractObservations({
      structuredOutput: {
        source: "agent",
        mode: "permissive",
        status: "valid",
        data: {
          observations: [
            { text: "官方 SingleResult 形状", category: "fact", confidence: "high" },
          ],
        },
      },
    });
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe("官方 SingleResult 形状");
    expect(r[0].category).toBe("fact");
  });

  test("空/坏 payload → 空数组", () => {
    expect(extractObservations(null)).toEqual([]);
    expect(extractObservations({})).toEqual([]);
    expect(extractObservations({ structuredOutput: { observations: "nope" } })).toEqual([]);
  });

  test("过滤掉空 text / 空 category", () => {
    const r = extractObservations({
      structuredOutput: {
        observations: [
          { text: "", category: "fact" },
          { text: "ok", category: "" },
          { text: "keep", category: "preference" },
        ],
      },
    });
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe("keep");
  });

  test("兼容 categories 数组（复数）", () => {
    const r = extractObservations({
      structuredOutput: {
        observations: [{ text: "ok", categories: ["fact", "extra"] }],
      },
    });
    expect(r).toHaveLength(1);
    expect(r[0].category).toBe("fact");
  });
});

describe("buildObserverTask", () => {
  test("包含 BEGIN/END fence 与显式反捕获指令", () => {
    const task = buildObserverTask("对话片段…");
    expect(task).toContain("===== BEGIN CONVERSATION CHUNK");
    expect(task).toContain("===== END CONVERSATION CHUNK");
    expect(task).toContain("inert data");
    expect(task).toContain("对话片段…");
  });
});

describe("dispatchObserverWithOverride", () => {
  test("传对了 modelOverride（config 空 + 主会话有模型）", async () => {
    const host = makeHost();
    const { ctx } = makeCtx(host, {
      activeModel: { provider: "anthropic", id: "claude-opus-4-7" },
    });
    const calls: unknown[] = [];
    const result = await dispatchObserverWithOverride(
      { pi: host.api, ctx, chunkText: "hi" },
      {
        runSubprocess: async (opts) => {
          calls.push(opts);
          return { structuredOutput: { observations: [] } };
        },
      },
    );
    expect(result.ranSubprocess).toBe(true);
    const call = calls[0] as Record<string, unknown>;
    expect(call.modelOverride).toBe("anthropic/claude-opus-4-7");
    expect(call.modelRole).toBeUndefined();
    expect(call.detached).toBe(true);
    expect(call.enableIrc).toBe(false);
    expect(call.enableLsp).toBe(false);
    expect(call.enableMCP).toBe(false);
    expect(call.restrictToolNames).toBe(true);
  });

  test("传对了 modelRole（config @smol）", async () => {
    const host = makeHost();
    const { ctx } = makeCtx(host);
    const calls: unknown[] = [];
    await dispatchObserverWithOverride(
      { pi: host.api, ctx, chunkText: "hi", observerModel: "@smol" },
      {
        runSubprocess: async (opts) => {
          calls.push(opts);
          return {};
        },
      },
    );
    const call = calls[0] as Record<string, unknown>;
    expect(call.modelRole).toBe("@smol");
    expect(call.modelOverride).toBeUndefined();
  });

  test("SDK 无 runSubprocess + 无 override → ranSubprocess=false 且 error 明确", async () => {
    const api: ExtensionAPILike = {
      on: () => {},
      registerCommand: () => {},
      appendEntry: () => {},
    };
    const ctx = { hasUI: false } as unknown as ExtensionContextLike;
    const result = await dispatchObserverWithOverride(
      { pi: api, ctx, chunkText: "x" },
      {},
    );
    expect(result.ranSubprocess).toBe(false);
    expect(result.error).toContain("SDK");
  });

  test("runSubprocess 抛错 → ranSubprocess=true + error", async () => {
    const host = makeHost();
    const { ctx } = makeCtx(host);
    const result = await dispatchObserverWithOverride(
      { pi: host.api, ctx, chunkText: "x" },
      {
        runSubprocess: async () => {
          throw new Error("provider down");
        },
      },
    );
    expect(result.ranSubprocess).toBe(true);
    expect(result.error).toBe("provider down");
    expect(result.observations).toEqual([]);
  });
});

// ---------- Extension-level wire tests ----------

describe("observe-now 命令", () => {
  beforeEach(() => _resetStoresForTesting());
  afterEach(() => _resetStoresForTesting());

  test("SDK 有 runSubprocess → 抽取观察并 appendEntry", async () => {
    const host = makeHost();
    observationJournalFactory(host.api);
    const { ctx, branch, notifications } = makeCtx(host, {
      branch: [
        { type: "user", id: "e1", data: { text: "决定 fallback 用 session model" } },
        { type: "assistant", id: "e2", data: { text: "OK" } },
      ],
      activeModel: { provider: "anthropic", id: "claude-opus-4-7" },
    });
    await fire(host, "session_start", ctx);
    // 打开 gate
    await runCmd(host, "journey", "on", ctx);
    await runCmd(host, "journey", "observe-now", ctx);

    expect(host.runSubprocessCalls.length).toBe(1);
    const call = host.runSubprocessCalls[0] as Record<string, unknown>;
    expect(call.modelOverride).toBe("anthropic/claude-opus-4-7");

    // 落地了 2 条观察（source: subagent）
    const obsAppends = host.appended.filter((e) => e.customType === OBSERVATION_TYPE);
    expect(obsAppends).toHaveLength(2);
    for (const entry of obsAppends) {
      expect((entry.data as { source: string }).source).toBe("subagent");
    }

    // notify 里含 "新增 2 条"
    expect(notifications.some((n) => n.message.includes("新增 2 条"))).toBe(true);
    // branch 上真的多了 gate + 2 observation entries
    expect(branch.some((e) => e.customType === ENABLED_TYPE)).toBe(true);
    expect(branch.filter((e) => e.customType === OBSERVATION_TYPE)).toHaveLength(2);
  });

  test("SDK 无 runSubprocess → 优雅降级 notify warn", async () => {
    const host = makeHost();
    // 拿掉 pi.pi.runSubprocess
    delete (host.api as unknown as { pi?: Record<string, unknown> }).pi;
    observationJournalFactory(host.api);
    const { ctx, notifications } = makeCtx(host, {
      branch: [{ type: "user", id: "e1", data: { text: "hi" } }],
    });
    await fire(host, "session_start", ctx);
    await runCmd(host, "journey", "on", ctx);
    await runCmd(host, "journey", "observe-now", ctx);

    expect(host.runSubprocessCalls).toHaveLength(0);
    expect(
      notifications.some(
        (n) => n.message.includes("Observer 未运行") || n.message.includes("Observer 出错"),
      ),
    ).toBe(true);
  });

  test("已有 observer 在跑 → 拒绝重复派发", async () => {
    const host = makeHost();
    const { promise: gate, resolve: releaseGate } =
      Promise.withResolvers<{ structuredOutput: { observations: never[] } }>();
    (host.api as unknown as { pi: Record<string, unknown> }).pi.runSubprocess =
      async (opts: unknown) => {
        host.runSubprocessCalls.push(opts);
        return gate;
      };
    observationJournalFactory(host.api);
    const { ctx, notifications } = makeCtx(host, {
      branch: [{ type: "user", id: "e1", data: { text: "hi" } }],
    });
    await fire(host, "session_start", ctx);
    await runCmd(host, "journey", "on", ctx);

    // 第一次派发挂起（await gate）；第二次被 in-flight guard 拦下。
    const first = runCmd(host, "journey", "observe-now", ctx);
    await runCmd(host, "journey", "observe-now", ctx);

    expect(host.runSubprocessCalls).toHaveLength(1);
    expect(notifications.some((n) => n.message.includes("已有 observer"))).toBe(true);

    // 释放 gate，让第一次派发结束、避免测试 leak。
    releaseGate({ structuredOutput: { observations: [] } });
    await first;
  });
});

describe("turn_end 触发", () => {
  beforeEach(() => _resetStoresForTesting());
  afterEach(() => _resetStoresForTesting());

  test("autoObserveEnabled=false → turn_end 不派发", async () => {
    const host = makeHost();
    observationJournalFactory(host.api);
    const { ctx } = makeCtx(host, {
      branch: [{ type: "user", id: "e1", data: { text: "hi" } }],
      contextUsage: { tokens: 100_000, contextWindow: 200_000 },
      settings: {
        observationJournal: { defaultEnabled: false, autoObserveEnabled: false },
      },
    });
    await fire(host, "session_start", ctx);
    await runCmd(host, "journey", "on", ctx);
    await fire(host, "turn_end", ctx);
    expect(host.runSubprocessCalls).toHaveLength(0);
  });

  test("autoObserveEnabled=true + tokens 超阈 → 派发一次", async () => {
    const host = makeHost();
    observationJournalFactory(host.api);
    const { ctx } = makeCtx(host, {
      branch: [{ type: "user", id: "e1", data: { text: "hi" } }],
      contextUsage: { tokens: 8000, contextWindow: 200_000 },
      settings: {
        observationJournal: {
          defaultEnabled: false,
          autoObserveEnabled: true,
          observeEveryTokens: 6000,
          observerModel: "@smol",
        },
      },
      activeModel: { provider: "x", id: "y" },
    });
    await fire(host, "session_start", ctx);
    await runCmd(host, "journey", "on", ctx);
    await fire(host, "turn_end", ctx);
    // 等 dispatch 微任务
    // 等 dispatch 结束：调用方 turn_end 是 fire-and-forget，
    // 通过导出的 test helper await 挂在 runtime 上的 promise。
    await _awaitPendingObserverForTesting("session-observer");
    expect(host.runSubprocessCalls.length).toBe(1);
    const call = host.runSubprocessCalls[0] as Record<string, unknown>;
    // observerModel="@smol" 应转成 modelRole
    expect(call.modelRole).toBe("@smol");
  });
});

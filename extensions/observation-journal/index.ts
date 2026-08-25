// Observation Journal — extension entry.
// SPEC: extensions/observation-journal/SPEC.md
//
// Contract summary (see SPEC for full text):
//   * Default OFF. Gate flips via /journey on|off|toggle.
//   * Reuses OMP Session custom entries; branch-aware via `getBranch()`.
//   * Mnemopi is touched only via explicit /journey promote, guarded by confirm.
//   * No project-workspace writes. Journey renders to Session artifacts only.
//   * All persisted string content passes through redactSecrets().

import * as path from "node:path";
import * as fs from "node:fs/promises";

import {
  DEFAULT_CONFIG,
  ENABLED_TYPE,
  OBSERVATION_TYPE,
  PROMOTION_TYPE,
  SEGMENT_TYPE,
  isObservationCategory,
  type CommandArgumentCompletion,
  type CompactingResult,
  type ExtensionAPILike,
  type ExtensionContextLike,
  type JournalConfig,
  type JournalState,
  type JourneySegment,
  type LoggerLike,
  type Observation,
  type PromotionRecord,
  type SelectChoice,
} from "./types.ts";
import { generateId, rebuildFromBranch } from "./ledger.ts";
import { redactSecrets } from "./redaction.ts";
import {
  isImperative,
  renderCompactionInjection,
  renderJourney,
} from "./journey.ts";
import {
  StatusController,
  ToastCoalescer,
  type FooterGauges,
} from "./status-controller.ts";
import { renderTimelineLines } from "./timeline.ts";
import {
  dispatchObserver,
  extractObservations,
  type DispatchObserverResult,
  type ObserverResultObservation,
} from "./observer.ts";


/** Test-only: clear all per-session state. Not part of the runtime contract. */
export function _resetStoresForTesting(): void {
  for (const runtime of runtimeStore.values()) {
    runtime.toast.cancel();
  }
  runtimeStore.clear();
  stateStore.clear();
}

/**
 * Test-only: await 当前 session 上正在跑的 observer dispatch。
 * Turn_end handler 出于设计是 fire-and-forget（不能阻塞主循环），
 * 但测试要断言 dispatch 结束，通过这个 hook 拿到 promise 直接 await。
 */
export async function _awaitPendingObserverForTesting(
  sessionId: string,
): Promise<DispatchObserverResult | null> {
  const runtime = runtimeStore.get(sessionId);
  if (!runtime?.observerPromise) return null;
  return await runtime.observerPromise;
}
const LABEL = "Observation Journal";
const STATUS_KEY = "observation-journal";
const TRACE_MAX = 50;

interface TraceEntry {
  timestamp: string;
  event: string;
  detail?: Record<string, unknown>;
}

// Runtime scratch state, per session id. Not persisted.
interface RuntimeState {
  trace: TraceEntry[];
  status: StatusController;
  toast: ToastCoalescer;
  attached: boolean;
  /** 上一次 observer dispatch 时 usage.tokens 的值；用于阈值-间隔判断。 */
  lastObserverTokens: number;
  /** 当前是否有 observer subagent 在跑。用于避免重叠。 */
  observerInFlight: boolean;
  /** 最近一次 observer 结果摘要（供 /journey status 展示）。 */
  lastObserver?: {
    at: string;
    added: number;
    modelHint?: string;
    error?: string;
  };
  /** observer 中止句柄。 */
  observerAbort?: AbortController;
  /** 当前 in-flight dispatch 的 promise，供测试 await。 */
  observerPromise?: Promise<DispatchObserverResult>;
}

const stateStore = new Map<string, JournalState>();
const runtimeStore = new Map<string, RuntimeState>();

function sessionIdOf(ctx: ExtensionContextLike): string {
  const raw = ctx.sessionManager?.getSessionId?.();
  return typeof raw === "string" && raw.length > 0 ? raw : "unknown";
}

function sessionTitleOf(ctx: ExtensionContextLike): string {
  return (
    ctx.sessionManager?.getSessionTitle?.() ??
    ctx.sessionManager?.getSessionName?.() ??
    "current session"
  );
}

function evidenceEntryIdOf(ctx: ExtensionContextLike): string | undefined {
  const leaf = ctx.sessionManager?.getLeafEntryId?.();
  if (typeof leaf === "string" && leaf.length > 0) return leaf;
  const last = ctx.sessionManager?.getLastEntryId?.();
  if (typeof last === "string" && last.length > 0) return last;
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  const tail = branch.at(-1);
  return tail && typeof tail.id === "string" ? tail.id : undefined;
}

function artifactsDirOf(ctx: ExtensionContextLike): string | undefined {
  return (
    ctx.sessionManager?.getArtifactsDir?.() ??
    ctx.sessionManager?.artifactsDir ??
    ctx.artifactsDir
  );
}

/**
 * 从 ctx.getContextUsage() 取当前 context tokens 计数，缺失当 0。
 * observer 触发和 dispatch 后 lastObserverTokens 记录都用这个入口，
 * 避免俩地方语义漂移。
 */
function pickCurrentTokens(ctx: ExtensionContextLike): number {
  const usage = ctx.getContextUsage?.();
  return typeof usage?.tokens === "number" ? usage.tokens : 0;
}

function runtimeFor(ctx: ExtensionContextLike): RuntimeState {
  const sid = sessionIdOf(ctx);
  const cached = runtimeStore.get(sid);
  if (cached) return cached;
  const fresh: RuntimeState = {
    trace: [],
    status: new StatusController(),
    toast: new ToastCoalescer(),
    attached: false,
    lastObserverTokens: 0,
    observerInFlight: false,
  };
  runtimeStore.set(sid, fresh);
  return fresh;
}

function trace(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  event: string,
  detail?: Record<string, unknown>,
): void {
  const runtime = runtimeFor(ctx);
  const entry: TraceEntry = {
    timestamp: new Date().toISOString(),
    event,
    detail,
  };
  runtime.trace.push(entry);
  if (runtime.trace.length > TRACE_MAX) {
    runtime.trace.splice(0, runtime.trace.length - TRACE_MAX);
  }
  const log: LoggerLike | undefined = pi.logger;
  log?.debug?.("[observation-journal]", event, detail ?? {});
}

function ensureState(ctx: ExtensionContextLike): JournalState {
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  const state = rebuildFromBranch(branch, sessionIdOf(ctx));
  stateStore.set(state.sessionId, state);
  return state;
}

function currentState(ctx: ExtensionContextLike): JournalState {
  const cached = stateStore.get(sessionIdOf(ctx));
  return cached ?? ensureState(ctx);
}

function notify(
  ctx: ExtensionContextLike,
  message: string,
  level: "info" | "warn" | "error" = "info",
): void {
  const ui = ctx.ui;
  if (!ctx.hasUI || !ui?.notify) return;
  if (level === "info") {
    runtimeFor(ctx).toast.queue(message, "info", (msg, lvl) => {
      ui.notify?.(msg, lvl);
    });
    return;
  }
  ui.notify(message, level);
}

const CATEGORY_ORDER = [
  "fact",
  "decision",
  "preference",
  "failed-attempt",
  "deviation",
  "constraint",
  "open-question",
] as const;

const CATEGORY_ICONS: Record<string, string> = {
  fact: "F",
  decision: "D",
  preference: "P",
  "failed-attempt": "X",
  deviation: "≠",
  constraint: "C",
  "open-question": "?",
};

const BAR_WIDTH = 12;

function categoryBuckets(state: JournalState): Record<string, number> {
  const buckets: Record<string, number> = {};
  for (const obs of state.observations) {
    buckets[obs.category] = (buckets[obs.category] ?? 0) + 1;
  }
  return buckets;
}

function histogramLines(state: JournalState): string[] {
  const buckets = categoryBuckets(state);
  const values = Object.values(buckets);
  const max = values.length === 0 ? 0 : Math.max(...values);
  const lines: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const count = buckets[category] ?? 0;
    if (count === 0) continue;
    const filled = max === 0 ? 0 : Math.max(1, Math.round((count / max) * BAR_WIDTH));
    const bar = "█".repeat(filled).padEnd(BAR_WIDTH, "·");
    lines.push(`   ${CATEGORY_ICONS[category]} ${bar} ${count}`);
  }
  return lines;
}

const TIMELINE_CELLS = 20;

function timelineLine(state: JournalState): string | null {
  if (state.observations.length === 0 && state.segments.length === 0) {
    return null;
  }
  const events: Array<{ at: number; glyph: string; kind: "obs" | "cut" }> = [];
  for (const obs of state.observations) {
    const at = Date.parse(obs.timestamp);
    if (Number.isFinite(at)) {
      events.push({ at, glyph: CATEGORY_ICONS[obs.category] ?? "•", kind: "obs" });
    }
  }
  for (const seg of state.segments) {
    if (seg.title === "压缩后快照") {
      const at = Date.parse(seg.timestamp);
      if (Number.isFinite(at)) events.push({ at, glyph: "│", kind: "cut" });
    }
  }
  if (events.length === 0) return null;
  events.sort((a, b) => a.at - b.at);
  const start = events[0].at;
  const end = Date.now();
  const span = Math.max(1, end - start);
  const cells: string[] = Array.from({ length: TIMELINE_CELLS }, () => "·");
  for (const event of events) {
    const ratio = (event.at - start) / span;
    const index = Math.min(TIMELINE_CELLS - 1, Math.max(0, Math.floor(ratio * TIMELINE_CELLS)));
    // Cut has priority over obs to keep boundaries visible.
    if (event.kind === "cut" || cells[index] === "·") {
      cells[index] = event.glyph;
    }
  }
  return cells.join("") + " ▶";
}

function lastTraceError(ctx: ExtensionContextLike): string | null {
  const runtime = runtimeFor(ctx);
  for (let i = runtime.trace.length - 1; i >= 0; i--) {
    const entry = runtime.trace[i];
    if (entry.event === "promote.error" || entry.event === "promote.failed") {
      const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : "";
      return `${entry.event}${detail}`;
    }
  }
  return null;
}

function formatContextUsage(ctx: ExtensionContextLike): string | null {
  const usage = ctx.getContextUsage?.();
  if (!usage) return null;
  const tokens = typeof usage.tokens === "number" ? usage.tokens : undefined;
  const window =
    typeof usage.contextWindow === "number" ? usage.contextWindow : undefined;
  if (tokens === undefined) return null;
  if (window && window > 0) {
    const pct = Math.round((tokens / window) * 100);
    return `ctx ${tokens.toLocaleString()}/${window.toLocaleString()} (${pct}%)`;
  }
  return `ctx ${tokens.toLocaleString()}`;
}

function formatCost(ctx: ExtensionContextLike): string | null {
  const snapshot = ctx.getAsyncJobSnapshot?.();
  if (!snapshot) return null;
  const total = snapshot.cost?.total ?? snapshot.totalCost;
  if (typeof total !== "number") return null;
  return `$${total.toFixed(3)}`;
}

function journalSummaryLine(state: JournalState, pending: number): string {
  return `观察 ${state.observations.length} · Segment ${state.segments.length} · 待提升 ${pending}`;
}

function computeGauges(
  ctx: ExtensionContextLike,
  state: JournalState,
  config: JournalConfig,
): FooterGauges | undefined {
  const usage = ctx.getContextUsage?.();
  const contextTokens = typeof usage?.tokens === "number" ? usage.tokens : 0;
  const contextMax =
    typeof usage?.contextWindow === "number" && usage.contextWindow > 0
      ? usage.contextWindow
      : Math.max(contextTokens, 1);
  const durablePending = state.observations.filter(
    (obs) => obs.durable && !state.promotions.has(obs.id),
  ).length;
  return {
    nextValue: state.observations.length,
    nextMax: Math.max(state.observations.length, config.recentObservationsMax),
    poolValue: durablePending,
    poolMax: Math.max(durablePending, 5),
    ctxValue: contextTokens,
    ctxMax: contextMax,
  };
}

function refreshObservability(
  _ctx: ExtensionContextLike,
  _state: JournalState,
): void {
  // 用户明确要求不要常驻 widget：所有状态通过 /journey status 获取。
  // 保留函数签名以便未来重新引入或做诊断，但当前不做任何 UI 写入。
}

function normalizeContent(raw: string): string {
  return redactSecrets(raw.trim()).slice(0, 400);
}

function loadConfig(ctx: ExtensionContextLike): JournalConfig {
  const raw =
    ctx.settings?.get?.("observationJournal") ??
    ctx.getSetting?.("observationJournal");
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;
  const source = raw as Record<string, unknown>;
  const promotionRaw =
    "promotion" in source &&
    source.promotion &&
    typeof source.promotion === "object"
      ? (source.promotion as Record<string, unknown>)
      : {};
  const patternsRaw = promotionRaw.autoWhitelistPatterns;
  const patterns = Array.isArray(patternsRaw)
    ? patternsRaw.filter((entry): entry is string => typeof entry === "string")
    : DEFAULT_CONFIG.promotion.autoWhitelistPatterns;
  return {
    defaultEnabled:
      typeof source.defaultEnabled === "boolean"
        ? source.defaultEnabled
        : DEFAULT_CONFIG.defaultEnabled,
    observeEveryTokens:
      typeof source.observeEveryTokens === "number"
        ? source.observeEveryTokens
        : DEFAULT_CONFIG.observeEveryTokens,
    autoObserveEnabled:
      typeof source.autoObserveEnabled === "boolean"
        ? source.autoObserveEnabled
        : DEFAULT_CONFIG.autoObserveEnabled,
    observerModel:
      typeof source.observerModel === "string" && source.observerModel.trim().length > 0
        ? source.observerModel.trim()
        : DEFAULT_CONFIG.observerModel,
    journeyMaxSegments:
      typeof source.journeyMaxSegments === "number"
        ? source.journeyMaxSegments
        : DEFAULT_CONFIG.journeyMaxSegments,
    recentObservationsMax:
      typeof source.recentObservationsMax === "number"
        ? source.recentObservationsMax
        : DEFAULT_CONFIG.recentObservationsMax,
    journeyTargetBytes:
      typeof source.journeyTargetBytes === "number"
        ? source.journeyTargetBytes
        : DEFAULT_CONFIG.journeyTargetBytes,
    compactInjectionBytes:
      typeof source.compactInjectionBytes === "number"
        ? source.compactInjectionBytes
        : DEFAULT_CONFIG.compactInjectionBytes,
    promotion: {
      // Stage 3 invariant: auto-retain is hard-off at runtime. SPEC §6.3.
      autoRetainMatched: false,
      autoWhitelistPatterns: patterns,
    },
  };
}

function requireEnabled(ctx: ExtensionContextLike): JournalState | null {
  const state = currentState(ctx);
  if (!state.enabled) {
    notify(ctx, "观察日志当前关闭。运行 /journey on 启用。");
    return null;
  }
  return state;
}

function hasGateEntry(ctx: ExtensionContextLike): boolean {
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  return branch.some(
    (entry) =>
      entry.type === "custom" &&
      "customType" in entry &&
      (entry as { customType?: unknown }).customType === ENABLED_TYPE,
  );
}

function summariseRecent(state: JournalState): JourneySegment {
  const recent = state.observations.slice(-10);
  const body =
    recent.length === 0
      ? "No new observations."
      : recent
          .map((obs) => `- [${obs.category}] ${obs.content}`)
          .join("\n")
          .slice(0, 800);
  return {
    id: generateId("seg"),
    timestamp: new Date().toISOString(),
    title: "手动 flush",
    body: redactSecrets(body),
    sourceObservationIds: recent.map((obs) => obs.id),
  };
}

async function writeArtifact(
  ctx: ExtensionContextLike,
  body: string,
): Promise<string | null> {
  const artifactsDir = artifactsDirOf(ctx);
  if (!artifactsDir) return null;
  const dir = path.join(artifactsDir, "observation-journal");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "JOURNEY.md");
  await fs.writeFile(file, body, "utf8");
  return file;
}

function persistObservation(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  observation: Observation,
): void {
  pi.appendEntry(OBSERVATION_TYPE, observation);
  currentState(ctx).observations.push(observation);
}

function persistSegment(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  segment: JourneySegment,
): void {
  pi.appendEntry(SEGMENT_TYPE, segment);
  currentState(ctx).segments.push(segment);
}

// ---------- Auto observer (subagent) helpers ----------

const OBSERVER_CHUNK_MAX_ENTRIES = 60;
const OBSERVER_CHUNK_MAX_BYTES = 12_000;

/**
 * Best-effort chunk text builder: 从 branch 里挑最近的 N 条非-custom entry，
 * 每条压平为一行短 JSON。observer 需要片段感（谁说了什么、用了什么工具），
 * 不需要 pretty print。
 */
function serializeRecentChunk(ctx: ExtensionContextLike): string {
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  const slice = branch.slice(-OBSERVER_CHUNK_MAX_ENTRIES);
  const lines: string[] = [];
  let total = 0;
  for (const entry of slice) {
    if (entry.type === "custom") continue;
    let payload: string;
    try {
      payload = JSON.stringify({ type: entry.type, data: entry.data });
    } catch {
      payload = JSON.stringify({ type: entry.type });
    }
    if (payload.length > 1500) payload = payload.slice(0, 1500) + "…";
    total += payload.length + 1;
    if (total > OBSERVER_CHUNK_MAX_BYTES) break;
    lines.push(payload);
  }
  return lines.join("\n");
}

/**
 * 把 observer 返回的一条观察落地到 ledger。分类不合法就丢弃，源信息记为 subagent。
 */
function persistObserverObservation(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  raw: ObserverResultObservation,
): boolean {
  const category = raw.category.trim();
  if (!isObservationCategory(category)) return false;
  const text = normalizeContent(raw.text);
  if (text.length === 0) return false;
  const observation: Observation = {
    id: generateId("obs"),
    timestamp: new Date().toISOString(),
    sessionId: sessionIdOf(ctx),
    category,
    content: text,
    evidenceEntryIds: [evidenceEntryIdOf(ctx) ?? ""].filter((s) => s.length > 0),
    durable: false,
    source: "subagent",
  };
  persistObservation(pi, ctx, observation);
  return true;
}

/**
 * 触发一次 observer subagent。in-flight guard、trace、状态、通知全在这里。
 * 调用方需保证 config.autoObserveEnabled 已 gated。
 */
function triggerAutoObserver(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  reason: "threshold" | "manual",
): Promise<DispatchObserverResult> {
  const runtime = runtimeFor(ctx);
  if (runtime.observerInFlight) {
    return Promise.resolve({
      observations: [],
      ranSubprocess: false,
      error: "已有 observer 在跑",
    });
  }
  const chunkText = serializeRecentChunk(ctx);
  if (chunkText.length === 0) {
    return Promise.resolve({
      observations: [],
      ranSubprocess: false,
      error: "无可观察内容",
    });
  }
  const config = loadConfig(ctx);
  const abort = new AbortController();
  runtime.observerAbort = abort;
  runtime.observerInFlight = true;
  runtime.lastObserverTokens = pickCurrentTokens(ctx);
  trace(pi, ctx, "observer.dispatch", {
    reason,
    chunkBytes: chunkText.length,
    observerModel: config.observerModel ?? "(fallback:session-active)",
  });

  const promise = (async (): Promise<DispatchObserverResult> => {
    let result: DispatchObserverResult;
    try {
      result = await dispatchObserver({
        pi,
        ctx,
        chunkText,
        observerModel: config.observerModel,
        signal: abort.signal,
      });
    } finally {
      runtime.observerInFlight = false;
      runtime.observerAbort = undefined;
      runtime.observerPromise = undefined;
    }
    if (result.error) {
      runtime.lastObserver = {
        at: new Date().toISOString(),
        added: 0,
        modelHint: result.modelHint,
        error: result.error,
      };
      trace(pi, ctx, "observer.error", { error: result.error });
      return result;
    }
    let added = 0;
    for (const raw of result.observations) {
      if (persistObserverObservation(pi, ctx, raw)) added += 1;
    }
    runtime.lastObserver = {
      at: new Date().toISOString(),
      added,
      modelHint: result.modelHint,
    };
    trace(pi, ctx, "observer.done", {
      added,
      total: result.observations.length,
      modelHint: result.modelHint,
    });
    return result;
  })();
  runtime.observerPromise = promise;
  return promise;
}


function persistGate(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  enabled: boolean,
): void {
  pi.appendEntry(ENABLED_TYPE, { enabled });
  currentState(ctx).enabled = enabled;
}

function persistObservation(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  observation: Observation,
): void {
  pi.appendEntry(OBSERVATION_TYPE, observation);
  const state = currentState(ctx);
  const existing = state.observations.findIndex(
    (obs) => obs.id === observation.id,
  );
  if (existing >= 0) {
    state.observations[existing] = observation;
  } else {
    state.observations.push(observation);
  }
}

function persistPromotion(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  record: PromotionRecord,
): void {
  pi.appendEntry(PROMOTION_TYPE, record);
  currentState(ctx).promotions.set(record.observationId, record);
}

function handleGate(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  next: boolean,
): void {
  const state = currentState(ctx);
  if (state.enabled === next) {
    notify(ctx, `观察日志已处于${next ? "启用" : "关闭"}状态。`);
    return;
  }
  persistGate(pi, ctx, next);
  trace(pi, ctx, "gate", { enabled: next });
  refreshObservability(ctx, currentState(ctx));
  notify(ctx, `观察日志已${next ? "启用" : "关闭"}。`);
}

function handleStatus(ctx: ExtensionContextLike): void {
  const state = currentState(ctx);
  const durablePending = state.observations.filter(
    (obs) => obs.durable && !state.promotions.has(obs.id),
  ).length;
  const promoted = Array.from(state.promotions.values()).filter(
    (rec) => rec.status === "promoted",
  ).length;
  const buckets = categoryBuckets(state);
  const breakdown = CATEGORY_ORDER
    .filter((cat) => (buckets[cat] ?? 0) > 0)
    .map((cat) => `${cat}=${buckets[cat]}`)
    .join(" ");
  const journeySize = state.segments.reduce(
    (sum, seg) => sum + seg.body.length,
    0,
  );
  const usage = formatContextUsage(ctx) ?? "ctx 不可用";
  const cost = formatCost(ctx) ?? "cost 不可用";
  const err = lastTraceError(ctx) ?? "无";
  const cursor = state.cursor
    ? `${state.cursor.coversUpToEntryId} (+${state.cursor.tokensSince}t)`
    : "无";
  const runtime = runtimeFor(ctx);
  const lines = [
    `观察日志 · ${state.enabled ? "启用" : "关闭"}`,
    `  观察数：      ${state.observations.length}  （待提升 ${durablePending}，已提升 ${promoted}）`,
    `  分类分布：    ${breakdown || "—"}`,
    `  Segment：     ${state.segments.length}  （Journey 正文 ${journeySize} 字符）`,
    `  Cursor：      ${cursor}`,
    `  Trace：       ${runtime.trace.length} 条  最近错误：${err}`,
    `  上下文：      ${usage}`,
    `  成本：        ${cost}`,
  ];
  notify(ctx, lines.join("\n"));
}

async function handleShow(ctx: ExtensionContextLike): Promise<void> {
  const state = currentState(ctx);
  if (!state.enabled) {
    notify(ctx, "请先运行 /journey on 启用观察日志。");
    return;
  }
  const config = loadConfig(ctx);
  const body = renderJourney({
    sessionTitle: sessionTitleOf(ctx),
    observations: state.observations,
    segments: state.segments,
    config,
    now: new Date().toISOString(),
  });
  if (ctx.ui?.editor) {
    await ctx.ui.editor({ title: "观察日志", content: body, readOnly: true });
    return;
  }
  notify(ctx, `Journey（${body.length} 字节）：\n${body}`);
}

function handleAdd(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  categoryToken: string | undefined,
  rest: string,
): void {
  const state = requireEnabled(ctx);
  if (!state) return;
  const category = (categoryToken ?? "").toLowerCase();
  if (!isObservationCategory(category)) {
    notify(
      ctx,
      "Usage: /journey add <fact|decision|preference|failed-attempt|deviation|constraint|open-question> <content>",
      "warn",
    );
    return;
  }
  const contentRaw = rest.slice(category.length).trim();
  if (contentRaw.length === 0) {
    notify(ctx, "观察内容不能为空。", "warn");
    return;
  }
  if (isImperative(contentRaw)) {
    notify(
      ctx,
      "观察必须描述已发生的事实，不能是命令句式。请改写后重试。",
      "warn",
    );
    return;
  }
  const evidenceEntryId = evidenceEntryIdOf(ctx);
  if (!evidenceEntryId) {
    notify(
      ctx,
      "找不到证据 entry，拒绝写入观察。",
      "warn",
    );
    return;
  }
  const observation: Observation = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    sessionId: state.sessionId,
    category,
    content: normalizeContent(contentRaw),
    evidenceEntryIds: [evidenceEntryId],
    durable: false,
    source: "manual",
  };
  persistObservation(pi, ctx, observation);
  trace(pi, ctx, `add.${category}`, { id: observation.id });
  refreshObservability(ctx, currentState(ctx));
  notify(ctx, `已记录观察 ${observation.id}（${category}）。`);
}

function handleMarkDurable(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  observationId: string | undefined,
): void {
  const state = requireEnabled(ctx);
  if (!state) return;
  if (!observationId) {
    notify(ctx, "用法：/journey mark-durable <观察 id>", "warn");
    return;
  }
  const target = state.observations.find((obs) => obs.id === observationId);
  if (!target) {
    notify(ctx, `未找到观察 ${observationId}。`, "warn");
    return;
  }
  if (target.durable) {
    notify(ctx, `观察 ${observationId} 已是待提升候选。`);
    return;
  }
  const updated: Observation = { ...target, durable: true };
  persistObservation(pi, ctx, updated);
  trace(pi, ctx, "mark-durable", { id: observationId });
  refreshObservability(ctx, currentState(ctx));
  notify(ctx, `已把观察 ${observationId} 标记为待提升候选。`);
}

async function handleFlush(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
): Promise<void> {
  const state = requireEnabled(ctx);
  if (!state) return;
  const segment = summariseRecent(state);
  persistSegment(pi, ctx, segment);
  const config = loadConfig(ctx);
  const body = renderJourney({
    sessionTitle: sessionTitleOf(ctx),
    observations: state.observations,
    segments: state.segments,
    config,
    now: new Date().toISOString(),
  });
  const written = await writeArtifact(ctx, body);
  trace(pi, ctx, "flush", { segmentId: segment.id, bytes: body.length });
  refreshObservability(ctx, currentState(ctx));
  notify(
    ctx,
    written
      ? `已记录 segment ${segment.id}；JOURNEY.md 落盘到 ${written}。`
      : `已记录 segment ${segment.id}；无 artifacts 目录，跳过磁盘落地。`,
  );
}

async function handleExport(
  ctx: ExtensionContextLike,
  rest: string,
): Promise<void> {
  const state = requireEnabled(ctx);
  if (!state) return;
  const target = rest.trim();
  if (target.length === 0) {
    notify(ctx, "用法：/journey export <路径>", "warn");
    return;
  }
  const config = loadConfig(ctx);
  const body = renderJourney({
    sessionTitle: sessionTitleOf(ctx),
    observations: state.observations,
    segments: state.segments,
    config,
    now: new Date().toISOString(),
  });
  const resolved = path.resolve(target);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, body, "utf8");
  notify(ctx, `Journey 已导出到 ${resolved}。`);
}

async function handleObserve(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
): Promise<void> {
  const state = requireEnabled(ctx);
  if (!state) return;
  const brief =
    "观察日志请求：请阅读最近一轮对话，按下面的**精确格式**（一行一条，不用 markdown）提出至多 5 条观察：\n" +
    "  <category> :: <短事实句>\n" +
    "category 从 fact | decision | preference | failed-attempt | deviation | constraint | open-question 里选。\n" +
    "每一条先让我确认，我确认后再调用 `/journey add <category> <content>`。绝不写命令句式或指令式的话。";
  if (typeof pi.sendUserMessage === "function") {
    await pi.sendUserMessage(brief, { deliverAs: "nextTurn" });
    trace(pi, ctx, "observe.request", {});
    notify(ctx, "已把观察请求排入下一轮，由主 Agent 提出候选。");
    return;
  }
  notify(
    ctx,
    "当前 host 不支持 sendUserMessage；请手动运行 `/journey add`。",
    "warn",
  );
}

async function handleObserveNow(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
): Promise<void> {
  const state = requireEnabled(ctx);
  if (!state) return;
  const runtime = runtimeFor(ctx);
  if (runtime.observerInFlight) {
    notify(ctx, "已有 observer 在跑，请稍候。", "warn");
    return;
  }
  notify(ctx, "正在后台派发 observer subagent…");
  const result = await triggerAutoObserver(pi, ctx, "manual");
  if (!result.ranSubprocess) {
    notify(ctx, `Observer 未运行：${result.error ?? "未知原因"}`, "warn");
    return;
  }
  if (result.error) {
    notify(ctx, `Observer 出错：${result.error}`, "error");
    return;
  }
  const added = result.observations.length;
  notify(
    ctx,
    added === 0
      ? "Observer 完成：无新增观察。"
      : `Observer 完成：新增 ${added} 条观察（模型：${result.modelHint ?? "?"}）。`,
  );
}

function handleCompacting(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
): CompactingResult | undefined {
  const state = currentState(ctx);
  if (!state.enabled) return undefined;
  if (state.observations.length === 0 && state.segments.length === 0) {
    return undefined;
  }
  const config = loadConfig(ctx);
  const rendered = renderCompactionInjection({
    segments: state.segments,
    observations: state.observations,
    maxBytes: config.compactInjectionBytes,
    now: new Date().toISOString(),
  });
  const safe = redactSecrets(rendered);
  trace(pi, ctx, "compacting.injected", { bytes: safe.length });
  return { context: [safe] };
}

function candidateObservations(state: JournalState): Observation[] {
  return state.observations.filter(
    (obs) => obs.durable && !state.promotions.has(obs.id),
  );
}

async function handleCandidates(ctx: ExtensionContextLike): Promise<void> {
  const state = requireEnabled(ctx);
  if (!state) return;
  const candidates = candidateObservations(state);
  if (candidates.length === 0) {
    notify(ctx, "暂无待提升候选。请先 /journey mark-durable。");
    return;
  }
  const lines = candidates.map(
    (obs) => `- ${obs.id} [${obs.category}] ${obs.content}`,
  );
  notify(ctx, `共 ${candidates.length} 个候选：\n${lines.join("\n")}`);
}

async function handlePromote(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  observationId: string | undefined,
): Promise<void> {
  const state = requireEnabled(ctx);
  if (!state) return;
  let targetId = observationId;
  const candidates = candidateObservations(state);
  if (!targetId) {
    if (candidates.length === 0) {
      notify(ctx, "暂无待提升候选。");
      return;
    }
    if (typeof ctx.ui?.select === "function") {
      const choices: SelectChoice[] = candidates.map((obs) => ({
        label: `[${obs.category}] ${obs.content}`,
        value: obs.id,
        description: `id=${obs.id} durable=true`,
      }));
      targetId = await ctx.ui.select({
        title: "提升观察到 Mnemopi",
        message: "选择一条要写入 Mnemopi 的观察。",
        choices,
      });
      if (!targetId) {
        notify(ctx, "提升已取消。");
        return;
      }
    } else {
      notify(ctx, "用法：/journey promote <观察 id>", "warn");
      return;
    }
  }
  const target = state.observations.find((obs) => obs.id === targetId);
  if (!target) {
    notify(ctx, `未找到观察 ${targetId}。`, "warn");
    return;
  }
  if (!target.durable) {
    notify(
      ctx,
      `观察 ${targetId} 未标记为待提升；请先 /journey mark-durable。`,
      "warn",
    );
    return;
  }
  const already = state.promotions.get(targetId);
  if (already && already.status === "promoted") {
    notify(ctx, `观察 ${targetId} 已提升过（memoryId=${already.memoryId ?? "?"}）。`);
    return;
  }
  if (typeof ctx.ui?.confirm === "function") {
    const ok = await ctx.ui.confirm(
      "是否写入 Mnemopi？",
      `[${target.category}] ${target.content}`,
    );
    if (!ok) {
      persistPromotion(pi, ctx, {
        observationId: target.id,
        status: "skipped",
        note: "用户拒绝了 confirm",
        reviewedAt: new Date().toISOString(),
      });
      trace(pi, ctx, "promote.skipped", { id: target.id });
      refreshObservability(ctx, currentState(ctx));
      notify(ctx, `已取消提升 ${target.id}。`);
      return;
    }
  }
  const memory = ctx.memory;
  if (typeof memory?.save !== "function") {
    persistPromotion(pi, ctx, {
      observationId: target.id,
      status: "failed",
      note: "Memory 后端不可用",
      reviewedAt: new Date().toISOString(),
    });
    trace(pi, ctx, "promote.failed", { id: target.id, reason: "no-backend" });
    notify(ctx, "Memory 后端不可用；已记录为 failed。", "warn");
    return;
  }
  const safeContent = redactSecrets(target.content);
  try {
    const result = await memory.save({
      content: safeContent,
      metadata: {
        sourceObservationId: target.id,
        category: target.category,
        sessionId: target.sessionId,
        source: "observation-journal",
      },
    });
    const memoryId =
      result && typeof result === "object" && "id" in result && typeof result.id === "string"
        ? result.id
        : undefined;
    persistPromotion(pi, ctx, {
      observationId: target.id,
      memoryId,
      status: "promoted",
      reviewedAt: new Date().toISOString(),
    });
    trace(pi, ctx, "promote.ok", { id: target.id, memoryId });
    refreshObservability(ctx, currentState(ctx));
    notify(ctx, `观察 ${target.id} 已写入 Mnemopi${memoryId ? `（memoryId=${memoryId}）` : ""}。`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    persistPromotion(pi, ctx, {
      observationId: target.id,
      status: "failed",
      note: message.slice(0, 200),
      reviewedAt: new Date().toISOString(),
    });
    trace(pi, ctx, "promote.error", { id: target.id, message });
    notify(ctx, `提升 ${target.id} 失败：${message}`, "error");
  }
}

async function handleForget(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  observationId: string | undefined,
): Promise<void> {
  const state = requireEnabled(ctx);
  if (!state) return;
  if (!observationId) {
    notify(ctx, "用法：/journey forget <观察 id>", "warn");
    return;
  }
  const target = state.observations.find((obs) => obs.id === observationId);
  if (!target) {
    notify(ctx, `未找到观察 ${observationId}。`, "warn");
    return;
  }
  if (typeof ctx.ui?.confirm === "function") {
    const ok = await ctx.ui.confirm(
      "确认丢弃这条观察？",
      `[${target.category}] ${target.content}`,
    );
    if (!ok) {
      notify(ctx, "取消丢弃。");
      return;
    }
  }
  persistPromotion(pi, ctx, {
    observationId: target.id,
    status: "skipped",
    note: "手动丢弃",
    reviewedAt: new Date().toISOString(),
  });
  trace(pi, ctx, "forget", { id: target.id });
  refreshObservability(ctx, currentState(ctx));
  notify(ctx, `观察 ${target.id} 已丢弃（不会再出现在候选中）。`);
}

async function handleTrace(ctx: ExtensionContextLike): Promise<void> {
  const runtime = runtimeFor(ctx);
  if (runtime.trace.length === 0) {
    notify(ctx, "事件轨迹为空。");
    return;
  }
  const lines = runtime.trace.map((entry) => {
    const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : "";
    return `[${entry.timestamp}] ${entry.event}${detail}`;
  });
  const body = lines.join("\n");
  if (ctx.ui?.editor) {
    await ctx.ui.editor({ title: "事件轨迹", content: body, readOnly: true });
    return;
  }
  notify(ctx, `事件轨迹（${runtime.trace.length} 条）：\n${body}`);
}

async function handleDump(ctx: ExtensionContextLike): Promise<void> {
  const state = currentState(ctx);
  const dump = {
    sessionId: state.sessionId,
    enabled: state.enabled,
    observations: state.observations,
    segments: state.segments,
    cursor: state.cursor ?? null,
    promotions: Array.from(state.promotions.values()),
    config: loadConfig(ctx),
  };
  const body = JSON.stringify(dump, null, 2);
  if (ctx.ui?.editor) {
    await ctx.ui.editor({ title: "内部状态", content: body, readOnly: true });
    return;
  }
  notify(ctx, `内部状态（${body.length} 字节）：\n${body}`);
}

const HELP_LINES: string[] = [
  "观察日志 · /journey 子命令",
  "",
  "  /journey                              打印状态快照",
  "  /journey on | off | toggle            启用 / 关闭 / 翻转",
  "  /journey status                       计数、分类、上下文、成本",
  "  /journey show                         打开完整 JOURNEY 只读视图",
  "  /journey add <分类> <内容>            记录一条观察",
  "  /journey mark-durable <id>            标记为待提升候选",
  "  /journey flush                        合并成 segment 并落盘",
  "  /journey export <路径>                导出 JOURNEY.md 到指定路径",
  "  /journey observe                      让主 Agent 提出观察候选",
  "  /journey candidates                   列出待提升候选",
  "  /journey promote [<id>]               写入 Mnemopi（需要 confirm）",
  "  /journey forget <id>                  从候选池丢弃",
  "  /journey trace                        最近事件轨迹",
  "  /journey dump                         内部完整状态（JSON）",
  "  /journey help                         本帮助",
  "",
  "分类：",
  "  fact（事实） | decision（决定） | preference（偏好） |",
  "  failed-attempt（失败） | deviation（偏离） | constraint（约束） |",
  "  open-question（未决）",
  "",
  "默认每次会话关闭。提升到 Mnemopi 只走手动路径。",
];

async function handleHelp(ctx: ExtensionContextLike): Promise<void> {
  const body = HELP_LINES.join("\n");
  if (ctx.ui?.editor) {
    await ctx.ui.editor({ title: "帮助", content: body, readOnly: true });
    return;
  }
  notify(ctx, body);
}

async function handleCommand(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  rawArgs: string,
): Promise<void> {
  try {
    const args = (rawArgs ?? "").trim();
    const [subcommandRaw, ...restTokens] = args.split(/\s+/);
    const subcommand = (subcommandRaw ?? "").toLowerCase();
    const rest = args.slice(subcommandRaw?.length ?? 0).trim();

    if (subcommand.length === 0 || subcommand === "status") {
      handleStatus(ctx);
      return;
    }
    if (subcommand === "on") return await handleGate(pi, ctx, true);
    if (subcommand === "off") return await handleGate(pi, ctx, false);
    if (subcommand === "toggle") {
      return await handleGate(pi, ctx, !currentState(ctx).enabled);
    }
    if (subcommand === "show") return await handleShow(ctx);
    if (subcommand === "add") return await handleAdd(pi, ctx, restTokens[0], rest);
    if (subcommand === "mark-durable") {
      return await handleMarkDurable(pi, ctx, restTokens[0]);
    }
    if (subcommand === "flush") return await handleFlush(pi, ctx);
    if (subcommand === "export") return await handleExport(ctx, rest);
    if (subcommand === "observe") return await handleObserve(pi, ctx);
    if (subcommand === "observe-now") return await handleObserveNow(pi, ctx);
    if (subcommand === "candidates") return await handleCandidates(ctx);
    if (subcommand === "promote") {
      return await handlePromote(pi, ctx, restTokens[0]);
    }
    if (subcommand === "forget") return await handleForget(pi, ctx, restTokens[0]);
    if (subcommand === "trace") return await handleTrace(ctx);
    if (subcommand === "dump") return await handleDump(ctx);
    if (subcommand === "help" || subcommand === "?") return await handleHelp(ctx);
    notify(
      ctx,
      `未知子命令：${subcommand}。运行 /journey help 查看完整列表。`,
      "warn",
    );
  } finally {
    if (ctx.hasUI && ctx.ui?.notify) {
      runtimeFor(ctx).toast.flush();
    }
  }
}

export default function observationJournal(pi: ExtensionAPILike): void {
  pi.setLabel?.(LABEL);

  pi.on("session_start", (_event, ctx) => {
    const state = ensureState(ctx);
    trace(pi, ctx, "session_start", {
      sessionId: state.sessionId,
      branchLen: ctx.sessionManager?.getBranch?.().length ?? 0,
    });
    const config = loadConfig(ctx);
    // 只有在 branch 上没有任何 gate entry 时才应用 config default。
    // 一旦用户在会话里 /journey on 或 /journey off 过，其决定持久化并覆盖 config。
    if (config.defaultEnabled && !state.enabled && !hasGateEntry(ctx)) {
      persistGate(pi, ctx, true);
      trace(pi, ctx, "gate.default-enabled", {});
    }
  });

  pi.on("session_branch", (_event, ctx) => {
    const state = ensureState(ctx);
    trace(pi, ctx, "session_branch", {});
    refreshObservability(ctx, state);
  });
  pi.on("session_tree", (_event, ctx) => {
    const state = ensureState(ctx);
    trace(pi, ctx, "session_tree", {});
    refreshObservability(ctx, state);
  });
  pi.on("session_switch", (_event, ctx) => {
    const state = ensureState(ctx);
    trace(pi, ctx, "session_switch", {});
    refreshObservability(ctx, state);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sid = sessionIdOf(ctx);
    const runtime = runtimeStore.get(sid);
    if (runtime) {
      runtime.toast.cancel();
      runtime.observerAbort?.abort();
    }
    stateStore.delete(sid);
    runtimeStore.delete(sid);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!currentState(ctx).enabled) return;
    ensureState(ctx);
    trace(pi, ctx, "turn_end", {});
    refreshObservability(ctx, currentState(ctx));

    // 自动 observer：以「距上次观察至少累积 observeEveryTokens」为触发条件。
    // usage.tokens 是当前 context 大小（含所有历史），不是 raw delta；
    // 与 pi-om 的 raw-token chunker 不同，但对 extension 只是启发式够用。
    const config = loadConfig(ctx);
    if (!config.autoObserveEnabled) return;
    const runtime = runtimeFor(ctx);
    if (runtime.observerInFlight) return;
    const tokensNow = pickCurrentTokens(ctx);
    if (tokensNow < config.observeEveryTokens) return;
    if (tokensNow - runtime.lastObserverTokens < config.observeEveryTokens) return;
    void triggerAutoObserver(pi, ctx, "threshold").catch((err) => {
      trace(pi, ctx, "observer.uncaught", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  pi.on("session.compacting", (_event, ctx) => handleCompacting(pi, ctx));

  pi.on("session_compact", (_event, ctx) => {
    const state = currentState(ctx);
    if (!state.enabled) return;
    const summary = summariseRecent(state);
    persistSegment(pi, ctx, {
      ...summary,
      title: "压缩后快照",
    });
    trace(pi, ctx, "session_compact", { segmentId: summary.id });
    refreshObservability(ctx, currentState(ctx));
  });

  const SUBCOMMAND_MENU: CommandArgumentCompletion[] = [
    { label: "on", value: "on", description: "启用当前会话的观察日志" },
    { label: "off", value: "off", description: "关闭当前会话的观察日志" },
    { label: "toggle", value: "toggle", description: "翻转启用状态" },
    { label: "status", value: "status", description: "打印计数、分类、上下文和成本" },
    { label: "show", value: "show", description: "以只读方式打开当前 Journey" },
    { label: "add", value: "add ", description: "记录一条观察：<分类> <内容>" },
    { label: "mark-durable", value: "mark-durable ", description: "把一条观察标记为待提升候选" },
    { label: "flush", value: "flush", description: "把最近观察合并成 segment 并落盘 JOURNEY.md" },
    { label: "export", value: "export ", description: "把 JOURNEY.md 导出到指定路径" },
    { label: "observe", value: "observe", description: "让主 Agent 在下一轮提出观察候选（主对话）" },
    { label: "observe-now", value: "observe-now", description: "立即 spawn observer subagent 后台抽取观察" },
    { label: "candidates", value: "candidates", description: "列出待写入 Mnemopi 的候选" },
    { label: "promote", value: "promote", description: "把 durable 观察写入 Mnemopi（需要 confirm）" },
    { label: "forget", value: "forget ", description: "从候选池丢弃某条观察" },
    { label: "trace", value: "trace", description: "查看最近的事件轨迹" },
    { label: "dump", value: "dump", description: "以 JSON 打印内部状态" },
    { label: "help", value: "help", description: "打印全部子命令说明" },
  ];

  function completionsFor(prefix: string): CommandArgumentCompletion[] | null {
    const trimmed = prefix.trimStart();
    // 一旦输入含空格，说明已经进入某个子命令的参数区，交给该子命令自己补全。
    if (trimmed.includes(" ")) return null;
    const query = trimmed.toLowerCase();
    const match = SUBCOMMAND_MENU.filter((item) =>
      item.label.startsWith(query),
    );
    return match.length > 0 ? match : null;
  }

  function inlineHintFor(prefix: string): string | null {
    const trimmed = prefix.trim();
    if (trimmed.length === 0) return "<子命令>";
    const [head, ...rest] = trimmed.split(/\s+/);
    if (rest.length === 0) return null;
    if (head === "add") return "<分类> <内容>";
    if (head === "mark-durable") return "<观察 id>";
    if (head === "promote") return "[<观察 id>]";
    if (head === "forget") return "<观察 id>";
    if (head === "export") return "<路径>";
    return null;
  }

  pi.registerCommand("journey", {
    description: "分支感知的观察日志（Observation Journal）。",
    getInlineHint: inlineHintFor,
    getArgumentCompletions: completionsFor,
    handler: (args, ctx) => handleCommand(pi, ctx, args),
  });
}

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

function runtimeFor(ctx: ExtensionContextLike): RuntimeState {
  const sid = sessionIdOf(ctx);
  const cached = runtimeStore.get(sid);
  if (cached) return cached;
  const fresh: RuntimeState = { trace: [] };
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
  if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(message, level);
}

const CATEGORY_ICONS: Record<string, string> = {
  fact: "F",
  decision: "D",
  preference: "P",
  "failed-attempt": "X",
  deviation: "≠",
  constraint: "C",
  "open-question": "?",
};

function categoryHistogram(state: JournalState): string {
  const buckets: Record<string, number> = {};
  for (const obs of state.observations) {
    buckets[obs.category] = (buckets[obs.category] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const [category, icon] of Object.entries(CATEGORY_ICONS)) {
    const count = buckets[category] ?? 0;
    if (count > 0) parts.push(`${icon}${count}`);
  }
  return parts.length === 0 ? "—" : parts.join(" ");
}

function refreshObservability(
  ctx: ExtensionContextLike,
  state: JournalState,
): void {
  const durablePending = state.observations.filter(
    (obs) => obs.durable && !state.promotions.has(obs.id),
  ).length;
  if (!state.enabled) {
    const line = "📓 Journal · off · type /journey on to enable";
    if (ctx.hasUI) {
      ctx.ui?.setStatus?.(STATUS_KEY, "Journal · off");
      ctx.ui?.setWidget?.({ placement: "aboveEditor", content: [line] });
    }
    return;
  }
  const summary = `Journal · ${state.observations.length} obs · ${state.segments.length} seg · ${durablePending} pending`;
  const histogram = categoryHistogram(state);
  if (ctx.hasUI) {
    ctx.ui?.setStatus?.(STATUS_KEY, summary);
    ctx.ui?.setWidget?.({
      placement: "aboveEditor",
      content: [`📓 ${summary}`, `   ${histogram}`],
    });
  }
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
    observeEveryTokens:
      typeof source.observeEveryTokens === "number"
        ? source.observeEveryTokens
        : DEFAULT_CONFIG.observeEveryTokens,
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
    notify(ctx, "Observation Journal is disabled. Run /journey on to enable.");
    return null;
  }
  return state;
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
    title: "Manual flush",
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
    notify(ctx, `Observation Journal already ${next ? "on" : "off"}.`);
    return;
  }
  persistGate(pi, ctx, next);
  trace(pi, ctx, "gate", { enabled: next });
  refreshObservability(ctx, currentState(ctx));
  notify(ctx, `Observation Journal ${next ? "enabled" : "disabled"}.`);
}

function handleStatus(ctx: ExtensionContextLike): void {
  const state = currentState(ctx);
  const cursor = state.cursor
    ? `cursor=${state.cursor.coversUpToEntryId} (+${state.cursor.tokensSince}t)`
    : "cursor=(none)";
  notify(
    ctx,
    [
      `enabled=${state.enabled}`,
      `observations=${state.observations.length}`,
      `segments=${state.segments.length}`,
      `promotions=${state.promotions.size}`,
      cursor,
    ].join(" | "),
  );
}

async function handleShow(ctx: ExtensionContextLike): Promise<void> {
  const state = currentState(ctx);
  if (!state.enabled) {
    notify(ctx, "Enable Observation Journal first: /journey on");
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
    await ctx.ui.editor({ title: "Journey", content: body, readOnly: true });
    return;
  }
  notify(ctx, `Journey (${body.length} bytes):\n${body}`);
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
    notify(ctx, "Observation content is required.", "warn");
    return;
  }
  if (isImperative(contentRaw)) {
    notify(
      ctx,
      "Observations must describe events, not issue instructions. Reword and retry.",
      "warn",
    );
    return;
  }
  const evidenceEntryId = evidenceEntryIdOf(ctx);
  if (!evidenceEntryId) {
    notify(
      ctx,
      "No evidence entry available; refusing to write observation.",
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
  notify(ctx, `Observation ${observation.id} recorded (${category}).`);
}

function handleMarkDurable(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  observationId: string | undefined,
): void {
  const state = requireEnabled(ctx);
  if (!state) return;
  if (!observationId) {
    notify(ctx, "Usage: /journey mark-durable <observationId>", "warn");
    return;
  }
  const target = state.observations.find((obs) => obs.id === observationId);
  if (!target) {
    notify(ctx, `Observation ${observationId} not found.`, "warn");
    return;
  }
  if (target.durable) {
    notify(ctx, `Observation ${observationId} already durable.`);
    return;
  }
  const updated: Observation = { ...target, durable: true };
  persistObservation(pi, ctx, updated);
  trace(pi, ctx, "mark-durable", { id: observationId });
  refreshObservability(ctx, currentState(ctx));
  notify(ctx, `Observation ${observationId} marked durable.`);
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
      ? `Segment ${segment.id} recorded; JOURNEY.md written to ${written}.`
      : `Segment ${segment.id} recorded; artifacts dir unavailable.`,
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
    notify(ctx, "Usage: /journey export <path>", "warn");
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
  notify(ctx, `Journey exported to ${resolved}.`);
}

async function handleObserve(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
): Promise<void> {
  const state = requireEnabled(ctx);
  if (!state) return;
  const brief =
    "Observation Journal request: read the recent turn, then propose at most 5 short observations using this exact response shape (one per line, no markdown):\n" +
    "  <category> :: <short factual sentence>\n" +
    "categories: fact | decision | preference | failed-attempt | deviation | constraint | open-question\n" +
    "For each proposed line, ask me to confirm and, on confirmation, invoke `/journey add <category> <content>`. Never write imperative or instructional prose.";
  if (typeof pi.sendUserMessage === "function") {
    await pi.sendUserMessage(brief, { deliverAs: "nextTurn" });
    trace(pi, ctx, "observe.request", {});
    notify(ctx, "Observation request queued for the next turn.");
    return;
  }
  notify(
    ctx,
    "sendUserMessage is not available in this host; run `/journey add` manually.",
    "warn",
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
    notify(ctx, "No pending promotion candidates. Use /journey mark-durable first.");
    return;
  }
  const lines = candidates.map(
    (obs) => `- ${obs.id} [${obs.category}] ${obs.content}`,
  );
  notify(ctx, `${candidates.length} candidate(s):\n${lines.join("\n")}`);
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
      notify(ctx, "No pending promotion candidates.");
      return;
    }
    if (typeof ctx.ui?.select === "function") {
      const choices: SelectChoice[] = candidates.map((obs) => ({
        label: `[${obs.category}] ${obs.content}`,
        value: obs.id,
        description: `id=${obs.id} durable=true`,
      }));
      targetId = await ctx.ui.select({
        title: "Promote observation",
        message: "Select the observation to promote to Mnemopi.",
        choices,
      });
      if (!targetId) {
        notify(ctx, "Promotion cancelled.");
        return;
      }
    } else {
      notify(ctx, "Usage: /journey promote <observationId>", "warn");
      return;
    }
  }
  const target = state.observations.find((obs) => obs.id === targetId);
  if (!target) {
    notify(ctx, `Observation ${targetId} not found.`, "warn");
    return;
  }
  if (!target.durable) {
    notify(
      ctx,
      `Observation ${targetId} is not marked durable; run /journey mark-durable first.`,
      "warn",
    );
    return;
  }
  const already = state.promotions.get(targetId);
  if (already && already.status === "promoted") {
    notify(ctx, `Observation ${targetId} already promoted (memoryId=${already.memoryId ?? "?"}).`);
    return;
  }
  if (typeof ctx.ui?.confirm === "function") {
    const ok = await ctx.ui.confirm(
      "Promote to Mnemopi?",
      `[${target.category}] ${target.content}`,
    );
    if (!ok) {
      persistPromotion(pi, ctx, {
        observationId: target.id,
        status: "skipped",
        note: "user declined confirm",
        reviewedAt: new Date().toISOString(),
      });
      trace(pi, ctx, "promote.skipped", { id: target.id });
      refreshObservability(ctx, currentState(ctx));
      notify(ctx, `Promotion of ${target.id} declined.`);
      return;
    }
  }
  const memory = ctx.memory;
  if (typeof memory?.save !== "function") {
    persistPromotion(pi, ctx, {
      observationId: target.id,
      status: "failed",
      note: "memory backend unavailable",
      reviewedAt: new Date().toISOString(),
    });
    trace(pi, ctx, "promote.failed", { id: target.id, reason: "no-backend" });
    notify(ctx, "Memory backend unavailable; promotion recorded as failed.", "warn");
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
    notify(ctx, `Observation ${target.id} promoted${memoryId ? ` as ${memoryId}` : ""}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    persistPromotion(pi, ctx, {
      observationId: target.id,
      status: "failed",
      note: message.slice(0, 200),
      reviewedAt: new Date().toISOString(),
    });
    trace(pi, ctx, "promote.error", { id: target.id, message });
    notify(ctx, `Promotion of ${target.id} failed: ${message}`, "error");
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
    notify(ctx, "Usage: /journey forget <observationId>", "warn");
    return;
  }
  const target = state.observations.find((obs) => obs.id === observationId);
  if (!target) {
    notify(ctx, `Observation ${observationId} not found.`, "warn");
    return;
  }
  if (typeof ctx.ui?.confirm === "function") {
    const ok = await ctx.ui.confirm(
      "Forget observation?",
      `[${target.category}] ${target.content}`,
    );
    if (!ok) {
      notify(ctx, "Forget cancelled.");
      return;
    }
  }
  persistPromotion(pi, ctx, {
    observationId: target.id,
    status: "skipped",
    note: "manually forgotten",
    reviewedAt: new Date().toISOString(),
  });
  trace(pi, ctx, "forget", { id: target.id });
  refreshObservability(ctx, currentState(ctx));
  notify(ctx, `Observation ${target.id} marked forgotten (won't reappear as candidate).`);
}

async function handleTrace(ctx: ExtensionContextLike): Promise<void> {
  const runtime = runtimeFor(ctx);
  if (runtime.trace.length === 0) {
    notify(ctx, "Trace is empty.");
    return;
  }
  const lines = runtime.trace.map((entry) => {
    const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : "";
    return `[${entry.timestamp}] ${entry.event}${detail}`;
  });
  const body = lines.join("\n");
  if (ctx.ui?.editor) {
    await ctx.ui.editor({ title: "Journey trace", content: body, readOnly: true });
    return;
  }
  notify(ctx, `Trace (${runtime.trace.length} events):\n${body}`);
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
    await ctx.ui.editor({ title: "Journey dump", content: body, readOnly: true });
    return;
  }
  notify(ctx, `Dump (${body.length} bytes):\n${body}`);
}

const HELP_LINES: string[] = [
  "Observation Journal — /journey subcommands",
  "",
  "  /journey                              status snapshot",
  "  /journey on | off | toggle            gate control",
  "  /journey status                       print counts + gate state",
  "  /journey show                         open full JOURNEY.md",
  "  /journey add <cat> <content>          record an observation",
  "  /journey mark-durable <id>            mark as promotion candidate",
  "  /journey flush                        fold into segment + write JOURNEY.md",
  "  /journey export <path>                copy JOURNEY.md to <path>",
  "  /journey observe                      queue an observation request",
  "  /journey candidates                   list durable pending",
  "  /journey promote [<id>]               promote to Mnemopi (confirm required)",
  "  /journey forget <id>                  drop from candidates",
  "  /journey trace                        recent event trace",
  "  /journey dump                         full internal state",
  "  /journey help                         this reference",
  "",
  "Categories:",
  "  fact | decision | preference | failed-attempt |",
  "  deviation | constraint | open-question",
  "",
  "Defaults: OFF per session. Promotion is manual only.",
];

async function handleHelp(ctx: ExtensionContextLike): Promise<void> {
  const body = HELP_LINES.join("\n");
  if (ctx.ui?.editor) {
    await ctx.ui.editor({ title: "Journey help", content: body, readOnly: true });
    return;
  }
  notify(ctx, body);
}

async function handleCommand(
  pi: ExtensionAPILike,
  ctx: ExtensionContextLike,
  rawArgs: string,
): Promise<void> {
  const args = (rawArgs ?? "").trim();
  const [subcommandRaw, ...restTokens] = args.split(/\s+/);
  const subcommand = (subcommandRaw ?? "").toLowerCase();
  const rest = args.slice(subcommandRaw?.length ?? 0).trim();

  if (subcommand.length === 0 || subcommand === "status") {
    handleStatus(ctx);
    return;
  }
  if (subcommand === "on") return handleGate(pi, ctx, true);
  if (subcommand === "off") return handleGate(pi, ctx, false);
  if (subcommand === "toggle") {
    return handleGate(pi, ctx, !currentState(ctx).enabled);
  }
  if (subcommand === "show") return handleShow(ctx);
  if (subcommand === "add") return handleAdd(pi, ctx, restTokens[0], rest);
  if (subcommand === "mark-durable") {
    return handleMarkDurable(pi, ctx, restTokens[0]);
  }
  if (subcommand === "flush") return handleFlush(pi, ctx);
  if (subcommand === "export") return handleExport(ctx, rest);
  if (subcommand === "observe") return handleObserve(pi, ctx);
  if (subcommand === "candidates") return handleCandidates(ctx);
  if (subcommand === "promote") return handlePromote(pi, ctx, restTokens[0]);
  if (subcommand === "forget") return handleForget(pi, ctx, restTokens[0]);
  if (subcommand === "trace") return handleTrace(ctx);
  if (subcommand === "dump") return handleDump(ctx);
  if (subcommand === "help" || subcommand === "?") return handleHelp(ctx);
  notify(ctx, `Unknown /journey subcommand: ${subcommand}`, "warn");
}

export default function observationJournal(pi: ExtensionAPILike): void {
  pi.setLabel?.(LABEL);

  pi.on("session_start", (_event, ctx) => {
    const state = ensureState(ctx);
    trace(pi, ctx, "session_start", {
      sessionId: state.sessionId,
      branchLen: ctx.sessionManager?.getBranch?.().length ?? 0,
    });
    refreshObservability(ctx, state);
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
    stateStore.delete(sid);
    runtimeStore.delete(sid);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!currentState(ctx).enabled) return;
    ensureState(ctx);
    trace(pi, ctx, "turn_end", {});
    refreshObservability(ctx, currentState(ctx));
  });

  pi.on("session.compacting", (_event, ctx) => handleCompacting(pi, ctx));

  pi.on("session_compact", (_event, ctx) => {
    const state = currentState(ctx);
    if (!state.enabled) return;
    const summary = summariseRecent(state);
    persistSegment(pi, ctx, {
      ...summary,
      title: "Post-compaction snapshot",
    });
    trace(pi, ctx, "session_compact", { segmentId: summary.id });
    refreshObservability(ctx, currentState(ctx));
  });

  pi.registerCommand("journey", {
    description: "Branch-aware Observation Journal.",
    input: { hint: "[on|off|toggle|status|show|add|mark-durable|flush|export|observe|candidates|promote|forget|trace|dump|help]" },
    subcommands: [
      { name: "on", description: "Enable journal for this session" },
      { name: "off", description: "Disable journal for this session" },
      { name: "toggle", description: "Flip enabled state" },
      { name: "status", description: "Print current counts and gate state" },
      { name: "show", description: "Open the full JOURNEY.md in a read-only editor" },
      { name: "add", description: "Record an observation", usage: "<category> <content>" },
      { name: "mark-durable", description: "Mark an observation as promotion candidate", usage: "<observationId>" },
      { name: "flush", description: "Fold recent observations into a journey segment and write JOURNEY.md" },
      { name: "export", description: "Write JOURNEY.md to a user-supplied path", usage: "<path>" },
      { name: "observe", description: "Ask the main agent to propose observations next turn" },
      { name: "candidates", description: "List observations pending Mnemopi promotion" },
      { name: "promote", description: "Promote a durable observation to Mnemopi (requires confirm)", usage: "[<observationId>]" },
      { name: "forget", description: "Remove an observation from the candidate pool", usage: "<observationId>" },
      { name: "trace", description: "Show the recent event trace (in-memory)" },
      { name: "dump", description: "Show the full internal journal state" },
      { name: "help", description: "Print full subcommand reference" },
    ],
    handler: (args, ctx) => handleCommand(pi, ctx, args),
  });
}

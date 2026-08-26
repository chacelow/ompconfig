/**
 * In-process observer / consolidator dispatch via OMP native subagent.
 *
 * Replaces `spawn/launch.ts` + `spawn/runs.ts` (file-based IPC between master
 * and headless-omp subprocess). Instead of spawning an independent OMP process
 * and reading result/cost JSON files off disk, we call `pi.pi.runSubprocess`
 * to run a subagent in the SAME Node runtime:
 *
 *   * No .memory/.runs/ IPC files.
 *   * Observer returns observations via OMP's structured yield (SingleResult.structuredOutput.data.observations).
 *   * Cost comes back on SingleResult.cost directly.
 *   * Aborts propagate through AbortSignal (no SIGTERM/SIGKILL dance).
 *
 * Concurrency is safe by design: every dispatch has its own SingleResult;
 * there is no shared accumulator or shared runId → file mapping.
 *
 * Model routing:
 *   * `config.observerModel` accepts an OMP role alias (`@smol`) or full
 *     `provider/id` string. Empty ⇒ fallback to the master session's current
 *     model (ctx.getModel()).
 *   * Same for `config.consolidatorModel`.
 */

import {
  clearConsolidatorRoot,
  setConsolidatorRoot,
} from "./consolidator-tools.js";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ModelThinkingLevel } from "@oh-my-pi/pi-ai";
/**
 * What the observer model emits before the orchestrator re-derives precise
 * timestamp-ids. Kept as the ledger integration boundary — used by
 * assignObservationTimestamps in observer-trigger.
 */
export type RawObservation = {
  timestamp: string;
  content: string;
};
import { OBSERVER_SYSTEM } from "./prompts/observer.js";
import { CONSOLIDATOR_SYSTEM } from "./prompts/consolidator.js";

// ---------- Model resolution ----------

/** OMP's SingleResult model info shape (we only need provider + id). */
interface ActiveModelInfo {
  provider?: string;
  id?: string;
}

interface ModelSelection {
  modelRole?: string;
  modelOverride?: string;
}

/**
 * Resolve the (modelRole, modelOverride) pair for runSubprocess given a
 * pi-om config value and the master session's active model.
 *
 * Precedence:
 *   1. explicit config value ('@role' → modelRole; else → modelOverride)
 *   2. session fallback (ctx.getModel() → provider/id)
 *   3. defaultRole backstop (per worker: '@observations' / '@consolidator')
 *
 * The default role is expected to be defined in the user's modelRoles map.
 * OMP's role resolver will further fall back to whatever '@default' points
 * at if the target role is unmapped.
 */
export function resolveWorkerModel(
  configured: string | undefined,
  activeModel: ActiveModelInfo | undefined,
  defaultRole: string = "@observations",
): ModelSelection {
  const trimmed = configured?.trim();
  if (trimmed && trimmed.length > 0) {
    if (trimmed.startsWith("@")) return { modelRole: trimmed };
    return { modelOverride: trimmed };
  }
  const provider = activeModel?.provider?.trim();
  const id = activeModel?.id?.trim();
  if (provider && id) return { modelOverride: `${provider}/${id}` };
  return { modelRole: defaultRole };
}

// ---------- Output schema (JTD) ----------
//
// OMP's output frontmatter is JTD (RFC 8927): `{ properties }` = object,
// `{ elements }` = array, `{ type: "string" }` = primitive. NEVER use
// JSON-Schema `type: "object"` / `type: "array"` — the executor's
// jtd-to-json-schema converter interprets those wrong.
// Aligned with bundled scout.md.

const OBSERVER_OUTPUT_SCHEMA = {
  properties: {
    observations: {
      metadata: {
        description:
          "Batch of observations distilled from the chunk. Empty array is valid (chunk had no keepable content).",
      },
      elements: {
        properties: {
          timestamp: {
            metadata: {
              description:
                "Observation time in local YYYY-MM-DD HH:MM (from the source message).",
            },
            type: "string",
          },
          content: {
            metadata: {
              description:
                "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
            },
            type: "string",
          },
        },
      },
    },
  },
};

// Consolidator does not need a structured output — it edits files under
// .memory/ using the standard tools and yields a plain-text confirmation.
// (Absent schema ⇒ terminal yield uses last assistant text.)

// ---------- Subagent shared config ----------

type ThinkingLevel = ModelThinkingLevel | undefined;

interface RunSubprocessOptions {
  cwd: string;
  agent: {
    name: string;
    description: string;
    systemPrompt: string;
    tools: string[];
    spawns: string[];
    source: "user" | "bundled" | "project";
    thinkingLevel?: string;
    output?: unknown;
    readSummarize?: boolean;
  };
  task: string;
  index: number;
  id: string;
  detached: boolean;
  enableIrc: boolean;
  enableLsp: boolean;
  enableMCP: boolean;
  restrictToolNames: boolean;
  signal?: AbortSignal;
  onProgress: () => void;
  modelRole?: string;
  modelOverride?: string;
}
type RunSubprocessFn = (options: RunSubprocessOptions) => Promise<unknown>;

function pickRunSubprocess(pi: ExtensionAPI): RunSubprocessFn | undefined {
  const sdk = (pi as unknown as { pi?: Record<string, unknown> }).pi;
  const fn = sdk?.runSubprocess;
  return typeof fn === "function" ? (fn as RunSubprocessFn) : undefined;
}

function pickActiveModel(ctx: unknown): ActiveModelInfo | undefined {
  return (ctx as { getModel?: () => ActiveModelInfo | undefined }).getModel?.();
}

function pickCostUsd(result: unknown): number | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  // OMP SingleResult exposes cost at usage.cost.total (see
  // packages/coding-agent/src/task/render.ts:1264). Legacy r.cost / r.costUsd
  // retained as defence-in-depth.
  const usage = r.usage as { cost?: { total?: unknown } } | undefined;
  const nested = usage?.cost?.total;
  const cost = typeof nested === "number" ? nested : (r.cost ?? r.costUsd);
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) return cost;
  return undefined;
}

// ---------- Observer ----------

/**
 * Extract RawObservation[] from a SingleResult.
 *
 * OMP SingleResult.structuredOutput.data is the yielded payload (validated
 * against the JTD schema above). Legacy layouts (structuredOutput.observations,
 * raw output.observations) are tolerated for defence in depth.
 */
export function extractObserverObservations(result: unknown): RawObservation[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const structured = r.structuredOutput as Record<string, unknown> | undefined;
  const structuredData = structured?.data as Record<string, unknown> | undefined;
  const candidate =
    structuredData?.observations ??
    structured?.observations ??
    (r.output as Record<string, unknown> | undefined)?.observations ??
    r.observations;
  if (!Array.isArray(candidate)) return [];
  const out: RawObservation[] = [];
  for (const raw of candidate) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";
    const content = typeof obj.content === "string" ? obj.content.replace(/[\r\n]+/g, " ").trim() : "";
    if (timestamp.length === 0 || content.length === 0) continue;
    out.push({ timestamp, content });
  }
  return out;
}

export interface DispatchObserverOptions {
  pi: ExtensionAPI;
  ctx: unknown;
  cwd: string;
  runId: string;
  kickoffPrompt: string;
  observerModel: string | undefined;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
}

export interface DispatchObserverResult {
  observations: RawObservation[];
  costUsd?: number;
  modelHint?: string;
  error?: string;
  ranSubprocess: boolean;
}

/**
 * Dispatch an observer subagent in-process. Returns the extracted
 * observations and cost. Never throws — errors are surfaced via `error`.
 */
export async function dispatchObserverInProcess(
  opts: DispatchObserverOptions,
): Promise<DispatchObserverResult> {
  const runSubprocess = pickRunSubprocess(opts.pi);
  if (!runSubprocess) {
    return {
      observations: [],
      ranSubprocess: false,
      error: "SDK 未暴露 runSubprocess（OMP 版本过旧）",
    };
  }
  const selection = resolveWorkerModel(
    opts.observerModel,
    pickActiveModel(opts.ctx),
    "@observations",
  );
  const modelHint = selection.modelOverride ?? selection.modelRole;
  try {
    const result = await runSubprocess({
      cwd: opts.cwd,
      agent: {
        name: "om-observer",
        description:
          "pi-om observer: compress one conversation chunk into structured observations",
        systemPrompt: OBSERVER_SYSTEM,
        tools: [],
        spawns: [],
        source: "user",
        thinkingLevel: opts.thinkingLevel,
        output: OBSERVER_OUTPUT_SCHEMA,
        readSummarize: false,
      },
      task: opts.kickoffPrompt,
      index: 0,
      id: opts.runId,
      detached: true,
      enableIrc: false,
      enableLsp: false,
      enableMCP: false,
      restrictToolNames: true,
      signal: opts.signal,
      onProgress: () => {},
      modelRole: selection.modelRole,
      modelOverride: selection.modelOverride,
    });
    return {
      observations: extractObserverObservations(result),
      costUsd: pickCostUsd(result),
      modelHint,
      ranSubprocess: true,
    };
  } catch (e) {
    return {
      observations: [],
      ranSubprocess: true,
      error: e instanceof Error ? e.message : String(e),
      modelHint,
    };
  }
}

// ---------- Consolidator ----------

export interface DispatchConsolidatorOptions {
  pi: ExtensionAPI;
  ctx: unknown;
  cwd: string;
  runId: string;
  kickoffPrompt: string;
  consolidatorModel: string | undefined;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
}

export interface DispatchConsolidatorResult {
  costUsd?: number;
  modelHint?: string;
  error?: string;
  ranSubprocess: boolean;
}

/**
 * Dispatch a consolidator subagent in-process. Uses the extension-registered
 * om_read / om_write / om_edit / om_ls / om_grep tools, sandboxed to
 * `opts.memoryRoot`. Sandboxing is enforced via the module-level active-root
 * set here and read by the tools' execute callbacks — race-free because
 * consolidator concurrency is 1 (Runtime.consolidatorInFlight).
 *
 * Returns cost; the consolidator's output is its file edits, not structured
 * data. A plain-text confirmation ends the run.
 */
export async function dispatchConsolidatorInProcess(
  opts: DispatchConsolidatorOptions & { memoryRoot: string },
): Promise<DispatchConsolidatorResult> {
  const runSubprocess = pickRunSubprocess(opts.pi);
  if (!runSubprocess) {
    return {
      ranSubprocess: false,
      error: "SDK 未暴露 runSubprocess（OMP 版本过旧）",
    };
  }
  const selection = resolveWorkerModel(
    opts.consolidatorModel,
    pickActiveModel(opts.ctx),
    "@consolidator",
  );
  const modelHint = selection.modelOverride ?? selection.modelRole;
  setConsolidatorRoot(opts.memoryRoot);
  try {
    const result = await runSubprocess({
      cwd: opts.cwd,
      agent: {
        name: "om-consolidator",
        description:
          "pi-om consolidator: fold observations into durable .memory/ topic files",
        systemPrompt: CONSOLIDATOR_SYSTEM,
        tools: ["om_read", "om_write", "om_edit", "om_ls", "om_grep"],
        spawns: [],
        source: "user",
        thinkingLevel: opts.thinkingLevel,
        readSummarize: false,
      },
      task: opts.kickoffPrompt,
      index: 0,
      id: opts.runId,
      detached: true,
      enableIrc: false,
      enableLsp: false,
      enableMCP: false,
      restrictToolNames: true,
      signal: opts.signal,
      onProgress: () => {},
      modelRole: selection.modelRole,
      modelOverride: selection.modelOverride,
    });
    return {
      costUsd: pickCostUsd(result),
      modelHint,
      ranSubprocess: true,
    };
  } catch (e) {
    return {
      ranSubprocess: true,
      error: e instanceof Error ? e.message : String(e),
      modelHint,
    };
  } finally {
    clearConsolidatorRoot();
  }
}

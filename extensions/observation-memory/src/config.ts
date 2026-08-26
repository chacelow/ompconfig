import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@oh-my-pi/pi-ai";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

export interface Config {
	/** Raw-history token size of one observation chunk (fixed boundary). */
	chunkTokens: number;
	/** Overlap between adjacent chunks; default 0 in v1. */
	chunkOverlapTokens: number;
	/** Target size of the active observation pool; the buffer drains back toward this after consolidation. */
	poolTargetTokens: number;
	/** Active-pool token count that triggers a consolidation (200% of target). */
	consolidateAtPoolTokens: number;
	/** Live context-window usage that triggers compaction. */
	compactAtContextTokens: number;
	/** Verbatim raw tail kept after the cutoff; snaps to a chunk boundary. */
	tailTokens: number;
	/**
	 * Target size of `.memory/JOURNEY.md`, the running descriptive project history the
	 * consolidator appends to and pushes into every compaction block. When the file grows past
	 * this, the consolidator compresses its oldest entries (recent history stays detailed).
	 */
	journeyTargetTokens: number;
	/** Max simultaneous in-flight observer subprocesses. */
	observerConcurrency: number;
  /**
   * Observer worker model:
   *   * `@role` (e.g. `@smol`, `@advisor`) — resolved via OMP modelRoles
   *   * `provider/id` — full model pattern
   *   * unset → fallback to the master session's active model
   */
  observerModel?: string;
  /** Consolidator worker model (same shape as `observerModel`). */
  consolidatorModel?: string;
	/**
	 * Legacy subprocess-model config. Kept only so existing settings files
	 * that still specify `models.observer` do not crash the loader. The
	 * in-process dispatcher ignores this — use `observerModel` /
	 * `consolidatorModel` instead.
	 */
	models?: {
		observer?: ConfiguredModel;
		consolidator?: ConfiguredModel;
	};
	resumeAfterMidRunCompaction: boolean;
	/** Power-user setting: disable all triggers (distinct from the on/off gate). */
	passive: boolean;
	/**
	 * When true, new sessions auto-enable the gate on session_start (unless
	 * the branch already carries an OM_ENABLED entry from an earlier explicit
	 * /om on|off in that session). Persisted via OMP settings.set at
	 * ~/.omp/agent/settings.json → observational-memory.defaultEnabled.
	 */
	defaultEnabled: boolean;
	/** Emit the NDJSON debug log. */
	debugLog: boolean;
}

export const DEFAULTS: Config = {
	chunkTokens: 10_000,
	chunkOverlapTokens: 0,
	poolTargetTokens: 10_000,
	consolidateAtPoolTokens: 15_000,
	compactAtContextTokens: 150_000,
	tailTokens: 20_000,
	journeyTargetTokens: 1_000,
	observerConcurrency: 4,
	resumeAfterMidRunCompaction: true,
  observerModel: undefined,
  consolidatorModel: undefined,
	passive: false,
	defaultEnabled: false,
	debugLog: false,
};

const THINKING_LEVEL_VALUES: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OM_PASSIVE";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeModel(value: unknown, fallback: ConfiguredModel): ConfiguredModel {
	if (!isRecord(value)) return fallback;
	const provider = nonEmptyString(value.provider) ?? fallback.provider;
	const id = nonEmptyString(value.id) ?? fallback.id;
	const model: ConfiguredModel = { provider, id };
	const thinking = isThinkingLevel(value.thinking) ? value.thinking : fallback.thinking;
	if (thinking) model.thinking = thinking;
	return model;
}

function normalizeSettingsConfig(value: Record<string, unknown>, base: Config): Partial<Config> {
	const normalized: Partial<Config> = {};
	const numberKeys = [
		"chunkTokens",
		"chunkOverlapTokens",
		"poolTargetTokens",
		"consolidateAtPoolTokens",
		"compactAtContextTokens",
		"tailTokens",
		"journeyTargetTokens",
		"observerConcurrency",
	] as const;
	for (const key of numberKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	// chunkOverlapTokens may legitimately be 0.
	if (value.chunkOverlapTokens === 0) normalized.chunkOverlapTokens = 0;
	if (typeof value.resumeAfterMidRunCompaction === "boolean")
		normalized.resumeAfterMidRunCompaction = value.resumeAfterMidRunCompaction;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.defaultEnabled === "boolean") normalized.defaultEnabled = value.defaultEnabled;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
  const observerModel =
    typeof value.observerModel === "string" && value.observerModel.trim().length > 0
      ? value.observerModel.trim()
      : undefined;
  const consolidatorModel =
    typeof value.consolidatorModel === "string" && value.consolidatorModel.trim().length > 0
      ? value.consolidatorModel.trim()
      : undefined;
  if (observerModel !== undefined) normalized.observerModel = observerModel;
  if (consolidatorModel !== undefined) normalized.consolidatorModel = consolidatorModel;
	return normalized;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

function readNamespacedConfig(path: string, base: Config): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		return isRecord(nested) ? normalizeSettingsConfig(nested, base) : {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	const globalConfig = readNamespacedConfig(globalPath, DEFAULTS);
	const projectConfig = readNamespacedConfig(projectPath, DEFAULTS);
	const envConfig = readEnvConfig(env);
	return {
		...DEFAULTS,
		...globalConfig,
		...projectConfig,
		...envConfig,
	};
}

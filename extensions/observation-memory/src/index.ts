/**
 * Observational memory — ORCHESTRATOR (master-side, in-process).
 *
 * The conductor: owns the clocks/triggers, spawns subprocess workers, commits their output to
 * the ledger (observations) or files (long-term, Phase B), renders compaction, and drives the
 * TUI. Event-driven only — no daemon.
 *
 * Ships in the global extensions folder during development, so it is gated OFF by default per
 * session (A2a). When the gate is off, every handler returns at its first line and the
 * extension is completely invisible.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidatorTrigger } from "./hooks/consolidator-trigger.js";
import { registerObserverTrigger } from "./hooks/observer-trigger.js";
import { OM_ENABLED, type Entry } from "./ledger/index.js";
import { handleStatus } from "./commands/status.js";
import { handleCompact } from "./commands/compact.js";
import { handleConsolidate } from "./commands/consolidate.js";
import { ensureSessionMemory } from "./memory/session.js";
import { Runtime } from "./runtime.js";
import { registerConsolidatorTools } from "./consolidator-tools.js";

function readGateFromLedger(branch: Entry[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === OM_ENABLED) {
			return (entry.data as { enabled?: boolean } | undefined)?.enabled ?? false;
		}
	}
	return false;
}

/**
 * Runtime-inject pi-om's worker roles into OMP's global settings singleton.
 *
 * Uses `settings.overrideModelRoles` — a memory-only override that does NOT
 * write to config.yml. Effect:
 *   * `/model` UI lists OBSERVATIONS and CONSOLIDATOR alongside the built-ins.
 *   * `expandRoleAlias('@observations', settings)` now resolves.
 *   * The user can re-map either role in the model browser; that write hits
 *     the persist layer only when the user explicitly changes it.
 *
 * Defaults chain to the user's already-assigned built-in roles:
 *   observations → @smol   (fast + cheap)
 *   consolidator → @advisor (mid-tier reasoning)
 *
 * Skipped when the user already assigned observations / consolidator
 * explicitly (via config.yml or a prior /model reassignment persisted to
 * disk) so we never clobber user intent.
 */
function seedDefaultRoles(pi: ExtensionAPI): void {
	const globalSettings = (pi as unknown as {
		pi?: {
			settings?: {
				getModelRoles?: () => Record<string, string>;
				overrideModelRoles?: (roles: Record<string, string>) => void;
			};
		};
	}).pi?.settings;
	if (!globalSettings?.overrideModelRoles || !globalSettings.getModelRoles) return;
	const current = globalSettings.getModelRoles();
	const patch: Record<string, string> = {};
	if (!current.observations) patch.observations = "@smol";
	if (!current.consolidator) patch.consolidator = "@advisor";
	if (Object.keys(patch).length === 0) return;
	try {
		globalSettings.overrideModelRoles(patch);
	} catch {
		// Best-effort: if the SDK surface changed, fall back silently to the
		// dispatcher's activeModel path.
	}
}

export default function observationalMemory(pi: ExtensionAPI): void {
	// Global sandboxed file tools for the consolidator subagent (om_read /
	// om_write / om_edit / om_ls / om_grep). Root is set per-dispatch by the
	// dispatcher; registered here once at extension init.
	registerConsolidatorTools(pi);
	// Runtime-inject OBSERVATIONS + CONSOLIDATOR into OMP's model role map so
	// the /model UI lists them and role aliases resolve. Memory-only, no
	// config.yml write. See seedDefaultRoles doc.
	seedDefaultRoles(pi);
	const runtime = new Runtime();

	function attachIfEnabled(ctx: any): void {
		if (runtime.enabled && ctx.mode === "tui" && ctx.hasUI && ctx.ui) {
			runtime.status.attach(ctx.ui);
		} else {
			runtime.status.detach();
		}
	}

	pi.on("session_start", (_event: unknown, ctx: any) => {
		runtime.ensureConfig(ctx.cwd);
		runtime.dispatchedCoversUpToId = undefined;
		const branch = ctx.sessionManager.getBranch() as Entry[];
		const hasGate = branch.some((e) => e.type === "custom" && (e as any).customType === OM_ENABLED);
		runtime.enabled = readGateFromLedger(branch);
		// defaultEnabled 持久化偏好：新会话若没显式 gate entry 且用户设了默认开，
		// 就自动 append 一条 OM_ENABLED(true)。用户在会话里 /om off 后 branch 有 gate entry
		// → 尊重用户显式关，不覆盖。
		if (!hasGate && runtime.config.defaultEnabled && !runtime.enabled) {
			runtime.enabled = true;
			pi.appendEntry(OM_ENABLED, { enabled: true });
		}
		if (runtime.enabled) runtime.memoryRoot = ensureSessionMemory(ctx);
		attachIfEnabled(ctx);
		runtime.refreshFooterGauges(branch, ctx.getContextUsage?.()?.tokens ?? null);
		runtime.refreshCost(ctx.sessionManager.getEntries() as Entry[]);
	});

	pi.on("session_shutdown", () => {
		runtime.status.detach();
		runtime.abortAllWorkers();
	});

	// Toggle gate helper (sub-shared with /om on|off|toggle).
	async function setGate(ctx: any, next: boolean): Promise<void> {
		if (next === runtime.enabled) {
			if (ctx.hasUI) ctx.ui.notify(`观察记忆已${next ? "启用" : "关闭"}`, "info");
			return;
		}
		runtime.enabled = next;
		pi.appendEntry(OM_ENABLED, { enabled: next });
		if (next) {
			runtime.memoryRoot = ensureSessionMemory(ctx);
			attachIfEnabled(ctx);
			runtime.refreshFooterGauges(ctx.sessionManager.getBranch() as Entry[], ctx.getContextUsage?.()?.tokens ?? null);
			runtime.refreshCost(ctx.sessionManager.getEntries() as Entry[]);
		} else {
			runtime.abortAllWorkers();
			runtime.status.detach();
		}
		if (ctx.hasUI) ctx.ui.notify(next ? "观察记忆已启用" : "观察记忆已关闭", "info");
	}

	/**
	 * 持久化 defaultEnabled 到 ~/.omp/agent/settings.json。写入通过 OMP
	 * settings.set —— 走 queueSave 落盘，用户不用手动碰配置文件。类型系统
	 * 里没有这个 key，as any 绕过；运行时 setByPath 接受任意 path。
	 */
	async function persistDefaultEnabled(ctx: any, next: boolean): Promise<void> {
		runtime.config.defaultEnabled = next;
		const globalSettings = (pi as unknown as {
			pi?: { settings?: { set?: (path: string, value: unknown) => void } };
		}).pi?.settings;
		try {
			globalSettings?.set?.("observational-memory.defaultEnabled", next);
		} catch {
			// Best-effort: if the SDK surface changed, at least in-memory reflects it
			// until next session.
		}
		if (ctx.hasUI) {
			ctx.ui.notify(
				next
					? "已持久化：以后所有新会话自动启用观察记忆（/om off 可临时关本会话）"
					: "已持久化：新会话默认关闭观察记忆",
				"info",
			);
		}
	}

	const OM_SUBCOMMANDS = [
		{ label: "on", value: "on", description: "启用当前会话的观察记忆" },
		{ label: "off", value: "off", description: "关闭当前会话的观察记忆" },
		{ label: "toggle", value: "toggle", description: "翻转启用状态" },
		{ label: "status", value: "status", description: "查看在飞 worker / 缓冲池 / 时钟 / 成本" },
		{ label: "compact", value: "compact", description: "立即触发一次压缩（忽略阈值）" },
		{ label: "consolidate", value: "consolidate", description: "立即触发一次整合（忽略缓冲池阈值）" },
		{ label: "default", value: "default ", description: "设置新会话默认启用状态：/om default on|off" },
		{ label: "help", value: "help", description: "打印全部子命令说明" },
	];

	const OM_DEFAULT_SUBCOMMANDS = [
		{ label: "on", value: "on", description: "新会话自动启用（持久化到 settings.json）" },
		{ label: "off", value: "off", description: "新会话默认关闭（持久化到 settings.json）" },
	];

	const HELP_LINES = [
		"观察记忆（pi-om）· /om 子命令",
		"",
		"  /om on | off | toggle    启用 / 关闭 / 翻转",
		"  /om status               查看状态（默认无 arg 也是 status）",
		"  /om compact              立即压缩，忽略阈值",
		"  /om consolidate          立即整合，忽略缓冲池阈值",
		"  /om default on|off       设置新会话默认启用状态（持久化）",
		"  /om help                 本帮助",
		"",
		"角色分配：/model → OBSERVATIONS / CONSOLIDATOR",
		"  observations 默认走 @smol，consolidator 默认走 @advisor。",
		"  想换模型直接在 /model UI 里改。",
	];

	pi.registerCommand("om", {
		description: "观察记忆（pi-om）：后台抽取对话观察 → 折叠成长期记忆",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trimStart();
			// 二级：`/om default ` 之后按 TAB 出 on/off
			if (trimmed.startsWith("default ") || trimmed === "default") {
				const sub = trimmed === "default" ? "" : trimmed.slice("default ".length);
				return OM_DEFAULT_SUBCOMMANDS.filter((s) => s.label.startsWith(sub.toLowerCase())).map((s) => ({
					label: `default ${s.label}`,
					value: `default ${s.value}`,
					description: s.description,
				}));
			}
			return OM_SUBCOMMANDS.filter((s) => s.label.startsWith(trimmed.toLowerCase()));
		},
		handler: async (args: string, ctx: any) => {
			const sub = (args ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
			switch (sub) {
				case "":
				case "status":
					return handleStatus(pi, runtime, ctx);
				case "on":
					return setGate(ctx, true);
				case "off":
					return setGate(ctx, false);
				case "toggle":
					return setGate(ctx, !runtime.enabled);
				case "compact":
					return handleCompact(pi, runtime, ctx);
				case "consolidate":
					return handleConsolidate(pi, runtime, ctx);
				case "default": {
					const arg = (args ?? "").trim().toLowerCase().split(/\s+/).slice(1).join(" ");
					if (arg === "on") return persistDefaultEnabled(ctx, true);
					if (arg === "off") return persistDefaultEnabled(ctx, false);
					if (ctx.hasUI) {
						ctx.ui.notify(
							`用法：/om default on|off  ·  当前：${runtime.config.defaultEnabled ? "on" : "off"}`,
							"info",
						);
					}
					return;
				}
				case "help":
				case "?":
					if (ctx.hasUI) ctx.ui.notify(HELP_LINES.join("\n"), "info");
					return;
				default:
					if (ctx.hasUI) {
						ctx.ui.notify(`未知子命令：${sub}。运行 /om help 查看列表。`, "warning");
					}
			}
		},
	});

	// Triggers + hook self-gate on runtime.enabled / passive at their first line.
	registerObserverTrigger(pi, runtime);
	registerConsolidatorTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

}

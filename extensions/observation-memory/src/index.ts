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
		runtime.enabled = readGateFromLedger(branch);
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

	const OM_SUBCOMMANDS = [
		{ label: "on", value: "on", description: "启用当前会话的观察记忆" },
		{ label: "off", value: "off", description: "关闭当前会话的观察记忆" },
		{ label: "toggle", value: "toggle", description: "翻转启用状态" },
		{ label: "status", value: "status", description: "查看在飞 worker / 缓冲池 / 时钟 / 成本" },
		{ label: "compact", value: "compact", description: "立即触发一次压缩（忽略阈值）" },
		{ label: "consolidate", value: "consolidate", description: "立即触发一次整合（忽略缓冲池阈值）" },
		{ label: "help", value: "help", description: "打印全部子命令说明" },
	];

	const HELP_LINES = [
		"观察记忆（pi-om）· /om 子命令",
		"",
		"  /om on | off | toggle    启用 / 关闭 / 翻转",
		"  /om status               查看状态（默认无 arg 也是 status）",
		"  /om compact              立即压缩，忽略阈值",
		"  /om consolidate          立即整合，忽略缓冲池阈值",
		"  /om help                 本帮助",
		"",
		"角色分配：/model → OBSERVATIONS / CONSOLIDATOR",
		"  observations 默认走 @smol，consolidator 默认走 @advisor。",
		"  想换模型直接在 /model UI 里改。",
	];

	pi.registerCommand("om", {
		description: "观察记忆（pi-om）：后台抽取对话观察 → 折叠成长期记忆",
		getArgumentCompletions: (prefix: string) =>
			OM_SUBCOMMANDS.filter((s) => s.label.startsWith(prefix.toLowerCase())),
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

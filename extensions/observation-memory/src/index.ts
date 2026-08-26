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
import { registerCompactCommand } from "./commands/compact.js";
import { registerConsolidateCommand } from "./commands/consolidate.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidatorTrigger } from "./hooks/consolidator-trigger.js";
import { registerObserverTrigger } from "./hooks/observer-trigger.js";
import { OM_ENABLED, type Entry } from "./ledger/index.js";
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

	pi.registerCommand("om", {
		description: "Toggle observational memory for this session (/om on, /om off)",
		handler: async (args: string, ctx: any) => {
			const arg = (args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !runtime.enabled;
			if (next === runtime.enabled) {
				if (ctx.hasUI) ctx.ui.notify(`om already ${next ? "on" : "off"}`, "info");
				return;
			}
			runtime.enabled = next;
			pi.appendEntry(OM_ENABLED, { enabled: next });
			if (next) {
				runtime.memoryRoot = ensureSessionMemory(ctx);
				attachIfEnabled(ctx);
				runtime.refreshFooterGauges(ctx.sessionManager.getBranch() as Entry[], ctx.getContextUsage?.()?.tokens ?? null);
				runtime.refreshCost(ctx.sessionManager.getEntries() as Entry[]);
				// (default roles are seeded once at extension init, no per-toggle nudge)
			} else {
				runtime.abortAllWorkers();
				runtime.status.detach();
			}
			if (ctx.hasUI) ctx.ui.notify(`om ${next ? "enabled" : "disabled"}`, "info");
		},
	});

	// Triggers + hook self-gate on runtime.enabled / passive at their first line.
	registerObserverTrigger(pi, runtime);
	registerConsolidatorTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerCompactCommand(pi, runtime);
	registerConsolidateCommand(pi, runtime);
}

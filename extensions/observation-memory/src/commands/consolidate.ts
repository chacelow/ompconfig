import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { foldLedger, poolTokens, selectPromotionOverflow, type Entry } from "../ledger/index.js";
import type { Runtime } from "../runtime.js";
import { evaluateConsolidatorTrigger } from "../hooks/consolidator-trigger.js";

/**
 * Force a consolidation now, ignoring the pool threshold. Promotes the oldest observations
 * above `poolTargetTokens`; no-op when there is nothing above target or one is already running.
 */
export async function handleConsolidate(pi: ExtensionAPI, runtime: Runtime, ctx: any): Promise<void> {
	if (!runtime.enabled) {
		if (ctx.hasUI) ctx.ui.notify("观察记忆当前关闭（运行 /om on 启用）", "info");
		return;
	}
	if (runtime.consolidatorInFlight) {
		if (ctx.hasUI) ctx.ui.notify("已有整合正在进行中", "warning");
		return;
	}
	runtime.ensureConfig(ctx.cwd);
	const branch = ctx.sessionManager.getBranch() as Entry[];
	const active = foldLedger(branch).activeObservations;
	const { promote } = selectPromotionOverflow(active, runtime.config.poolTargetTokens);
	if (promote.length === 0) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`暂无可整合内容（缓冲池 ${poolTokens(active).toLocaleString()} tok ≤ 目标 ${runtime.config.poolTargetTokens.toLocaleString()} tok）`,
				"info",
			);
		}
		return;
	}
	// Temporarily lower the threshold to 0 for this evaluation so the trigger fires
	// regardless of the configured pool threshold.
	const saved = runtime.config.consolidateAtPoolTokens;
	runtime.config.consolidateAtPoolTokens = 0;
	try {
		evaluateConsolidatorTrigger(pi, runtime, ctx);
	} finally {
		runtime.config.consolidateAtPoolTokens = saved;
	}
}

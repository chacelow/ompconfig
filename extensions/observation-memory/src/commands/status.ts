import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { foldLedger, poolTokens, rawTokensSinceObservationCoverage, sumSessionCost, type Entry } from "../ledger/index.js";
import { listTopics, readJourney } from "../memory/paths.js";
import { estimateStringTokens } from "../tokens.js";
import type { Runtime } from "../runtime.js";
import { renderTimeline } from "../ui/timeline.js";

export async function handleStatus(_pi: ExtensionAPI, runtime: Runtime, ctx: any): Promise<void> {
	if (!ctx.hasUI) return;
	if (!runtime.enabled) {
		ctx.ui.notify("观察记忆当前关闭（运行 /om on 启用）", "info");
		return;
	}
	runtime.ensureConfig(ctx.cwd);
	const branch = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(branch);
	const sinceObservation = rawTokensSinceObservationCoverage(branch);
	const contextTokens = ctx.getContextUsage?.()?.tokens ?? null;
	const pool = poolTokens(folded.activeObservations);
	const topicCount = listTopics(runtime.memoryRoot).length;
	const journey = readJourney(runtime.memoryRoot);
	const { costUsd, runs } = sumSessionCost(ctx.sessionManager.getEntries() as Entry[]);

	const lines = [
		`观察记忆状态`,
		`  在飞 observer：${runtime.observersInFlight.size} / ${runtime.config.observerConcurrency}`,
		`  活跃观察：${folded.activeObservations.length} 条`,
		`  距下次 observer：${sinceObservation.toLocaleString()} / ${runtime.config.chunkTokens.toLocaleString()} tok`,
		`  缓冲池：${pool.toLocaleString()} tok（目标 ${runtime.config.poolTargetTokens.toLocaleString()}、整合阈 ${runtime.config.consolidateAtPoolTokens.toLocaleString()}）`,
		`  整合器：${runtime.consolidatorInFlight ? "运行中" : "空闲"}`,
		`  上次压缩等待：${runtime.lastCompactionObserverWait ?? "无"}`,
		`  主题文件：${topicCount} 个`,
		`  Journey：${journey ? `约 ${estimateStringTokens(journey).toLocaleString()} / ${runtime.config.journeyTargetTokens.toLocaleString()} tok` : "尚未生成"}`,
		`  上下文：${contextTokens != null ? contextTokens.toLocaleString() : "?"} / ${runtime.config.compactAtContextTokens.toLocaleString()} tok`,
		`  本会话成本：$${costUsd.toFixed(4)}（${runs} 次运行）`,
		runtime.lastWorkerError ? `  最近错误：${runtime.lastWorkerError}` : `  最近错误：无`,
		"",
		renderTimeline(branch, runtime.config),
	];
	ctx.ui.notify(lines.join("\n"), "info");
}

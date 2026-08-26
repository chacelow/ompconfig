import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Runtime } from "../runtime.js";

export async function handleCompact(_pi: ExtensionAPI, runtime: Runtime, ctx: any): Promise<void> {
	if (!runtime.enabled) {
		if (ctx.hasUI) ctx.ui.notify("观察记忆当前关闭（运行 /om on 启用）", "info");
		return;
	}
	if (runtime.compactInFlight) {
		if (ctx.hasUI) ctx.ui.notify("已有压缩正在进行中", "warning");
		return;
	}
	runtime.compactInFlight = true;
	// The before-compact hook waits for in-flight observers before folding (design R5),
	// so we trigger compaction straight away here too.
	if (ctx.hasUI) ctx.ui.notify("正在压缩（等待在飞的 observer 完成）…", "info");
	ctx.compact({
		onComplete: () => {
			runtime.compactInFlight = false;
			if (ctx.hasUI) ctx.ui.notify("压缩完成", "info");
		},
		onError: (error: { message: string }) => {
			runtime.compactInFlight = false;
			if (error.message === "Compaction cancelled") return;
			if (ctx.hasUI) ctx.ui.notify(`压缩失败：${error.message}`, "error");
		},
	});
}

export function registerCompactCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:compact", {
		description: "立即触发观察记忆压缩（忽略阈值）",
		handler: async (_args: string, ctx: any) => await handleCompact(pi, runtime, ctx),
	});
}

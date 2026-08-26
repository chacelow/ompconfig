/**
 * Phase B consolidator clock. When the active observation pool crosses
 * `consolidateAtPoolTokens`, promote the oldest observations (above `poolTargetTokens`) into
 * durable `.memory/` topic files via a subprocess consolidator, then tombstone exactly the
 * timestamps it reports back.
 *
 * Runs in the BACKGROUND, mirroring the observer trigger (turn_end / agent_start), strictly
 * one at a time (design risk 4). Compaction does not wait for it (R5).
 *
 * Tombstone safety (design risk 4): the orchestrator tombstones the batch it handed the
 * consolidator, intersected with what is STILL active at exit — never an observation an
 * observer committed during the run (those are not in the handed batch). The consolidator does
 * not report back: it must consolidate everything it was given (filing or discarding junk is a
 * valid outcome), so on clean exit we trust it and drop the whole batch. This guarantees the
 * buffer always drains; a flaked-out partial run is recoverable from the worker's global session
 * recording (the standing safety net for lossy rewrites) and is the critic tier's job to catch.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	OM_OBSERVATIONS_DROPPED,
	foldLedger,
	lastSourceEntryId,
	observationToLine,
	poolTokens,
	selectPromotionOverflow,
	sortObservations,
	type Entry,
	type Observation,
} from "../ledger/index.js";
import { nowTimestamp } from "../ledger/serialize.js";
import { renderIndexFile } from "../memory/index-render.js";
import { atomicWrite, indexPath, listTopics, readJourney } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import { dispatchConsolidatorInProcess } from "../dispatcher.js";
import { recordWorkerCost } from "./observer-trigger.js";

type TriggerCtx = {
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: { getBranch: () => Entry[]; getEntries: () => Entry[] };
	getContextUsage?: () => { tokens: number | null } | undefined;
	cwd?: string;
	getModel?: () => { provider?: string; id?: string } | undefined;
};

let runCounter = 0;

function nextRunId(): string {
	runCounter += 1;
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `cons-${stamp}-${process.pid}-${runCounter}`;
}

/**
 * Build the consolidator's `-p` prompt: current time + current index + current journey + the
 * overflow lines. The journey is included verbatim so the consolidator updates it in place
 * (append a segment for this batch; compress the old tail only if over `journeyTargetTokens`).
 */
function buildConsolidatorPrompt(memoryRoot: string, promote: Observation[], journeyTargetTokens: number): string {
	const indexText = renderIndexFile(listTopics(memoryRoot));
	const journeyText = readJourney(memoryRoot);
	const journeyWords = Math.round((journeyTargetTokens * 3) / 4);
	const obsLines = sortObservations(promote).map(observationToLine).join("\n");
	return (
		`Current local time: ${nowTimestamp()}\n\n` +
		"You are folding the observations below into the durable topic files under .memory/. " +
		"Use this exact time string in the `updated` front-matter of any file you write, and in any new JOURNEY.md entry.\n\n" +
		"===== CURRENT MEMORY INDEX (generated; do not edit INDEX.md) =====\n" +
		`${indexText}\n` +
		"===== END MEMORY INDEX =====\n\n" +
		"===== CURRENT JOURNEY (.memory/JOURNEY.md — the running descriptive project history) =====\n" +
		`${journeyText ?? "(empty — no journey yet; start one)"}\n` +
		"===== END JOURNEY =====\n\n" +
		"===== OBSERVATIONS TO CONSOLIDATE (each line is `<timestamp-id>  <content>`) =====\n" +
		`${obsLines}\n` +
		"===== END OBSERVATIONS =====\n\n" +
		"Fold every observation above into topic files (create/merge/rewrite as needed). Then update " +
		`.memory/JOURNEY.md per your instructions — keep it under ~${journeyTargetTokens} tokens (~${journeyWords} words), ` +
		"purely descriptive, no advice or next steps. Finish with a one-sentence confirmation."
	);
}

export function evaluateConsolidatorTrigger(pi: ExtensionAPI, runtime: Runtime, ctx: TriggerCtx): void {
	if (!runtime.enabled || runtime.config.passive) return;
	if (runtime.consolidatorInFlight) return;

	const branch = ctx.sessionManager.getBranch();
	const active = foldLedger(branch).activeObservations;
	if (poolTokens(active) < runtime.config.consolidateAtPoolTokens) return;

	const { promote } = selectPromotionOverflow(active, runtime.config.poolTargetTokens);
	if (promote.length === 0) return;

	runtime.consolidatorInFlight = true;
	if (ctx.hasUI) {
		ctx.ui?.notify(`om: consolidator started (${promote.length} obs, ~${poolTokens(promote).toLocaleString()} tok)`, "info");
	}
	// Deliberately NOT tracked in observerTasks: compaction waits only for in-flight observers,
	// never the consolidator (design R5). The consolidatorInFlight flag enforces one-at-a-time.
	void dispatchConsolidator(pi, runtime, ctx, promote);
}

async function dispatchConsolidator(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	promote: Observation[],
): Promise<void> {
	const runId = nextRunId();
	const controller = new AbortController();
	runtime.consolidatorController = controller;
	runtime.status.workerStart("consolidator", runId);

	try {
		// Backend routing: if the user has Mnemopi wired in, promote directly
		// into it instead of running the .md consolidator subagent. Same batch
		// tombstoning either way. Avoids double-indexing the same content across
		// two long-term stores.
		if (await tryPromoteViaMemoryBackend(pi, runtime, ctx, promote, runId)) {
			return;
		}
		const prompt = buildConsolidatorPrompt(
			runtime.memoryRoot,
			promote,
			runtime.config.journeyTargetTokens,
		);
		const result = await dispatchConsolidatorInProcess({
			pi,
			ctx,
			cwd: runtime.memoryRoot,
			memoryRoot: runtime.memoryRoot,
			runId,
			kickoffPrompt: prompt,
			consolidatorModel: runtime.config.consolidatorModel,
			signal: controller.signal,
		});
		// Cost captured even on failure so partial spend still records.
		recordWorkerCost(pi, runtime, ctx, "consolidator", runId, result.costUsd);
		if (result.error) {
			throw new Error(result.error);
		}
		if (!result.ranSubprocess) {
			throw new Error("runSubprocess unavailable");
		}

		// Trust the consolidator: on clean exit it has folded (or discarded) everything we handed it.
		// Re-fold against the CURRENT branch so we never tombstone something already dropped or an
		// observation an observer committed during this run (those are not in the handed batch).
		const branch = ctx.sessionManager.getBranch();
		const stillActive = new Set(foldLedger(branch).activeObservations.map((o) => o.timestamp));
		const toDrop = promote.map((o) => o.timestamp).filter((t) => stillActive.has(t));

		if (toDrop.length > 0) {
			const coversUpToId = lastSourceEntryId(branch);
			if (coversUpToId) {
				pi.appendEntry(OM_OBSERVATIONS_DROPPED, { observationTimestamps: toDrop, coversUpToId });
			}
		}

		// Re-render INDEX.md so live ls/grep truth leads the pushed map (design risk 3).
		atomicWrite(indexPath(runtime.memoryRoot), renderIndexFile(listTopics(runtime.memoryRoot)));

		runtime.status.workerDone(runId, toDrop.length);
		runtime.refreshFooterGauges(ctx.sessionManager.getBranch(), ctx.getContextUsage?.()?.tokens ?? null);
		if (ctx.hasUI && ctx.ui) {
			runtime.queueToast(`om: consolidator promoted ${toDrop.length} obs`, "info", ctx.ui.notify.bind(ctx.ui));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		runtime.lastWorkerError = message;
		runtime.status.workerError(runId);
		if (ctx.hasUI) ctx.ui?.notify(`om: consolidator failed: ${message}`, "error");
	} finally {
		runtime.consolidatorController = undefined;
		runtime.consolidatorInFlight = false;
	}
}

/**
 * Mnemopi backend path: skip the .md consolidator subagent entirely.
 * Mnemopi already does embedding + invalidate elsewhere, so writing to
 * both stores would double-index the same content. We promote each pool
 * observation directly via ctx.memory.save() and tombstone the batch
 * exactly like the .md path would.
 *
 * Detection uses ctx.memory.status() → { backend, active, writable }.
 * Returns true when we handled it (caller skips the subagent path).
 */
async function tryPromoteViaMemoryBackend(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	promote: Observation[],
	runId: string,
): Promise<boolean> {
	const memory = (ctx as {
		memory?: {
			status?: () => Promise<{ backend?: string; active?: boolean; writable?: boolean }>;
			save?: (input: { content: string; context?: string; source?: string; importance?: number }) =>
				Promise<{ stored?: number; ids?: string[] } | undefined>;
		};
	}).memory;
	if (!memory?.save || !memory.status) return false;
	let status: { backend?: string; active?: boolean; writable?: boolean };
	try {
		status = await memory.status();
	} catch {
		return false;
	}
	// Only Mnemopi supersedes the .md consolidator. `local` / `hindsight` / `off`
	// keep the file-based path so users get topic docs they can read and diff.
	if (status.backend !== "mnemopi" || !status.active || !status.writable) return false;

	let stored = 0;
	let costUsd = 0;
	for (const obs of promote) {
		try {
			const result = await memory.save({
				content: obs.content,
				context: `pi-om observation @ ${obs.timestamp}`,
				source: "pi-om",
				importance: 0.5,
			});
			stored += result?.stored ?? 0;
		} catch {
			// keep going — one bad save shouldn't blackhole the batch
		}
	}

	// Tombstone the whole handed batch (intersected with still-active) — same
	// semantics as the .md path. Mnemopi owns the durable copy from here.
	const branch = ctx.sessionManager.getBranch();
	const stillActive = new Set(foldLedger(branch).activeObservations.map((o) => o.timestamp));
	const toDrop = promote.map((o) => o.timestamp).filter((t) => stillActive.has(t));
	if (toDrop.length > 0) {
		const coversUpToId = lastSourceEntryId(branch);
		if (coversUpToId) {
			pi.appendEntry(OM_OBSERVATIONS_DROPPED, { observationTimestamps: toDrop, coversUpToId });
		}
	}

	recordWorkerCost(pi, runtime, ctx, "consolidator", runId, costUsd);
	runtime.status.workerDone(runId, toDrop.length);
	runtime.refreshFooterGauges(ctx.sessionManager.getBranch(), ctx.getContextUsage?.()?.tokens ?? null);
	if (ctx.hasUI && ctx.ui) {
		runtime.queueToast(
			`om: consolidator → mnemopi (${stored}/${promote.length} saved, ${toDrop.length} tombstoned)`,
			"info",
			ctx.ui.notify.bind(ctx.ui),
		);
	}
	return true;
}

export function registerConsolidatorTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const handler = (_event: unknown, ctx: TriggerCtx) => evaluateConsolidatorTrigger(pi, runtime, ctx);
	pi.on("turn_end", handler as never);
	pi.on("agent_start", handler as never);
}

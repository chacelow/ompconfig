// Adapted from amosblomqvist/pi-observational-memory MIT.
// Original: references/pi-observational-memory/src/ui/status-controller.ts
//
// Changes vs upstream:
// - OMP setWidget takes { placement, content }; we render one merged widget
//   containing footer gauges + worker line + timeline instead of the separate
//   "om" status footer + "om-workers" widget keys pi-om uses.
// - Colors use theme.fg when available; otherwise plain strings.
// - No spawned workers exist in our architecture; workerStart/Done/Error still
//   run so callers can flag long-running local ops (compaction, promotion).

import type { ThemeLike, UiLike } from "./types.ts";

export type WorkerType = "observer" | "consolidator" | "promote" | "compact";

export interface FooterGauges {
  nextValue: number;
  nextMax: number;
  poolValue: number;
  poolMax: number;
  ctxValue: number;
  ctxMax: number;
}

type WorkerState =
  | { kind: "running" }
  | { kind: "done"; delta?: number }
  | { kind: "error" };

export type SpinnerTimer = ReturnType<typeof setInterval>;
export type SettleTimer = ReturnType<typeof setTimeout>;

interface WorkerEntry {
  type: WorkerType;
  state: WorkerState;
  settleTimer?: SettleTimer;
}

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const WORKER_SEP = "   ";

function paint(theme: ThemeLike | undefined, color: string, text: string): string {
  if (theme?.fg) return theme.fg(color, text);
  return text;
}

function gaugeBar(
  theme: ThemeLike | undefined,
  value: number,
  max: number,
  cells = 8,
): string {
  const frac = max <= 0 ? 0 : Math.max(0, value / max);
  const filled = Math.min(cells, Math.round(Math.min(1, frac) * cells));
  const fillColor = frac >= 1 ? "warning" : "dim";
  return (
    paint(theme, fillColor, "▕") +
    paint(theme, fillColor, "█".repeat(filled)) +
    paint(theme, fillColor, "░".repeat(cells - filled)) +
    paint(theme, fillColor, "▏")
  );
}

export interface StatusControllerOptions {
  spinnerIntervalMs?: number;
  settleMs?: number;
}

export class StatusController {
  private ui: UiLike | undefined;
  private frame = 0;
  private readonly workers = new Map<string, WorkerEntry>();
  private spinnerTimer: SpinnerTimer | undefined;
  private gauges: FooterGauges | undefined;
  private cost: { costUsd: number; runs: number } | undefined;
  private headline = "";
  private histogram: string[] = [];
  private timeline: string[] = [];
  private lastError: string | undefined;
  private readonly spinnerIntervalMs: number;
  private readonly settleMs: number;

  constructor(options: StatusControllerOptions = {}) {
    this.spinnerIntervalMs = options.spinnerIntervalMs ?? 120;
    this.settleMs = options.settleMs ?? 5000;
  }

  attach(ui: UiLike): void {
    this.ui = ui;
    this.render();
  }

  detach(): void {
    this.stopSpinner();
    for (const entry of this.workers.values()) {
      clearTimeout(entry.settleTimer);
    }
    this.workers.clear();
    this.gauges = undefined;
    this.cost = undefined;
    this.headline = "";
    this.histogram = [];
    this.timeline = [];
    this.lastError = undefined;
    if (this.ui) {
      this.ui.setWidget?.({ placement: "aboveEditor", content: [] });
      this.ui.setStatus?.("observation-journal", "");
    }
    this.ui = undefined;
  }

  setHeadline(text: string): void {
    this.headline = text;
    this.render();
  }

  setHistogram(lines: string[]): void {
    this.histogram = lines;
    this.render();
  }

  setTimeline(lines: string[]): void {
    this.timeline = lines;
    this.render();
  }

  setGauges(gauges: FooterGauges | undefined): void {
    this.gauges = gauges;
    this.render();
  }

  setCost(costUsd: number, runs: number): void {
    this.cost = { costUsd, runs };
    this.render();
  }

  setLastError(message: string | undefined): void {
    this.lastError = message;
    this.render();
  }

  workerStart(type: WorkerType, runId: string): void {
    const existing = this.workers.get(runId);
    clearTimeout(existing?.settleTimer);
    this.workers.set(runId, { type, state: { kind: "running" } });
    this.startSpinner();
    this.render();
  }

  workerDone(runId: string, delta?: number): void {
    this.settle(runId, { kind: "done", delta });
  }

  workerError(runId: string, message?: string): void {
    if (message) this.lastError = message;
    this.settle(runId, { kind: "error" });
  }

  private settle(runId: string, state: WorkerState): void {
    const entry = this.workers.get(runId);
    if (!entry) return;
    clearTimeout(entry.settleTimer);
    entry.state = state;
    this.render();
    entry.settleTimer = setTimeout(() => {
      this.workers.delete(runId);
      this.render();
      if (!this.hasRunningWorker()) this.stopSpinner();
    }, this.settleMs);
    entry.settleTimer.unref?.();
    if (!this.hasRunningWorker()) this.stopSpinner();
  }

  private hasRunningWorker(): boolean {
    for (const entry of this.workers.values()) {
      if (entry.state.kind === "running") return true;
    }
    return false;
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      if (this.hasRunningWorker()) this.render();
    }, this.spinnerIntervalMs);
    this.spinnerTimer.unref?.();
  }

  private stopSpinner(): void {
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private renderWorkerLine(): string | null {
    if (this.workers.size === 0) return null;
    const theme = this.ui?.theme;
    const parts: string[] = [];
    for (const entry of this.workers.values()) {
      if (entry.state.kind === "running") {
        parts.push(
          `${paint(theme, "accent", SPINNER_FRAMES[this.frame])} ${paint(theme, "accent", `[${entry.type}]`)}`,
        );
      } else if (entry.state.kind === "error") {
        parts.push(
          `${paint(theme, "error", "✗")} ${paint(theme, "muted", `[${entry.type}]`)}`,
        );
      } else {
        const delta =
          entry.state.delta && entry.state.delta > 0
            ? ` ${paint(theme, "success", `+${entry.state.delta}`)}`
            : "";
        parts.push(
          `${paint(theme, "success", "✓")} ${paint(theme, "muted", `[${entry.type}]`)}${delta}`,
        );
      }
    }
    return parts.join(WORKER_SEP);
  }

  private renderFooter(): string | null {
    const theme = this.ui?.theme;
    const g = this.gauges;
    if (!g && !this.cost) return null;
    const bits: string[] = [];
    if (g) {
      bits.push(
        `${paint(theme, "muted", "O")}${gaugeBar(theme, g.nextValue, g.nextMax)}`,
      );
      bits.push(
        `${paint(theme, "muted", "C")}${gaugeBar(theme, g.poolValue, g.poolMax)}`,
      );
      bits.push(
        `${paint(theme, "muted", "X")}${gaugeBar(theme, g.ctxValue, g.ctxMax)}`,
      );
    }
    if (this.cost) {
      bits.push(paint(theme, "dim", `$${this.cost.costUsd.toFixed(3)}`));
    }
    return bits.join("  ");
  }

  private render(): void {
    const ui = this.ui;
    if (!ui) return;
    const lines: string[] = [];
    if (this.headline) lines.push(this.headline);
    for (const line of this.histogram) lines.push(line);
    for (const line of this.timeline) lines.push(line);
    const workerLine = this.renderWorkerLine();
    if (workerLine) lines.push(`   ${workerLine}`);
    const footer = this.renderFooter();
    if (footer) lines.push(`   ${footer}`);
    if (this.lastError) {
      lines.push(`   ${paint(ui.theme, "error", `! ${this.lastError}`)}`);
    }
    const statusText =
      this.headline || (this.gauges ? "Journal · gauges" : "");
    if (statusText.length > 0) {
      ui.setStatus?.("observation-journal", statusText);
    }
    ui.setWidget?.({ placement: "aboveEditor", content: lines });
  }
}

/** Batches info-level notify lines into a single next-tick flush so parallel */
/** callsites do not overwrite each other's toasts. */
export class ToastCoalescer {
  private pending: string[] = [];
  private timer: SettleTimer | undefined;
  private pendingNotify:
    | ((message: string, level: "info" | "warn" | "warning" | "error") => void)
    | undefined;

  queue(
    line: string,
    level: "info" | "warn" | "warning" | "error",
    notify: (
      message: string,
      level: "info" | "warn" | "warning" | "error",
    ) => void,
  ): void {
    if (level !== "info") {
      notify(line, level);
      return;
    }
    this.pending.push(line);
    this.pendingNotify = notify;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushNow();
    }, 0);
    this.timer.unref?.();
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.flushNow();
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.pendingNotify = undefined;
  }

  private flushNow(): void {
    const lines = this.pending.splice(0);
    const notify = this.pendingNotify;
    this.pendingNotify = undefined;
    if (lines.length === 0 || !notify) return;
    notify(lines.join("\n"), "info");
  }
}

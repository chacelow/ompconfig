// Timeline renderer inspired by pi-observational-memory/src/ui/timeline.ts.
// Adapts the glyph vocabulary + chunk-boundary layout to our data model
// (branch-native session entries; no separate pool / .memory tier).
//
// Cells advance one glyph per `cellTokens` of raw session tokens. Each
// observation lands on the cell corresponding to its evidence entry's
// approximate position; compaction cutoffs are drawn as separators.

import type { JournalState, Observation } from "./types.ts";

export interface TimelineInput {
  state: JournalState;
  branch: readonly { type: string; id?: string; [key: string]: unknown }[];
  cellTokens: number;
  contextTokens: number;
  maxCells?: number;
}

const GLYPH = {
  observed: "▒",
  observedMulti: "▓",
  cut: "┊",
  raw: "░",
  tip: "▶",
} as const;

const CATEGORY_ORDER = [
  "fact",
  "decision",
  "preference",
  "failed-attempt",
  "deviation",
  "constraint",
  "open-question",
] as const;

const CATEGORY_LETTERS: Record<string, string> = {
  fact: "F",
  decision: "D",
  preference: "P",
  "failed-attempt": "X",
  deviation: "≠",
  constraint: "C",
  "open-question": "?",
};

function fmtK(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

function branchIndexById(
  branch: readonly { id?: string }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < branch.length; i++) {
    const id = branch[i]?.id;
    if (typeof id === "string") out.set(id, i);
  }
  return out;
}

interface CompactionEntry {
  type: string;
  id?: string;
  firstKeptEntryId?: string;
}

function isCompactionEntry(entry: unknown): entry is CompactionEntry {
  if (!entry || typeof entry !== "object") return false;
  if (!("type" in entry) || (entry as { type: unknown }).type !== "compaction") {
    return false;
  }
  return true;
}

function observationPosition(
  observation: Observation,
  branchIndex: Map<string, number>,
  branchLength: number,
): number {
  const evidence = observation.evidenceEntryIds[0];
  const idx = evidence ? branchIndex.get(evidence) : undefined;
  if (idx !== undefined) return idx;
  return branchLength - 1;
}

/**
 * Render a two-line timeline: metadata + strip. Returns an empty array when
 * there is nothing to draw.
 */
export function renderTimelineLines(input: TimelineInput): string[] {
  const { state, branch, cellTokens, contextTokens } = input;
  if (state.observations.length === 0 && state.segments.length === 0) return [];

  const maxCells = input.maxCells ?? 40;
  const totalTokens = Math.max(cellTokens, contextTokens || cellTokens);
  const rawCells = Math.min(maxCells, Math.max(1, Math.ceil(totalTokens / cellTokens)));

  const glyphs: string[] = Array.from({ length: rawCells }, () => GLYPH.raw);
  const cellCategories: Record<number, Record<string, number>> = {};
  const branchIndex = branchIndexById(branch);
  const branchLength = branch.length;

  for (const observation of state.observations) {
    const pos = observationPosition(observation, branchIndex, branchLength);
    const cell = Math.min(rawCells - 1, Math.floor((pos / Math.max(1, branchLength - 1)) * rawCells));
    cellCategories[cell] = cellCategories[cell] ?? {};
    cellCategories[cell][observation.category] =
      (cellCategories[cell][observation.category] ?? 0) + 1;
  }

  for (const key of Object.keys(cellCategories)) {
    const cell = Number(key);
    const buckets = cellCategories[cell];
    const total = Object.values(buckets).reduce((sum, n) => sum + n, 0);
    if (total === 1) {
      const category = Object.keys(buckets)[0];
      glyphs[cell] = CATEGORY_LETTERS[category] ?? GLYPH.observed;
    } else if (total > 1) {
      glyphs[cell] = GLYPH.observedMulti;
    }
  }

  const cutCells = new Set<number>();
  for (const entry of branch) {
    if (!isCompactionEntry(entry)) continue;
    const idx = entry.firstKeptEntryId ? branchIndex.get(entry.firstKeptEntryId) : undefined;
    if (idx === undefined) continue;
    const cell = Math.min(rawCells - 1, Math.floor((idx / Math.max(1, branchLength - 1)) * rawCells));
    cutCells.add(cell);
  }

  const cellsWithCuts: string[] = [];
  for (let i = 0; i < glyphs.length; i++) {
    if (cutCells.has(i)) cellsWithCuts.push(GLYPH.cut);
    cellsWithCuts.push(glyphs[i]);
  }

  const strip = cellsWithCuts.join("") + GLYPH.tip;

  const totals: Record<string, number> = {};
  for (const observation of state.observations) {
    totals[observation.category] = (totals[observation.category] ?? 0) + 1;
  }
  const legendParts: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const count = totals[category] ?? 0;
    if (count > 0) {
      legendParts.push(`${CATEGORY_LETTERS[category]} ${category} (${count})`);
    }
  }
  legendParts.push(`${GLYPH.cut} cut (${cutCells.size})`);
  legendParts.push(`${GLYPH.tip} tip`);

  return [
    `Journey timeline · 1 cell ≈ ${fmtK(cellTokens)} tok · ${state.observations.length} obs · ${cutCells.size} cut${cutCells.size === 1 ? "" : "s"}`,
    strip,
    legendParts.join("   "),
  ];
}

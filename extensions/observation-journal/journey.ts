// Observation Journal — rendering + imperative-language guard.
// SPEC: extensions/observation-journal/SPEC.md §3.3, §9.4.

import type {
  JournalConfig,
  JourneySegment,
  Observation,
} from "./types.ts";

const IMPERATIVE_PATTERNS: RegExp[] = [
  /你必须/,
  /你需要/,
  /以后要/,
  /\bfrom now on\b/i,
  /\byou must\b/i,
  /\byou shall\b/i,
  /\bmust\s+(?:be|not|always|never)\b/i,
  /\bshall\s+(?:be|not|always|never)\b/i,
];

/**
 * Reject imperative / directive phrasing in Observation content.
 *
 * Journey describes what happened. It never becomes a system instruction.
 * SPEC §9.4 makes this a bug: any accepted observation with imperative
 * phrasing is a defect.
 */
export function isImperative(content: string): boolean {
  return IMPERATIVE_PATTERNS.some((rx) => rx.test(content));
}

interface RenderInput {
  sessionTitle: string;
  observations: Observation[];
  segments: JourneySegment[];
  config: JournalConfig;
  now: string;
}

/**
 * Render the Journey markdown for the current branch.
 *
 * Deterministic given the same input. Enforces:
 * - segments ≤ config.journeyMaxSegments (trims oldest merged)
 * - recent observations ≤ config.recentObservationsMax
 * - total bytes ≤ config.journeyTargetBytes (truncates with marker)
 */
export function renderJourney(input: RenderInput): string {
  const { sessionTitle, observations, segments, config, now } = input;

  const bounded = boundSegments(segments, config.journeyMaxSegments);

  const recent = observations
    .slice(-config.recentObservationsMax)
    .filter((o) => o.category !== "open-question");

  const openQuestions = observations
    .filter((o) => o.category === "open-question")
    .slice(-config.recentObservationsMax);

  const lines: string[] = [];
  lines.push(`# Journey — ${sessionTitle || "current session"}`);
  lines.push("");
  lines.push(`_Last updated: ${now}_`);
  lines.push("");

  for (const segment of bounded) {
    const day = segment.timestamp.slice(0, 10);
    lines.push(`## ${day} · ${segment.title}`);
    lines.push("");
    lines.push(segment.body);
    lines.push("");
  }

  if (recent.length > 0) {
    lines.push("## Recent observations");
    lines.push("");
    for (const observation of recent) {
      lines.push(`- [${observation.category}] ${observation.content}`);
    }
    lines.push("");
  }

  if (openQuestions.length > 0) {
    lines.push("## Open questions");
    lines.push("");
    for (const question of openQuestions) {
      lines.push(`- ${question.content}`);
    }
    lines.push("");
  }

  return truncateBytes(lines.join("\n"), config.journeyTargetBytes);
}

/**
 * Trim segments to the configured maximum. Oldest excess segments are folded
 * into an aggregate "earlier" segment; recent segments stay verbatim.
 */
function boundSegments(
  segments: JourneySegment[],
  maxSegments: number,
): JourneySegment[] {
  if (segments.length <= maxSegments) return segments;
  const overflowCount = segments.length - maxSegments + 1;
  const overflow = segments.slice(0, overflowCount);
  const rest = segments.slice(overflowCount);
  const merged: JourneySegment = {
    id: `merged-${overflow[0].id}`,
    timestamp: overflow[0].timestamp,
    title: `earlier (${overflow.length} segments folded)`,
    body: overflow
      .map((segment) => `- ${segment.title}`)
      .join("\n")
      .slice(0, 800),
    sourceObservationIds: overflow.flatMap((s) => s.sourceObservationIds),
  };
  return [merged, ...rest];
}

/**
 * Render a compact injection block for Compaction Orientation.
 *
 * Stage 2 uses this; kept in this module because it shares the same
 * source-of-truth rendering rules.
 */
export function renderCompactionInjection(input: {
  segments: JourneySegment[];
  observations: Observation[];
  maxBytes: number;
  now: string;
}): string {
  const lines: string[] = [];
  lines.push(`Observation Journal snapshot @ ${input.now}`);
  const recentSegments = input.segments.slice(-3);
  for (const segment of recentSegments) {
    lines.push(`- ${segment.title}: ${segment.body}`);
  }
  const decisions = input.observations
    .filter(
      (o) => o.category === "decision" || o.category === "preference",
    )
    .slice(-10);
  for (const observation of decisions) {
    lines.push(`- [${observation.category}] ${observation.content}`);
  }
  const questions = input.observations
    .filter((o) => o.category === "open-question")
    .slice(-5);
  for (const question of questions) {
    lines.push(`- [open] ${question.content}`);
  }
  return truncateBytes(lines.join("\n"), input.maxBytes);
}

function truncateBytes(text: string, limit: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= limit) return text;
  const marker = "\n\n_… truncated_";
  const markerBytes = encoder.encode(marker).length;
  const budget = Math.max(0, limit - markerBytes);
  const decoder = new TextDecoder();
  const truncated = decoder.decode(encoded.slice(0, budget));
  return truncated + marker;
}

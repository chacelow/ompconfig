// Observation Journal — branch-aware state reconstruction.
// SPEC: extensions/observation-journal/SPEC.md §3, §4.

import {
  CURSOR_TYPE,
  ENABLED_TYPE,
  OBSERVATION_TYPE,
  PROMOTION_TYPE,
  SEGMENT_TYPE,
  type Cursor,
  type JournalState,
  type JourneySegment,
  type Observation,
  type PromotionRecord,
  type SessionEntryLike,
} from "./types.ts";

function isCustomEntryOfType(
  entry: SessionEntryLike,
  customType: string,
): boolean {
  return entry.type === "custom" && entry.customType === customType;
}

function readEnabledFlag(data: unknown): boolean | undefined {
  if (data && typeof data === "object" && "enabled" in data) {
    const flag = (data as { enabled: unknown }).enabled;
    if (typeof flag === "boolean") return flag;
  }
  return undefined;
}

function readCursor(data: unknown): Cursor | undefined {
  if (!data || typeof data !== "object") return undefined;
  if (!("coversUpToEntryId" in data)) return undefined;
  const entryId = (data as { coversUpToEntryId: unknown }).coversUpToEntryId;
  if (typeof entryId !== "string") return undefined;
  const tokensRaw =
    "tokensSince" in data
      ? (data as { tokensSince: unknown }).tokensSince
      : undefined;
  const tokensSince =
    typeof tokensRaw === "number" && tokensRaw >= 0 ? tokensRaw : 0;
  return { coversUpToEntryId: entryId, tokensSince };
}

function isValidObservation(value: unknown): value is Observation {
  if (!value || typeof value !== "object") return false;
  if (
    !("id" in value) ||
    !("timestamp" in value) ||
    !("sessionId" in value) ||
    !("category" in value) ||
    !("content" in value) ||
    !("evidenceEntryIds" in value) ||
    !("durable" in value) ||
    !("source" in value)
  ) {
    return false;
  }
  const {
    id,
    timestamp,
    sessionId,
    category,
    content,
    evidenceEntryIds,
    durable,
    source,
  } = value as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0) return false;
  if (typeof timestamp !== "string") return false;
  if (typeof sessionId !== "string") return false;
  if (typeof category !== "string") return false;
  if (typeof content !== "string" || content.length === 0) return false;
  if (!Array.isArray(evidenceEntryIds) || evidenceEntryIds.length === 0) {
    return false;
  }
  if (typeof durable !== "boolean") return false;
  if (source !== "manual" && source !== "subagent") return false;
  return true;
}

function isValidSegment(value: unknown): value is JourneySegment {
  if (!value || typeof value !== "object") return false;
  if (
    !("id" in value) ||
    !("timestamp" in value) ||
    !("title" in value) ||
    !("body" in value) ||
    !("sourceObservationIds" in value)
  ) {
    return false;
  }
  const { id, timestamp, title, body, sourceObservationIds } = value as Record<
    string,
    unknown
  >;
  return (
    typeof id === "string" &&
    typeof timestamp === "string" &&
    typeof title === "string" &&
    typeof body === "string" &&
    Array.isArray(sourceObservationIds)
  );
}

function isValidPromotion(value: unknown): value is PromotionRecord {
  if (!value || typeof value !== "object") return false;
  if (!("observationId" in value) || !("status" in value)) return false;
  const { observationId, status } = value as Record<string, unknown>;
  if (typeof observationId !== "string") return false;
  return (
    status === "pending" ||
    status === "promoted" ||
    status === "skipped" ||
    status === "failed"
  );
}

/**
 * Rebuild journal state from a linear branch of session entries.
 *
 * The branch is the ordered sequence of entries reachable from the current
 * leaf. When the caller switches branches or navigates the tree, the caller
 * passes a fresh branch and the state is rebuilt from scratch — so branch
 * rollback is automatic.
 *
 * Pure function: given the same branch and sessionId, output is identical.
 */
export function rebuildFromBranch(
  branch: readonly SessionEntryLike[],
  sessionId: string,
): JournalState {
  let enabled = false;
  const observationOrder: string[] = [];
  const observationsById = new Map<string, Observation>();
  const segments: JourneySegment[] = [];
  let cursor: Cursor | undefined;
  const promotions = new Map<string, PromotionRecord>();

  for (const entry of branch) {
    if (isCustomEntryOfType(entry, ENABLED_TYPE)) {
      const next = readEnabledFlag(entry.data);
      if (next !== undefined) enabled = next;
      continue;
    }
    if (isCustomEntryOfType(entry, OBSERVATION_TYPE)) {
      if (isValidObservation(entry.data)) {
        if (!observationsById.has(entry.data.id)) {
          observationOrder.push(entry.data.id);
        }
        observationsById.set(entry.data.id, entry.data);
      }
      continue;
    }
    if (isCustomEntryOfType(entry, SEGMENT_TYPE)) {
      if (isValidSegment(entry.data)) segments.push(entry.data);
      continue;
    }
    if (isCustomEntryOfType(entry, CURSOR_TYPE)) {
      const next = readCursor(entry.data);
      if (next) cursor = next;
      continue;
    }
    if (isCustomEntryOfType(entry, PROMOTION_TYPE)) {
      if (isValidPromotion(entry.data)) {
        promotions.set(entry.data.observationId, entry.data);
      }
      continue;
    }
  }

  const observations = observationOrder.map(
    (id) => observationsById.get(id) as Observation,
  );

  return { enabled, sessionId, observations, segments, cursor, promotions };
}

/**
 * Cryptographically random 8-hex-character id, or a deterministic timestamp
 * fallback for environments without WebCrypto. Exposed as a stable seam so
 * tests can substitute a deterministic generator when needed.
 */
export function generateId(prefix: string = ""): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  const hex =
    cryptoObj && typeof cryptoObj.getRandomValues === "function"
      ? (() => {
          const bytes = new Uint8Array(4);
          cryptoObj.getRandomValues(bytes);
          return Array.from(bytes, (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        })()
      : ((Date.now() & 0xffffffff) >>> 0).toString(16).padStart(8, "0");
  return prefix ? `${prefix}-${hex}` : hex;
}

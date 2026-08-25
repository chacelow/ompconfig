import { describe, expect, test } from "bun:test";
import { rebuildFromBranch } from "../ledger.ts";
import {
  ENABLED_TYPE,
  OBSERVATION_TYPE,
  PROMOTION_TYPE,
  SEGMENT_TYPE,
  type Observation,
  type PromotionRecord,
  type SessionEntryLike,
} from "../types.ts";

function observation(overrides: Partial<Observation>): Observation {
  return {
    id: overrides.id ?? "obs-1",
    timestamp: overrides.timestamp ?? "2026-08-25T00:00:00.000Z",
    sessionId: overrides.sessionId ?? "session-a",
    category: overrides.category ?? "decision",
    content: overrides.content ?? "example decision",
    evidenceEntryIds: overrides.evidenceEntryIds ?? ["entry-1"],
    durable: overrides.durable ?? false,
    source: overrides.source ?? "manual",
  };
}

function customEntry(customType: string, data: unknown): SessionEntryLike {
  return { type: "custom", customType, data };
}

describe("rebuildFromBranch", () => {
  test("default state is disabled with empty lists", () => {
    const state = rebuildFromBranch([], "session-a");
    expect(state.enabled).toBe(false);
    expect(state.observations).toHaveLength(0);
    expect(state.segments).toHaveLength(0);
    expect(state.promotions.size).toBe(0);
    expect(state.cursor).toBeUndefined();
    expect(state.sessionId).toBe("session-a");
  });

  test("latest enabled entry wins", () => {
    const state = rebuildFromBranch(
      [
        customEntry(ENABLED_TYPE, { enabled: true }),
        customEntry(ENABLED_TYPE, { enabled: false }),
      ],
      "session-a",
    );
    expect(state.enabled).toBe(false);
  });

  test("observations are accumulated in order", () => {
    const state = rebuildFromBranch(
      [
        customEntry(OBSERVATION_TYPE, observation({ id: "a" })),
        customEntry(OBSERVATION_TYPE, observation({ id: "b" })),
      ],
      "session-a",
    );
    expect(state.observations.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  test("invalid observations are silently dropped", () => {
    const state = rebuildFromBranch(
      [
        customEntry(OBSERVATION_TYPE, { id: "bad" }),
        customEntry(
          OBSERVATION_TYPE,
          observation({ id: "good", content: "good content" }),
        ),
      ],
      "session-a",
    );
    expect(state.observations.map((entry) => entry.id)).toEqual(["good"]);
  });

  test("branch rollback: observations only from the current branch are visible", () => {
    // Branch A: enabled + observation X.
    const branchA: SessionEntryLike[] = [
      customEntry(ENABLED_TYPE, { enabled: true }),
      customEntry(OBSERVATION_TYPE, observation({ id: "X" })),
    ];
    // Branch B (from same root, without observation X): only enabled + Y.
    const branchB: SessionEntryLike[] = [
      customEntry(ENABLED_TYPE, { enabled: true }),
      customEntry(OBSERVATION_TYPE, observation({ id: "Y" })),
    ];
    expect(rebuildFromBranch(branchA, "s").observations.map((o) => o.id)).toEqual(
      ["X"],
    );
    expect(rebuildFromBranch(branchB, "s").observations.map((o) => o.id)).toEqual(
      ["Y"],
    );
  });

  test("promotion records are indexed by observationId", () => {
    const promotion: PromotionRecord = {
      observationId: "obs-1",
      status: "promoted",
      memoryId: "mem-1",
      reviewedAt: "2026-08-25T00:00:00.000Z",
    };
    const state = rebuildFromBranch(
      [customEntry(PROMOTION_TYPE, promotion)],
      "session-a",
    );
    expect(state.promotions.get("obs-1")).toEqual(promotion);
  });

  test("segments accept only well-formed shapes", () => {
    const state = rebuildFromBranch(
      [
        customEntry(SEGMENT_TYPE, {
          id: "seg-1",
          timestamp: "2026-08-25T00:00:00.000Z",
          title: "t",
          body: "b",
          sourceObservationIds: [],
        }),
        customEntry(SEGMENT_TYPE, { id: "seg-2" }),
      ],
      "session-a",
    );
    expect(state.segments.map((seg) => seg.id)).toEqual(["seg-1"]);
  });
});

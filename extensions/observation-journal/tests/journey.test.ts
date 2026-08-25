import { describe, expect, test } from "bun:test";
import {
  isImperative,
  renderCompactionInjection,
  renderJourney,
} from "../journey.ts";
import {
  DEFAULT_CONFIG,
  type JournalConfig,
  type JourneySegment,
  type Observation,
} from "../types.ts";

function observation(overrides: Partial<Observation>): Observation {
  return {
    id: overrides.id ?? "obs-1",
    timestamp: overrides.timestamp ?? "2026-08-25T00:00:00.000Z",
    sessionId: overrides.sessionId ?? "session-a",
    category: overrides.category ?? "decision",
    content: overrides.content ?? "chose approach B over A",
    evidenceEntryIds: overrides.evidenceEntryIds ?? ["entry-1"],
    durable: overrides.durable ?? false,
    source: overrides.source ?? "manual",
  };
}

function segment(overrides: Partial<JourneySegment>): JourneySegment {
  return {
    id: overrides.id ?? "seg-1",
    timestamp: overrides.timestamp ?? "2026-08-24T00:00:00.000Z",
    title: overrides.title ?? "Alpha phase",
    body: overrides.body ?? "Explored initial design.",
    sourceObservationIds: overrides.sourceObservationIds ?? [],
  };
}

describe("isImperative", () => {
  test("rejects 你必须", () => {
    expect(isImperative("你必须使用 TDD")).toBe(true);
  });
  test("rejects you must", () => {
    expect(isImperative("You must always run tests")).toBe(true);
  });
  test("rejects from now on", () => {
    expect(isImperative("From now on, avoid X")).toBe(true);
  });
  test("accepts descriptive prose", () => {
    expect(isImperative("Chose approach B because it survives branch rollback")).toBe(
      false,
    );
  });
  test("accepts the word must in benign contexts", () => {
    // "musthaves" and standalone `must` without helper verbs are allowed.
    expect(isImperative("We discussed the musthaves list")).toBe(false);
  });
});

describe("renderJourney", () => {
  const config: JournalConfig = { ...DEFAULT_CONFIG };

  test("renders header, segments, recent observations, and open questions", () => {
    const output = renderJourney({
      sessionTitle: "spec review",
      observations: [
        observation({ id: "a", content: "decided to vendor Matt bundle" }),
        observation({
          id: "b",
          category: "open-question",
          content: "how to trigger observer",
        }),
      ],
      segments: [segment({ title: "Skills review" })],
      config,
      now: "2026-08-25T10:00:00.000Z",
    });
    expect(output).toContain("# Journey — spec review");
    expect(output).toContain("Skills review");
    expect(output).toContain("Recent observations");
    expect(output).toContain("Open questions");
    expect(output).toContain("[decision] decided to vendor Matt bundle");
    expect(output).toContain("- how to trigger observer");
  });

  test("truncates to configured byte budget", () => {
    const tiny: JournalConfig = { ...config, journeyTargetBytes: 200 };
    const output = renderJourney({
      sessionTitle: "long",
      observations: Array.from({ length: 30 }, (_, index) =>
        observation({
          id: `o${index}`,
          content: `long observation content ${index} `.repeat(4),
        }),
      ),
      segments: [],
      config: tiny,
      now: "2026-08-25T10:00:00.000Z",
    });
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(200);
    expect(output).toContain("_… truncated_");
  });

  test("folds oldest segments when journeyMaxSegments exceeded", () => {
    const strict: JournalConfig = { ...config, journeyMaxSegments: 3 };
    const segments: JourneySegment[] = Array.from({ length: 5 }, (_, index) =>
      segment({
        id: `seg-${index}`,
        title: `phase ${index}`,
        timestamp: `2026-08-2${index}T00:00:00.000Z`,
      }),
    );
    const output = renderJourney({
      sessionTitle: "folding",
      observations: [],
      segments,
      config: strict,
      now: "2026-08-25T10:00:00.000Z",
    });
    expect(output).toContain("earlier (3 segments folded)");
    expect(output).toContain("phase 3");
    expect(output).toContain("phase 4");
  });
});

describe("renderCompactionInjection", () => {
  test("prioritises decisions and open questions and truncates to budget", () => {
    const output = renderCompactionInjection({
      segments: [segment({ title: "Alpha", body: "did the alpha phase" })],
      observations: [
        observation({ id: "d1", category: "decision", content: "adopted variant table" }),
        observation({
          id: "p1",
          category: "preference",
          content: "prefer batched questions",
        }),
        observation({
          id: "q1",
          category: "open-question",
          content: "still deciding backend",
        }),
      ],
      maxBytes: 1024,
      now: "2026-08-25T10:00:00.000Z",
    });
    expect(output).toContain("Observation Journal snapshot");
    expect(output).toContain("adopted variant table");
    expect(output).toContain("prefer batched questions");
    expect(output).toContain("still deciding backend");
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(1024);
  });
});

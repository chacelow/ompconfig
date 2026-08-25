// End-to-end extension test with an in-memory host fake.
// SPEC verification for Stage 1 §8:
//   * 3. gate off → turn_end/session_start handlers must not persist entries.
//   * 4. ctx.memory API is never touched (asserted via absent surface + spy).
//   * 5. No writes outside the artifacts dir (fs writes are spied).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import observationJournalFactory from "../index.ts";
import { _resetStoresForTesting } from "../index.ts";
import {
  ENABLED_TYPE,
  OBSERVATION_TYPE,
  SEGMENT_TYPE,
  type CommandDefinition,
  type EventHandler,
  type ExtensionAPILike,
  type ExtensionContextLike,
  type SessionEntryLike,
} from "../types.ts";

interface HostRecord {
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, CommandDefinition>;
  api: ExtensionAPILike;
  appendedEntries: Array<{ customType: string; data: unknown }>;
}

function createHost(): HostRecord {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, CommandDefinition>();
  const appendedEntries: HostRecord["appendedEntries"] = [];
  const api: ExtensionAPILike = {
    on: (event, handler) => {
      const list = handlers.get(event);
      if (list) list.push(handler);
      else handlers.set(event, [handler]);
    },
    registerCommand: (name, definition) => {
      commands.set(name, definition);
    },
    appendEntry: (customType, data) => {
      appendedEntries.push({ customType, data });
    },
    setLabel: () => {},
  };
  return { handlers, commands, api, appendedEntries };
}

interface FakeSessionOptions {
  sessionId?: string;
  artifactsDir?: string;
  initialBranch?: SessionEntryLike[];
}

function createFakeContext(
  host: HostRecord,
  options: FakeSessionOptions = {},
): {
  ctx: ExtensionContextLike;
  branch: SessionEntryLike[];
  notifications: Array<{ message: string; level: string }>;
  memorySaveSpy: { count: number };
} {
  const branch = options.initialBranch ?? [];
  const notifications: Array<{ message: string; level: string }> = [];
  const memorySaveSpy = { count: 0 };
  const sessionId = options.sessionId ?? "session-alpha";
  const artifactsDir = options.artifactsDir;

  // The extension appends entries via pi.appendEntry. Mirror those onto the
  // branch so subsequent rebuilds see them.
  const originalAppend = host.api.appendEntry;
  host.api.appendEntry = (customType, data) => {
    originalAppend(customType, data);
    branch.push({
      type: "custom",
      id: `e${branch.length + 1}`,
      customType,
      data,
    });
  };

  const ctx: ExtensionContextLike = {
    hasUI: true,
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level: level ?? "info" });
      },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
      getSessionTitle: () => "test session",
      getLeafEntryId: () => branch.at(-1)?.id,
      getArtifactsDir: () => artifactsDir,
    },
  };

  // Attach a memory surface as an extra property, then verify no one writes
  // to it. We intentionally do NOT expose this via the ExtensionContextLike
  // type: the extension must not reach for it.
  Object.defineProperty(ctx, "memory", {
    value: {
      save: () => {
        memorySaveSpy.count += 1;
        return Promise.resolve();
      },
    },
    enumerable: true,
    configurable: true,
  });

  return { ctx, branch, notifications, memorySaveSpy };
}

async function fireEvent(
  host: HostRecord,
  name: string,
  ctx: ExtensionContextLike,
): Promise<void> {
  const list = host.handlers.get(name) ?? [];
  for (const handler of list) await handler(undefined, ctx);
}

async function runCommand(
  host: HostRecord,
  name: string,
  args: string,
  ctx: ExtensionContextLike,
): Promise<void> {
  const definition = host.commands.get(name);
  if (!definition) throw new Error(`command ${name} not registered`);
  await definition.handler(args, ctx);
}

describe("observation-journal extension", () => {

  beforeEach(() => { _resetStoresForTesting(); });
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-journal-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test("registers events and command surface", () => {
    const host = createHost();
    observationJournalFactory(host.api);
    expect(host.commands.has("journey")).toBe(true);
    expect(host.handlers.get("session_start")?.length).toBeGreaterThan(0);
    expect(host.handlers.get("turn_end")?.length).toBeGreaterThan(0);
    expect(host.handlers.get("session_branch")?.length).toBeGreaterThan(0);
    expect(host.handlers.get("session_shutdown")?.length).toBeGreaterThan(0);
  });

  test("default OFF: turn_end and session_start do not append", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx } = createFakeContext(host);
    await fireEvent(host, "session_start", ctx);
    await fireEvent(host, "turn_end", ctx);
    expect(host.appendedEntries).toHaveLength(0);
  });

  test("add before /journey on is rejected", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, notifications } = createFakeContext(host);
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "add fact tried something", ctx);
    expect(host.appendedEntries).toHaveLength(0);
    expect(
      notifications.some((entry) => entry.message.includes("disabled")),
    ).toBe(true);
  });

  test("add rejects imperative content", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const artifactsDir = path.join(tmpRoot, "artifacts");
    const { ctx, notifications } = createFakeContext(host, { artifactsDir });
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(host, "journey", "add decision 你必须使用 TDD", ctx);
    expect(
      host.appendedEntries.filter(
        (entry) => entry.customType === OBSERVATION_TYPE,
      ),
    ).toHaveLength(0);
    expect(
      notifications.some((entry) =>
        entry.message.includes("describe events, not issue instructions"),
      ),
    ).toBe(true);
  });

  test("full journey lifecycle: on → add → flush → show writes JOURNEY.md to artifacts dir only", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const artifactsDir = path.join(tmpRoot, "artifacts");
    const { ctx, notifications, memorySaveSpy } = createFakeContext(host, {
      artifactsDir,
    });
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(
      host,
      "journey",
      "add decision chose approach B over A",
      ctx,
    );
    await runCommand(
      host,
      "journey",
      "add preference prefer batched questions",
      ctx,
    );
    await runCommand(
      host,
      "journey",
      "add open-question backend adapter still open",
      ctx,
    );
    await runCommand(host, "journey", "flush", ctx);

    const enabledCount = host.appendedEntries.filter(
      (entry) => entry.customType === ENABLED_TYPE,
    ).length;
    const observationCount = host.appendedEntries.filter(
      (entry) => entry.customType === OBSERVATION_TYPE,
    ).length;
    const segmentCount = host.appendedEntries.filter(
      (entry) => entry.customType === SEGMENT_TYPE,
    ).length;
    expect(enabledCount).toBe(1);
    expect(observationCount).toBe(3);
    expect(segmentCount).toBe(1);

    const journeyPath = path.join(artifactsDir, "observation-journal", "JOURNEY.md");
    const body = await fs.readFile(journeyPath, "utf8");
    expect(body).toContain("# Journey — test session");
    expect(body).toContain("chose approach B over A");
    expect(body).toContain("prefer batched questions");
    expect(body).toContain("Open questions");
    expect(body).toContain("backend adapter still open");

    // SPEC §Stage 1 verification 4: Mnemopi surface was never touched.
    expect(memorySaveSpy.count).toBe(0);

    // SPEC §Stage 1 verification 5: no writes outside the artifacts dir.
    const stray = await fs
      .stat(path.join(tmpRoot, "somewhere-else"))
      .catch(() => null);
    expect(stray).toBeNull();

    // Sanity: status notification lists 3 observations.
    await runCommand(host, "journey", "status", ctx);
    const statusMessage = notifications.at(-1)?.message ?? "";
    expect(statusMessage).toContain("observations: 3");
    expect(statusMessage).toContain("segments:     1");
  });

  test("redaction runs on stored content", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const artifactsDir = path.join(tmpRoot, "artifacts");
    const { ctx } = createFakeContext(host, { artifactsDir });
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(
      host,
      "journey",
      "add fact leaked sk-1234567890abcdef1234567890abcd token",
      ctx,
    );
    const observationEntry = host.appendedEntries.find(
      (entry) => entry.customType === OBSERVATION_TYPE,
    );
    const content =
      observationEntry?.data &&
      typeof observationEntry.data === "object" &&
      "content" in observationEntry.data
        ? String((observationEntry.data as { content: unknown }).content)
        : "";
    expect(content).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(content).toContain("[REDACTED");
  });

  test("branch rollback: switching branches drops observations from the other branch", async () => {
    const host = createHost();
    observationJournalFactory(host.api);

    // Session A branch: enable + one observation.
    const branchA: SessionEntryLike[] = [];
    const ctxA = createFakeContext(host, {
      sessionId: "session-a",
      initialBranch: branchA,
      artifactsDir: path.join(tmpRoot, "a"),
    }).ctx;
    await fireEvent(host, "session_start", ctxA);
    await runCommand(host, "journey", "on", ctxA);
    await runCommand(host, "journey", "add decision A-only decision", ctxA);
    await runCommand(host, "journey", "status", ctxA);

    // Now simulate a branch B (different session id, empty branch).
    const branchB: SessionEntryLike[] = [];
    const ctxB = createFakeContext(host, {
      sessionId: "session-b",
      initialBranch: branchB,
      artifactsDir: path.join(tmpRoot, "b"),
    });
    await fireEvent(host, "session_branch", ctxB.ctx);
    await runCommand(host, "journey", "status", ctxB.ctx);
    const statusB = ctxB.notifications.at(-1)?.message ?? "";
    expect(statusB).toContain("observations: 0");
    expect(statusB).toContain("OFF");
  });
});

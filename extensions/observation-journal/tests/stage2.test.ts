// Stage 2 verification.
// SPEC §Stage 2: session.compacting appends observation context,
// gate=off suppresses injection, budget is enforced, /journey observe
// dispatches sendUserMessage without touching Mnemopi.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import observationJournalFactory from "../index.ts";
import { _resetStoresForTesting } from "../index.ts";
import {
  DEFAULT_CONFIG,
  OBSERVATION_TYPE,
  SEGMENT_TYPE,
  type CommandDefinition,
  type CompactingResult,
  type EventHandler,
  type ExtensionAPILike,
  type ExtensionContextLike,
  type SendMessageOptions,
  type SessionEntryLike,
} from "../types.ts";

interface HostRecord {
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, CommandDefinition>;
  api: ExtensionAPILike;
  appendedEntries: Array<{ customType: string; data: unknown }>;
  sentMessages: Array<{ content: string; options?: SendMessageOptions }>;
}

function createHost(): HostRecord {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, CommandDefinition>();
  const appendedEntries: HostRecord["appendedEntries"] = [];
  const sentMessages: HostRecord["sentMessages"] = [];
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
    sendUserMessage: (content, options) => {
      sentMessages.push({ content, options });
    },
  };
  return { handlers, commands, api, appendedEntries, sentMessages };
}

function createFakeContext(
  host: HostRecord,
  options: { sessionId?: string; artifactsDir?: string } = {},
): {
  ctx: ExtensionContextLike;
  branch: SessionEntryLike[];
  notifications: Array<{ message: string; level: string }>;
  memorySaveSpy: { count: number };
} {
  const branch: SessionEntryLike[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const memorySaveSpy = { count: 0 };
  const sessionId = options.sessionId ?? "session-stage2";
  const artifactsDir = options.artifactsDir;

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
      getSessionTitle: () => "stage 2 session",
      getLeafEntryId: () => branch.at(-1)?.id,
      getArtifactsDir: () => artifactsDir,
    },
  };
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

async function fireEvent<T>(
  host: HostRecord,
  name: string,
  ctx: ExtensionContextLike,
): Promise<T | undefined> {
  const list = host.handlers.get(name) ?? [];
  let last: unknown;
  for (const handler of list) {
    last = await handler(undefined, ctx);
  }
  return last as T | undefined;
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

describe("Stage 2 · Compaction Orientation", () => {

  beforeEach(() => { _resetStoresForTesting(); });
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-journal-s2-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test("gate off → session.compacting returns undefined", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx } = createFakeContext(host);
    await fireEvent(host, "session_start", ctx);
    const result = await fireEvent<CompactingResult>(
      host,
      "session.compacting",
      ctx,
    );
    expect(result).toBeUndefined();
  });

  test("gate on + observations → injection appended within budget", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, memorySaveSpy } = createFakeContext(host, {
      artifactsDir: path.join(tmpRoot, "a"),
    });
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(host, "journey", "add decision picked variant table", ctx);
    await runCommand(
      host,
      "journey",
      "add preference batch questions when possible",
      ctx,
    );
    await runCommand(
      host,
      "journey",
      "add open-question backend adapter open",
      ctx,
    );

    const result = await fireEvent<CompactingResult>(
      host,
      "session.compacting",
      ctx,
    );
    expect(result).toBeDefined();
    expect(result?.prompt).toBeUndefined();
    expect(result?.preserveData).toBeUndefined();
    expect(result?.context?.length).toBe(1);
    const injection = result?.context?.[0] ?? "";
    expect(injection).toContain("Observation Journal snapshot");
    expect(injection).toContain("picked variant table");
    expect(injection).toContain("batch questions when possible");
    expect(injection).toContain("backend adapter open");
    expect(new TextEncoder().encode(injection).length).toBeLessThanOrEqual(
      DEFAULT_CONFIG.compactInjectionBytes,
    );
    expect(memorySaveSpy.count).toBe(0);
  });

  test("session_compact appends a Post-compaction snapshot segment", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx } = createFakeContext(host, {
      artifactsDir: path.join(tmpRoot, "b"),
    });
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(host, "journey", "add fact something happened", ctx);
    await fireEvent(host, "session_compact", ctx);
    const segments = host.appendedEntries.filter(
      (entry) => entry.customType === SEGMENT_TYPE,
    );
    expect(segments.length).toBeGreaterThanOrEqual(1);
    const latest = segments.at(-1)?.data;
    expect(
      latest && typeof latest === "object" && "title" in latest
        ? String((latest as { title: unknown }).title)
        : "",
    ).toBe("Post-compaction snapshot");
  });

  test("/journey observe queues a nextTurn sendUserMessage and touches nothing else", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, memorySaveSpy } = createFakeContext(host);
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(host, "journey", "observe", ctx);
    expect(host.sentMessages.length).toBe(1);
    expect(host.sentMessages[0].options?.deliverAs).toBe("nextTurn");
    expect(host.sentMessages[0].content).toContain(
      "Observation Journal request",
    );
    expect(
      host.appendedEntries.filter((entry) => entry.customType === OBSERVATION_TYPE),
    ).toHaveLength(0);
    expect(memorySaveSpy.count).toBe(0);
  });

  test("compaction injection stays branch-local: switching branch drops it", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    // Branch A with observations.
    const ctxA = createFakeContext(host, {
      sessionId: "session-a",
      artifactsDir: path.join(tmpRoot, "a"),
    }).ctx;
    await fireEvent(host, "session_start", ctxA);
    await runCommand(host, "journey", "on", ctxA);
    await runCommand(host, "journey", "add decision branch-A only", ctxA);
    const resultA = await fireEvent<CompactingResult>(
      host,
      "session.compacting",
      ctxA,
    );
    expect(resultA?.context?.[0]).toContain("branch-A only");
    // Branch B: fresh state, injection must return undefined.
    const ctxB = createFakeContext(host, {
      sessionId: "session-b",
      artifactsDir: path.join(tmpRoot, "b"),
    }).ctx;
    await fireEvent(host, "session_branch", ctxB);
    const resultB = await fireEvent<CompactingResult>(
      host,
      "session.compacting",
      ctxB,
    );
    expect(resultB).toBeUndefined();
  });
});

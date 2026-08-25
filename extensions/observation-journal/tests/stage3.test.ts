// Stage 3 verification.
// SPEC §Stage 3: /journey promote writes to Mnemopi ONLY after confirm;
// /journey forget marks the observation as skipped; auto-retain is hard-off.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import observationJournalFactory from "../index.ts";
import { _resetStoresForTesting } from "../index.ts";
import {
  PROMOTION_TYPE,
  type CommandDefinition,
  type EventHandler,
  type ExtensionAPILike,
  type ExtensionContextLike,
  type MemoryLike,
  type PromotionRecord,
  type SelectChoice,
  type SendMessageOptions,
  type SessionEntryLike,
} from "../types.ts";

interface MemoryCall {
  content: string;
  metadata?: Record<string, unknown>;
}

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
    logger: { debug: () => {} },
  };
  return { handlers, commands, api, appendedEntries, sentMessages };
}

interface FakeContextOptions {
  sessionId?: string;
  artifactsDir?: string;
  confirmAnswer?: boolean;
  selectAnswer?: string | undefined;
  memory?: MemoryLike | null;
  memoryError?: Error;
  memoryReturnId?: string;
}

function createFakeContext(host: HostRecord, options: FakeContextOptions = {}) {
  const branch: SessionEntryLike[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const memoryCalls: MemoryCall[] = [];
  const widgetContent: string[] = [];
  const statusLines: string[] = [];
  const confirmPrompts: Array<{ title: string; message?: string }> = [];
  const selectPrompts: Array<{ title?: string; choices: SelectChoice[] }> = [];
  const sessionId = options.sessionId ?? "session-stage3";
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

  const memory: MemoryLike | undefined =
    options.memory === null
      ? undefined
      : (options.memory ?? {
          save: (payload) => {
            memoryCalls.push(payload);
            if (options.memoryError) return Promise.reject(options.memoryError);
            const id = options.memoryReturnId ?? `mem-${memoryCalls.length}`;
            return Promise.resolve({ id });
          },
        });

  const ctx: ExtensionContextLike = {
    hasUI: true,
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level: level ?? "info" });
      },
      confirm: (title, message) => {
        confirmPrompts.push({ title, message });
        return Promise.resolve(options.confirmAnswer ?? true);
      },
      select: (opts) => {
        selectPrompts.push({ title: opts.title, choices: opts.choices });
        return Promise.resolve(options.selectAnswer);
      },
      setStatus: (_key, text) => {
        statusLines.push(text);
      },
      setWidget: (opts) => {
        widgetContent.splice(0, widgetContent.length, ...opts.content);
      },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
      getSessionTitle: () => "stage 3 session",
      getLeafEntryId: () => branch.at(-1)?.id,
      getArtifactsDir: () => artifactsDir,
    },
    memory,
  };

  return {
    ctx,
    branch,
    notifications,
    memoryCalls,
    widgetContent,
    statusLines,
    confirmPrompts,
    selectPrompts,
  };
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

describe("Stage 3 · Mnemopi Promotion", () => {

  beforeEach(() => { _resetStoresForTesting(); });
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-journal-s3-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test("candidates returns nothing until mark-durable", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, notifications, memoryCalls } = createFakeContext(host);
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(host, "journey", "add decision test decision A", ctx);
    await runCommand(host, "journey", "candidates", ctx);
    expect(notifications.at(-1)?.message).toContain("No pending promotion candidates");
    expect(memoryCalls.length).toBe(0);
  });

  test("promote requires confirm and writes to memory on approval", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const {
      ctx,
      confirmPrompts,
      memoryCalls,
      notifications,
    } = createFakeContext(host, { confirmAnswer: true });
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(host, "journey", "add preference test preference X", ctx);
    const observationEntry = host.appendedEntries.find(
      (entry) => entry.customType === "com.omp.observation-journal.observation",
    );
    const observationData = observationEntry?.data;
    const observationId =
      observationData && typeof observationData === "object" && "id" in observationData
        ? String((observationData as { id: unknown }).id)
        : "";
    expect(observationId).toBeTruthy();
    await runCommand(host, "journey", `mark-durable ${observationId}`, ctx);
    await runCommand(host, "journey", `promote ${observationId}`, ctx);
    expect(confirmPrompts.length).toBe(1);
    expect(memoryCalls.length).toBe(1);
    expect(memoryCalls[0].content).toContain("test preference X");
    expect(memoryCalls[0].metadata?.sourceObservationId).toBe(observationId);
    const promotionEntries = host.appendedEntries.filter(
      (entry) => entry.customType === PROMOTION_TYPE,
    );
    expect(promotionEntries.length).toBe(1);
    const record = promotionEntries[0].data as PromotionRecord;
    expect(record.status).toBe("promoted");
    expect(record.memoryId).toBeDefined();
    expect(notifications.at(-1)?.message).toContain("promoted");
  });

  test("declining confirm records status=skipped and does NOT touch memory", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, memoryCalls } = createFakeContext(host, {
      confirmAnswer: false,
    });
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(host, "journey", "add preference to skip", ctx);
    const observationId = (
      host.appendedEntries.find(
        (entry) => entry.customType === "com.omp.observation-journal.observation",
      )?.data as { id: string }
    ).id;
    await runCommand(host, "journey", `mark-durable ${observationId}`, ctx);
    await runCommand(host, "journey", `promote ${observationId}`, ctx);
    expect(memoryCalls.length).toBe(0);
    const promotionEntries = host.appendedEntries.filter(
      (entry) => entry.customType === PROMOTION_TYPE,
    );
    expect(promotionEntries.length).toBe(1);
    expect((promotionEntries[0].data as PromotionRecord).status).toBe("skipped");
  });

  test("promote without id opens select dialog and honors cancellation", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, selectPrompts, memoryCalls, notifications } = createFakeContext(
      host,
      { selectAnswer: undefined },
    );
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(host, "journey", "add decision candidate C", ctx);
    const cId = (
      host.appendedEntries.find(
        (entry) => entry.customType === "com.omp.observation-journal.observation",
      )?.data as { id: string }
    ).id;
    await runCommand(host, "journey", `mark-durable ${cId}`, ctx);
    await runCommand(host, "journey", "promote", ctx);
    expect(selectPrompts.length).toBe(1);
    expect(selectPrompts[0].choices.some((c) => c.value === cId)).toBe(true);
    expect(memoryCalls.length).toBe(0);
    expect(notifications.at(-1)?.message).toContain("cancelled");
  });

  test("memory backend unavailable → status=failed, no crash", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, notifications } = createFakeContext(host, {
      memory: null,
      confirmAnswer: true,
    });
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(host, "journey", "add fact needs promo", ctx);
    const obsId = (
      host.appendedEntries.find(
        (entry) => entry.customType === "com.omp.observation-journal.observation",
      )?.data as { id: string }
    ).id;
    await runCommand(host, "journey", `mark-durable ${obsId}`, ctx);
    await runCommand(host, "journey", `promote ${obsId}`, ctx);
    const record = host.appendedEntries.find(
      (entry) => entry.customType === PROMOTION_TYPE,
    )?.data as PromotionRecord;
    expect(record.status).toBe("failed");
    expect(record.note).toContain("unavailable");
    expect(notifications.some((n) => n.message.includes("unavailable"))).toBe(true);
  });

  test("promote redacts secrets before writing to memory", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, memoryCalls } = createFakeContext(host, { confirmAnswer: true });
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(
      host,
      "journey",
      "add fact leaked sk-1234567890abcdef1234567890abcd token",
      ctx,
    );
    const obsId = (
      host.appendedEntries.find(
        (entry) => entry.customType === "com.omp.observation-journal.observation",
      )?.data as { id: string }
    ).id;
    await runCommand(host, "journey", `mark-durable ${obsId}`, ctx);
    await runCommand(host, "journey", `promote ${obsId}`, ctx);
    expect(memoryCalls.length).toBe(1);
    expect(memoryCalls[0].content).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(memoryCalls[0].content).toContain("[REDACTED");
  });

  test("forget marks candidate as skipped and disappears from candidates", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, notifications, memoryCalls } = createFakeContext(host, {
      confirmAnswer: true,
    });
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(host, "journey", "add fact will forget", ctx);
    const obsId = (
      host.appendedEntries.find(
        (entry) => entry.customType === "com.omp.observation-journal.observation",
      )?.data as { id: string }
    ).id;
    await runCommand(host, "journey", `mark-durable ${obsId}`, ctx);
    await runCommand(host, "journey", `forget ${obsId}`, ctx);
    await runCommand(host, "journey", "candidates", ctx);
    expect(memoryCalls.length).toBe(0);
    expect(notifications.at(-1)?.message).toContain("No pending promotion candidates");
  });

  test("widget and status reflect state", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, widgetContent, statusLines } = createFakeContext(host);
    await fireEvent(host, "session_start", ctx);
    expect(widgetContent[0]).toContain("off");
    await runCommand(host, "journey", "on", ctx);
    await runCommand(host, "journey", "add decision widget test", ctx);
    expect(widgetContent[0]).toContain("1 obs");
    expect(statusLines.at(-1)).toContain("1 obs");
  });

  test("trace records lifecycle and command events", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, notifications } = createFakeContext(host);
    await fireEvent(host, "session_start", ctx);
    await runCommand(host, "journey", "on", ctx);
    await runCommand(host, "journey", "add decision trace test", ctx);
    await runCommand(host, "journey", "trace", ctx);
    const last = notifications.at(-1)?.message ?? "";
    expect(last).toContain("session_start");
    expect(last).toContain("gate");
    expect(last).toContain("add.decision");
  });
});

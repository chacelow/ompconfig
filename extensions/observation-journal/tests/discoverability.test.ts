// Discoverability verification.
// Ensures TUI dropdowns and widget hints reveal how the extension is used.

import { describe, expect, test, beforeEach } from "bun:test";
import observationJournalFactory from "../index.ts";
import { _resetStoresForTesting } from "../index.ts";
import {
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

function createFakeContext(host: HostRecord) {
  const branch: SessionEntryLike[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const widgets: string[][] = [];
  const statusLines: string[] = [];
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
      setStatus: (_key, text) => {
        statusLines.push(text);
      },
      setWidget: (opts) => {
        widgets.push([...opts.content]);
      },
    },
    sessionManager: {
      getSessionId: () => "session-disco",
      getBranch: () => branch,
      getSessionTitle: () => "discoverability",
      getLeafEntryId: () => branch.at(-1)?.id,
      getArtifactsDir: () => undefined,
    },
  };
  return { ctx, notifications, widgets, statusLines };
}

async function fire(host: HostRecord, name: string, ctx: ExtensionContextLike) {
  const list = host.handlers.get(name) ?? [];
  for (const handler of list) await handler(undefined, ctx);
}

async function runCommand(
  host: HostRecord,
  args: string,
  ctx: ExtensionContextLike,
): Promise<void> {
  const definition = host.commands.get("journey");
  if (!definition) throw new Error("journey command not registered");
  await definition.handler(args, ctx);
}

describe("Discoverability", () => {

  beforeEach(() => { _resetStoresForTesting(); });
  test("registers /journey with getArgumentCompletions", () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const definition = host.commands.get("journey");
    expect(definition).toBeDefined();
    expect(typeof definition?.getArgumentCompletions).toBe("function");
    const completions = definition?.getArgumentCompletions?.("");
    expect(Array.isArray(completions) ? completions.length : 0).toBeGreaterThan(10);
    const labels = (completions as Array<{ label: string }>).map((c) => c.label);
    for (const expected of [
      "on", "off", "toggle", "status", "show",
      "add", "mark-durable", "flush", "export",
      "observe", "candidates", "promote", "forget",
      "trace", "dump", "help",
    ]) {
      expect(labels).toContain(expected);
    }
  });



  test("/journey help prints every subcommand and category", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, notifications } = createFakeContext(host);
    await fire(host, "session_start", ctx);
    await runCommand(host, "help", ctx);
    const body = notifications.at(-1)?.message ?? "";
    for (const line of [
      "/journey on | off | toggle",
      "/journey add <分类>",
      "/journey mark-durable",
      "/journey flush",
      "/journey export",
      "/journey observe",
      "/journey candidates",
      "/journey promote",
      "/journey forget",
      "/journey trace",
      "/journey dump",
      "fact",
      "decision",
      "preference",
      "failed-attempt",
      "deviation",
      "constraint",
      "open-question",
    ]) {
      expect(body).toContain(line);
    }
  });
});

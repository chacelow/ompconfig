// Discoverability verification.
// Ensures TUI dropdowns and widget hints reveal how the extension is used.

import { describe, expect, test } from "bun:test";
import observationJournalFactory from "../index.ts";
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
  test("journey command registers input hint + full subcommand catalog", () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const definition = host.commands.get("journey");
    expect(definition).toBeDefined();
    expect(definition?.input?.hint).toBeDefined();
    expect(definition?.input?.hint).toContain("on|off");
    expect(definition?.subcommands).toBeDefined();
    const names = (definition?.subcommands ?? []).map((s) => s.name);
    for (const expected of [
      "on",
      "off",
      "toggle",
      "status",
      "show",
      "add",
      "mark-durable",
      "flush",
      "export",
      "observe",
      "candidates",
      "promote",
      "forget",
      "trace",
      "dump",
      "help",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("gate=off widget invites the user to enable", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, widgets } = createFakeContext(host);
    await fire(host, "session_start", ctx);
    const last = widgets.at(-1) ?? [];
    expect(last.join(" ")).toContain("off");
    expect(last.join(" ")).toContain("/journey on");
  });

  test("gate=on widget renders category histogram", async () => {
    const host = createHost();
    observationJournalFactory(host.api);
    const { ctx, widgets } = createFakeContext(host);
    await fire(host, "session_start", ctx);
    await runCommand(host, "on", ctx);
    await runCommand(host, "add decision alpha decision", ctx);
    await runCommand(host, "add preference alpha preference", ctx);
    await runCommand(host, "add open-question alpha question", ctx);
    const last = widgets.at(-1) ?? [];
    const joined = last.join(" ");
    expect(joined).toContain("3 obs");
    expect(joined).toContain("D1");
    expect(joined).toContain("P1");
    expect(joined).toContain("?1");
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
      "/journey add <cat>",
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

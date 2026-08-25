/**
 * Consolidator's sandboxed file tools, registered ONCE into the master
 * OMP extension. In-process migration of `agent/consolidator/tools.ts`.
 *
 * Design carry-over from pi-om Phase B design risk 6:
 *   * Consolidator MAY only read/write inside .memory/<sid>/. A model that
 *     tries to escape the root gets an explicit "path escapes .memory/"
 *     error, never a filesystem operation on the user's project.
 *
 * In-process differences from the subprocess original:
 *   * Tools are prefixed `om_` so they never shadow OMP's built-in
 *     read/write/edit/grep/glob. The main agent keeps its native tools;
 *     the consolidator subagent gets only these.
 *   * The sandbox root is set by the dispatcher just before spawning the
 *     consolidator (`setConsolidatorRoot`) and cleared afterwards.
 *     Consolidator concurrency is strictly 1 (Runtime.consolidatorInFlight
 *     guard), so a module-level active root is race-free.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { atomicWrite } from "./memory/paths.js";

type ToolText = { content: { type: "text"; text: string }[]; details: unknown };

function ok(text: string, details: unknown = {}): ToolText {
  return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string): ToolText {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: { error: true } };
}

let currentRoot: string | undefined;

/** Set the active sandbox root before spawning the consolidator subagent. */
export function setConsolidatorRoot(root: string): void {
  currentRoot = resolve(root);
}

/** Clear the active root after the consolidator subagent returns. */
export function clearConsolidatorRoot(): void {
  currentRoot = undefined;
}

function requireRoot(): string | undefined {
  return currentRoot;
}

function scoped(root: string, requested: string): string | undefined {
  const abs = resolve(root, requested);
  const rel = relative(root, abs);
  if (rel === "") return abs;
  if (rel.startsWith("..")) return undefined;
  return abs;
}

// Every path parameter accepts either `foo.md` (implicitly under .memory/) or
// `.memory/foo.md` (verbatim). The `.memory/` prefix is stripped by scoped().

const ReadSchema = Type.Object({
  path: Type.String({ description: "Path inside .memory/, e.g. 'auth.md' or '.memory/auth.md'." }),
});
const WriteSchema = Type.Object({
  path: Type.String({ description: "Path inside .memory/ to (over)write, e.g. 'auth.md'." }),
  content: Type.String({ description: "Full file content, including YAML front-matter." }),
});
const EditSchema = Type.Object({
  path: Type.String({ description: "Path inside .memory/ to edit." }),
  oldText: Type.String({ description: "Exact text to replace (must occur exactly once)." }),
  newText: Type.String({ description: "Replacement text." }),
});
const LsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Subdirectory inside .memory/. Defaults to .memory/ root." })),
});
const GrepSchema = Type.Object({
  pattern: Type.String({ description: "JavaScript regular expression to search for." }),
  path: Type.Optional(Type.String({ description: "Restrict to this file/subdir inside .memory/." })),
});

type ReadInput = Static<typeof ReadSchema>;
type WriteInput = Static<typeof WriteSchema>;
type EditInput = Static<typeof EditSchema>;
type LsInput = Static<typeof LsSchema>;
type GrepInput = Static<typeof GrepSchema>;

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

/**
 * Register the consolidator's scoped file tools (om_read/write/edit/ls/grep),
 * all confined to the currently-active .memory/<sid>/ root. Call once at
 * extension init.
 */
export function registerConsolidatorTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "om_read",
    label: "Read memory file",
    description: "Read a topic file under .memory/.",
    parameters: ReadSchema,
    async execute(_id: string, params: ReadInput): Promise<ToolText> {
      const root = requireRoot();
      if (!root) return fail("consolidator sandbox not active");
      const abs = scoped(root, params.path);
      if (!abs) return fail("path escapes .memory/");
      if (!existsSync(abs)) return fail(`no such file: ${params.path}`);
      return ok(readFileSync(abs, "utf-8"));
    },
  });

  pi.registerTool({
    name: "om_write",
    label: "Write memory file",
    description: "Create or overwrite a topic file under .memory/ (atomic). Do not write INDEX.md.",
    parameters: WriteSchema,
    async execute(_id: string, params: WriteInput): Promise<ToolText> {
      const root = requireRoot();
      if (!root) return fail("consolidator sandbox not active");
      const abs = scoped(root, params.path);
      if (!abs) return fail("path escapes .memory/");
      if (/(^|\/)INDEX\.md$/i.test(params.path)) return fail("INDEX.md is generated automatically; do not write it");
      atomicWrite(abs, params.content);
      return ok(`Wrote ${params.path} (${params.content.length} bytes).`);
    },
  });

  pi.registerTool({
    name: "om_edit",
    label: "Edit memory file",
    description: "Replace an exact substring in a topic file under .memory/ (atomic).",
    parameters: EditSchema,
    async execute(_id: string, params: EditInput): Promise<ToolText> {
      const root = requireRoot();
      if (!root) return fail("consolidator sandbox not active");
      const abs = scoped(root, params.path);
      if (!abs) return fail("path escapes .memory/");
      if (/(^|\/)INDEX\.md$/i.test(params.path)) return fail("INDEX.md is generated automatically; do not edit it");
      if (!existsSync(abs)) return fail(`no such file: ${params.path}`);
      const current = readFileSync(abs, "utf-8");
      const occurrences = current.split(params.oldText).length - 1;
      if (occurrences === 0) return fail("oldText not found");
      if (occurrences > 1) return fail(`oldText is ambiguous (${occurrences} matches); add more context`);
      atomicWrite(abs, current.replace(params.oldText, params.newText));
      return ok(`Edited ${params.path}.`);
    },
  });

  pi.registerTool({
    name: "om_ls",
    label: "List memory files",
    description: "List files under .memory/.",
    parameters: LsSchema,
    async execute(_id: string, params: LsInput): Promise<ToolText> {
      const root = requireRoot();
      if (!root) return fail("consolidator sandbox not active");
      const abs = scoped(root, params.path ?? ".");
      if (!abs) return fail("path escapes .memory/");
      if (!existsSync(abs)) return ok("(.memory/ is empty)");
      const entries = readdirSync(abs).filter((n) => !n.startsWith("."));
      return ok(entries.length > 0 ? entries.sort().join("\n") : "(empty)");
    },
  });

  pi.registerTool({
    name: "om_grep",
    label: "Search memory files",
    description: "Search topic files under .memory/ with a regular expression.",
    parameters: GrepSchema,
    async execute(_id: string, params: GrepInput): Promise<ToolText> {
      const root = requireRoot();
      if (!root) return fail("consolidator sandbox not active");
      let re: RegExp;
      try {
        re = new RegExp(params.pattern);
      } catch (e) {
        return fail(`invalid regex: ${(e as Error).message}`);
      }
      const base = scoped(root, params.path ?? ".");
      if (!base) return fail("path escapes .memory/");
      if (!existsSync(base)) return ok("(no matches)");
      const files = statSync(base).isDirectory() ? listFilesRecursive(base) : [base];
      const hits: string[] = [];
      for (const file of files) {
        const lines = readFileSync(file, "utf-8").split("\n");
        const relPath = relative(root, file);
        lines.forEach((line, i) => {
          if (re.test(line)) hits.push(`${relPath}:${i + 1}: ${line.trim()}`);
        });
        if (hits.length >= 200) break;
      }
      return ok(hits.length > 0 ? hits.join("\n") : "(no matches)");
    },
  });
}

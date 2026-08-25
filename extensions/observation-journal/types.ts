// Observation Journal — data model + host contract types.
// SPEC: extensions/observation-journal/SPEC.md §3.

export const NAMESPACE = "com.omp.observation-journal";
export const ENABLED_TYPE = `${NAMESPACE}.enabled`;
export const OBSERVATION_TYPE = `${NAMESPACE}.observation`;
export const CURSOR_TYPE = `${NAMESPACE}.cursor`;
export const SEGMENT_TYPE = `${NAMESPACE}.journey-segment`;
export const PROMOTION_TYPE = `${NAMESPACE}.promotion`;

export const OBSERVATION_CATEGORIES = [
  "fact",
  "decision",
  "preference",
  "failed-attempt",
  "deviation",
  "constraint",
  "open-question",
] as const;

export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

export const MAX_CONTENT_CHARS = 400;
export const MAX_SEGMENT_BODY_CHARS = 800;

export interface Observation {
  id: string;
  timestamp: string;
  sessionId: string;
  category: ObservationCategory;
  content: string;
  evidenceEntryIds: string[];
  durable: boolean;
  source: "manual" | "subagent";
}

export interface Cursor {
  coversUpToEntryId: string;
  tokensSince: number;
}

export interface JourneySegment {
  id: string;
  timestamp: string;
  title: string;
  body: string;
  sourceObservationIds: string[];
}

export type PromotionStatus =
  | "pending"
  | "promoted"
  | "skipped"
  | "failed";

export interface PromotionRecord {
  observationId: string;
  memoryId?: string;
  status: PromotionStatus;
  note?: string;
  reviewedAt: string;
}

export interface JournalState {
  enabled: boolean;
  sessionId: string;
  observations: Observation[];
  segments: JourneySegment[];
  cursor?: Cursor;
  promotions: Map<string, PromotionRecord>;
}

export interface JournalConfig {
  observeEveryTokens: number;
  journeyMaxSegments: number;
  recentObservationsMax: number;
  journeyTargetBytes: number;
  compactInjectionBytes: number;
  promotion: {
    autoRetainMatched: boolean;
    autoWhitelistPatterns: string[];
  };
}

export const DEFAULT_CONFIG: JournalConfig = {
  observeEveryTokens: 6000,
  journeyMaxSegments: 20,
  recentObservationsMax: 30,
  journeyTargetBytes: 8192,
  compactInjectionBytes: 3072,
  promotion: {
    autoRetainMatched: false,
    autoWhitelistPatterns: [],
  },
};

export function isObservationCategory(
  value: string,
): value is ObservationCategory {
  return (OBSERVATION_CATEGORIES as readonly string[]).includes(value);
}

// ---------- Host contract types (what we use from OMP's ExtensionAPI/ctx) ----------
//
// We deliberately model only the surface Observation Journal touches. This
// keeps the extension isolated from OMP internals and lets tests supply a
// small in-memory fake instead of importing the real package.

export interface SessionEntryLike {
  type: string;
  id?: string;
  customType?: string;
  data?: unknown;
}

export interface SessionManagerLike {
  getSessionId?: () => string;
  getBranch?: () => readonly SessionEntryLike[];
  getSessionTitle?: () => string;
  getSessionName?: () => string;
  getLeafEntryId?: () => string | undefined;
  getLastEntryId?: () => string | undefined;
  getArtifactsDir?: () => string | undefined;
  artifactsDir?: string;
}

export type SelectChoice = { label: string; value: string; description?: string };

export interface UiLike {
  notify?: (message: string, level?: "info" | "warn" | "error") => void;
  editor?: (options: {
    title?: string;
    content?: string;
    readOnly?: boolean;
  }) => Promise<void>;
  confirm?: (title: string, message?: string) => Promise<boolean>;
  select?: (options: {
    title?: string;
    message?: string;
    choices: SelectChoice[];
  }) => Promise<string | undefined>;
  setStatus?: (key: string, text: string) => void;
  setWidget?: (options: {
    placement?: "aboveEditor" | "belowEditor";
    content: string[];
  }) => void;
}

export interface MemoryLike {
  save?: (payload: {
    content: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ id?: string } | void>;
  status?: () => Promise<{ ready?: boolean; backend?: string }>;
}

export interface LoggerLike {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface SettingsLike {
  get?: (name: string) => unknown;
}

export interface ExtensionContextLike {
  hasUI?: boolean;
  ui?: UiLike;
  sessionManager?: SessionManagerLike;
  settings?: SettingsLike;
  getSetting?: (name: string) => unknown;
  artifactsDir?: string;
  memory?: MemoryLike;
}

export interface CommandDefinition {
  description: string;
  handler: (args: string, ctx: ExtensionContextLike) => Promise<void> | void;
}

export type EventHandler = (
  event: unknown,
  ctx: ExtensionContextLike,
) => unknown;

export interface SendMessageOptions {
  deliverAs?: "steer" | "followUp" | "nextTurn";
  triggerTurn?: boolean;
}

export type CompactingResult = {
  context?: string[];
  prompt?: string;
  preserveData?: Record<string, unknown>;
};

export interface ExtensionAPILike {
  on: (event: string, handler: EventHandler) => void;
  registerCommand: (name: string, definition: CommandDefinition) => void;
  appendEntry: (customType: string, data: unknown) => void;
  setLabel?: (label: string) => void;
  sendUserMessage?: (
    content: string,
    options?: SendMessageOptions,
  ) => Promise<void> | void;
  sendMessage?: (
    message: string,
    options?: SendMessageOptions,
  ) => Promise<void> | void;
  logger?: LoggerLike;
}

// Observation Journal — redaction.
// SPEC: extensions/observation-journal/SPEC.md §6.2.
//
// Every string written to Observation.content, JourneySegment.body, or the
// Compaction injection MUST pass through `redactSecrets`. Bypassing this
// function on any new write path is a bug.

type Rule = {
  label: string;
  pattern: RegExp;
  replace: (match: string) => string;
};

const RULES: Rule[] = [
  {
    label: "GITHUB_TOKEN",
    pattern: /gho_[A-Za-z0-9]{16,}/g,
    replace: () => "[REDACTED:GITHUB_TOKEN]",
  },
  {
    label: "GITHUB_TOKEN",
    pattern: /ghp_[A-Za-z0-9]{16,}/g,
    replace: () => "[REDACTED:GITHUB_TOKEN]",
  },
  {
    label: "GITHUB_PAT",
    pattern: /github_pat_[A-Za-z0-9_]{16,}/g,
    replace: () => "[REDACTED:GITHUB_PAT]",
  },
  {
    label: "OPENAI_KEY",
    pattern: /sk-[A-Za-z0-9_\-]{20,}/g,
    replace: () => "[REDACTED:OPENAI_KEY]",
  },
  {
    label: "AWS_KEY",
    pattern: /AKIA[0-9A-Z]{16}/g,
    replace: () => "[REDACTED:AWS_KEY]",
  },
  {
    label: "PRIVATE_KEY",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    replace: () => "[REDACTED:PRIVATE_KEY]",
  },
  {
    label: "BEARER",
    pattern: /Bearer\s+[A-Za-z0-9\-_.=]{8,}/g,
    replace: () => "Bearer [REDACTED]",
  },
  {
    label: "AUTHORIZATION_HEADER",
    pattern: /Authorization:\s*[^\r\n]+/gi,
    replace: () => "Authorization: [REDACTED]",
  },
  {
    label: "PASSWORD",
    pattern: /(password)\s*[=:]\s*\S+/gi,
    replace: (match) => match.replace(/[=:]\s*\S+/, "= [REDACTED]"),
  },
  {
    label: "API_KEY",
    pattern: /(api[_-]?key)\s*[=:]\s*\S+/gi,
    replace: (match) => match.replace(/[=:]\s*\S+/, "= [REDACTED]"),
  },
  {
    label: "SLACK_TOKEN",
    pattern: /xox[baprs]-[A-Za-z0-9\-]{10,}/g,
    replace: () => "[REDACTED:SLACK_TOKEN]",
  },
  {
    label: "GOOGLE_OAUTH",
    pattern: /ya29\.[A-Za-z0-9_\-]{20,}/g,
    replace: () => "[REDACTED:GOOGLE_OAUTH]",
  },
];

/**
 * Redact known secret patterns from a raw string.
 *
 * @param raw - the untrusted string to sanitize.
 * @returns a string with matched secrets replaced by labeled placeholders.
 */
export function redactSecrets(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return raw ?? "";
  let out = raw;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match) => rule.replace(match));
  }
  return out;
}

/**
 * Test-only accessor: exposes the labels for coverage assertions.
 * Not part of the runtime contract.
 */
export function _internalListLabels(): string[] {
  return RULES.map((rule) => rule.label);
}

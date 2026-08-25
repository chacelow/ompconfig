import { describe, expect, test } from "bun:test";
import {
  _internalListLabels,
  redactSecrets,
} from "../redaction.ts";

const SAMPLES: Record<string, { input: string; mustNotContain: RegExp }> = {
  GITHUB_TOKEN_GHO: {
    input: "found gho_1234567890abcdef1234 in .env",
    mustNotContain: /gho_[A-Za-z0-9]{16,}/,
  },
  GITHUB_TOKEN_GHP: {
    input: "ghp_abcdefghijklmnopqrstuvwxyz1234",
    mustNotContain: /ghp_[A-Za-z0-9]{16,}/,
  },
  GITHUB_PAT: {
    input: "github_pat_ABCDEFGHIJKLMNOPQRSTUV_more",
    mustNotContain: /github_pat_[A-Za-z0-9_]{16,}/,
  },
  OPENAI_KEY: {
    input: "sk-1234567890abcdef1234567890abcd",
    mustNotContain: /sk-[A-Za-z0-9_-]{20,}/,
  },
  AWS_KEY: {
    input: "creds=AKIA1234567890ABCDEF",
    mustNotContain: /AKIA[0-9A-Z]{16}/,
  },
  PRIVATE_KEY: {
    input:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----",
    mustNotContain: /BEGIN[^\n]*PRIVATE KEY/,
  },
  BEARER: {
    input: "Bearer abcdefghijklmnopqrstuv",
    mustNotContain: /Bearer\s+[A-Za-z0-9\-_.=]{8,}/,
  },
  AUTHORIZATION_HEADER: {
    input: "Authorization: Basic Zm9vOmJhcg==",
    mustNotContain: /Authorization:\s+(?!\[REDACTED)/,
  },
  PASSWORD: {
    input: "password = hunter2secret",
    mustNotContain: /password\s*[=:]\s*(?!\[REDACTED)hunter2secret/,
  },
  API_KEY: {
    input: "api_key: XyZ1234567890",
    mustNotContain: /api_key\s*[=:]\s*XyZ1234567890/,
  },
  SLACK_TOKEN: {
    input: "xoxb-1234567890-abcdefg",
    mustNotContain: /xox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  GOOGLE_OAUTH: {
    input: "ya29.a0AfHRUZ1234567890abcdef",
    mustNotContain: /ya29\.[A-Za-z0-9_-]{20,}/,
  },
};

describe("redactSecrets", () => {
  for (const [label, sample] of Object.entries(SAMPLES)) {
    test(`redacts ${label}`, () => {
      const output = redactSecrets(sample.input);
      expect(output).not.toMatch(sample.mustNotContain);
      expect(output).toContain("[REDACTED");
    });
  }

  test("does not mutate benign text", () => {
    const benign = "This is a normal sentence about design decisions.";
    expect(redactSecrets(benign)).toBe(benign);
  });

  test("empty and null-ish inputs are safe", () => {
    expect(redactSecrets("")).toBe("");
    // @ts-expect-error runtime guard for defensive callers
    expect(redactSecrets(undefined)).toBe("");
  });

  test("rule labels cover the SPEC redaction surface", () => {
    const labels = _internalListLabels();
    for (const expected of [
      "GITHUB_TOKEN",
      "GITHUB_PAT",
      "OPENAI_KEY",
      "AWS_KEY",
      "PRIVATE_KEY",
      "BEARER",
      "AUTHORIZATION_HEADER",
      "PASSWORD",
      "API_KEY",
      "SLACK_TOKEN",
      "GOOGLE_OAUTH",
    ]) {
      expect(labels).toContain(expected);
    }
  });
});

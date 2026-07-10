import { describe, expect, it } from "vitest";
import type { SettingsRow } from "@/db/schema";
import {
  deriveJiraAuth,
  isJiraConfigured,
  parseProjectKeys,
} from "@/lib/settings";

function makeRow(patch: Partial<SettingsRow>): SettingsRow {
  return {
    jiraUrl: null,
    jiraUser: null,
    jiraToken: null,
    jiraPassword: null,
    ...patch,
  } as unknown as SettingsRow;
}

describe("parseProjectKeys", () => {
  it("uppercases, trims, and drops empties", () => {
    expect(parseProjectKeys('[" txr ","demo"]')).toEqual(["TXR", "DEMO"]);
    expect(parseProjectKeys('["txr","",123]')).toEqual(["TXR"]);
  });

  it("returns [] for null / invalid / non-array JSON", () => {
    expect(parseProjectKeys(null)).toEqual([]);
    expect(parseProjectKeys("nope")).toEqual([]);
    expect(parseProjectKeys('{"a":1}')).toEqual([]);
  });
});

describe("deriveJiraAuth", () => {
  it("builds auth from user + token", () => {
    expect(
      deriveJiraAuth(makeRow({ jiraUser: "me@example.com", jiraToken: "tok" })),
    ).toEqual({ user: "me@example.com", password: "tok" });
  });

  it("falls back to the legacy password column", () => {
    expect(
      deriveJiraAuth(makeRow({ jiraUser: "me@example.com", jiraPassword: "pw" })),
    ).toEqual({ user: "me@example.com", password: "pw" });
  });

  it("prefers the token over the legacy password", () => {
    expect(
      deriveJiraAuth(
        makeRow({ jiraUser: "u", jiraToken: "tok", jiraPassword: "pw" }),
      ),
    ).toEqual({ user: "u", password: "tok" });
  });

  it("returns null when user or secret is missing", () => {
    expect(deriveJiraAuth(makeRow({ jiraToken: "tok" }))).toBeNull();
    expect(deriveJiraAuth(makeRow({ jiraUser: "u" }))).toBeNull();
  });
});

describe("isJiraConfigured", () => {
  it("requires both a URL and derivable auth", () => {
    expect(
      isJiraConfigured(
        makeRow({
          jiraUrl: "https://x.atlassian.net",
          jiraUser: "u",
          jiraToken: "tok",
        }),
      ),
    ).toBe(true);
    expect(
      isJiraConfigured(makeRow({ jiraUser: "u", jiraToken: "tok" })),
    ).toBe(false);
    expect(
      isJiraConfigured(makeRow({ jiraUrl: "https://x.atlassian.net" })),
    ).toBe(false);
  });
});

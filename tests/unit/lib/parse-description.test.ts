import { describe, expect, it } from "vitest";
import { parseDescription } from "@/lib/parse-description";

describe("parseDescription", () => {
  it("splits memo / issue key / comment", () => {
    const r = parseDescription("Fixed the bug TXR-123 review comments", ["TXR"]);
    expect(r).toMatchObject({
      memo: "Fixed the bug",
      issueKey: "TXR-123",
      comment: "review comments",
    });
    expect(r.raw).toBe("Fixed the bug TXR-123 review comments");
  });

  it("uppercases a lowercase key match", () => {
    const r = parseDescription("txr-7 done", ["TXR"]);
    expect(r.issueKey).toBe("TXR-7");
    expect(r.memo).toBe("");
    expect(r.comment).toBe("done");
  });

  it("matches any of several project keys", () => {
    expect(parseDescription("DEMO-5 hi", ["TXR", "DEMO"]).issueKey).toBe(
      "DEMO-5",
    );
  });

  it("falls back to raw when no key is present", () => {
    const r = parseDescription("just some notes", ["TXR"]);
    expect(r.issueKey).toBeUndefined();
    expect(r.memo).toBe("just some notes");
    expect(r.comment).toBe("just some notes");
  });

  it("does not match when no project keys are configured", () => {
    expect(parseDescription("TXR-1 x", []).issueKey).toBeUndefined();
  });

  it("greedily prefers the last key occurrence as the issue", () => {
    const r = parseDescription("TXR-1 TXR-2 done", ["TXR"]);
    expect(r.memo).toBe("TXR-1");
    expect(r.issueKey).toBe("TXR-2");
    expect(r.comment).toBe("done");
  });

  it("handles an empty description", () => {
    const r = parseDescription("", ["TXR"]);
    expect(r).toEqual({ raw: "", memo: "", issueKey: undefined, comment: "" });
  });
});

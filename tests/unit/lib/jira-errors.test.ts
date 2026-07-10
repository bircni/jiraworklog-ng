import { describe, expect, it } from "vitest";
import { formatJiraFetchError } from "@/lib/jira/fetch-error";
import { formatJiraHttpErrorBody } from "@/lib/jira/format-http-error";

describe("formatJiraHttpErrorBody", () => {
  it("returns the bare status line for an empty body", () => {
    expect(formatJiraHttpErrorBody(404, "Not Found", "")).toBe(
      "HTTP 404 Not Found",
    );
  });

  it("appends Jira errorMessages", () => {
    expect(
      formatJiraHttpErrorBody(
        400,
        "Bad Request",
        JSON.stringify({ errorMessages: ["boom", "again"] }),
      ),
    ).toBe("HTTP 400 Bad Request — boom; again");
  });

  it("appends field errors", () => {
    expect(
      formatJiraHttpErrorBody(
        400,
        "Bad Request",
        JSON.stringify({ errors: { timeSpent: "required" } }),
      ),
    ).toBe("HTTP 400 Bad Request — timeSpent: required");
  });

  it("falls back to the raw body when it is not structured JSON", () => {
    expect(formatJiraHttpErrorBody(500, "Server Error", "upstream exploded")).toBe(
      "HTTP 500 Server Error — upstream exploded",
    );
    expect(
      formatJiraHttpErrorBody(500, "Server Error", JSON.stringify({ other: 1 })),
    ).toContain('HTTP 500 Server Error — {"other":1}');
  });
});

describe("formatJiraFetchError", () => {
  it("gives a TLS/certificate hint for cert failures", () => {
    const msg = formatJiraFetchError(
      new Error("unable to verify the first certificate"),
    );
    expect(msg).toContain("TLS/Zertifikat");
    expect(msg).toContain("unable to verify the first certificate");
  });

  it("treats a generic fetch failure as a TLS hint", () => {
    expect(formatJiraFetchError(new Error("fetch failed"))).toContain(
      "TLS/Zertifikat",
    );
  });

  it("gives a plain connection hint for other errors", () => {
    const msg = formatJiraFetchError(new Error("boom"));
    expect(msg).toContain("Bitte Jira-URL prüfen");
    expect(msg).toContain("boom");
  });

  it("includes a chained cause and handles non-Error values", () => {
    const err = new Error("outer");
    err.cause = new Error("inner certificate problem");
    expect(formatJiraFetchError(err)).toContain("inner certificate problem");
    expect(formatJiraFetchError("weird string")).toContain("weird string");
  });
});

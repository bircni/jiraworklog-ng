import { describe, expect, it } from "vitest";
import {
  dayKey,
  formatDurationHoursMinutes,
  formatHm,
  formatHms,
  formatSignedHm,
  formatSignedHmInput,
  parseSignedHm,
} from "@/lib/format";

describe("formatHms", () => {
  it("pads to hh:mm:ss", () => {
    expect(formatHms(0)).toBe("00:00:00");
    expect(formatHms(3661)).toBe("01:01:01");
  });

  it("does not cap hours at 24", () => {
    expect(formatHms(25 * 3600)).toBe("25:00:00");
  });

  it("floors fractional seconds and clamps negatives to zero", () => {
    expect(formatHms(59.9)).toBe("00:00:59");
    expect(formatHms(-10)).toBe("00:00:00");
  });
});

describe("formatHm", () => {
  it("rounds minutes and clamps negatives", () => {
    expect(formatHm(0)).toBe("00:00");
    expect(formatHm(90)).toBe("01:30");
    expect(formatHm(89.6)).toBe("01:30");
    expect(formatHm(-5)).toBe("00:00");
  });
});

describe("formatSignedHm / formatSignedHmInput", () => {
  it("uses a unicode minus for display, ascii for input", () => {
    expect(formatSignedHm(90)).toBe("+01:30");
    expect(formatSignedHm(-90)).toBe("−01:30");
    expect(formatSignedHm(0)).toBe("+00:00");
    expect(formatSignedHmInput(-90)).toBe("-01:30");
    expect(formatSignedHmInput(90)).toBe("+01:30");
  });
});

describe("parseSignedHm", () => {
  it("parses signed and unsigned hh:mm", () => {
    expect(parseSignedHm("01:30")).toBe(90);
    expect(parseSignedHm("+01:30")).toBe(90);
    expect(parseSignedHm("-01:30")).toBe(-90);
    expect(parseSignedHm("−01:30")).toBe(-90);
    expect(parseSignedHm("1:30")).toBe(90);
    expect(parseSignedHm("  +2:05 ")).toBe(125);
  });

  it("parses unsigned multi-digit hours (regression: sign class must not be a range)", () => {
    // `[+-−]` was an accidental char range that ate the first hour digit,
    // making "12:30" resolve to 150 and "100:00" to 0.
    expect(parseSignedHm("12:30")).toBe(750);
    expect(parseSignedHm("100:00")).toBe(6000);
  });

  it("returns null on invalid input", () => {
    expect(parseSignedHm("01:60")).toBeNull();
    expect(parseSignedHm("1:5")).toBeNull();
    expect(parseSignedHm("abc")).toBeNull();
    expect(parseSignedHm("")).toBeNull();
  });
});

describe("formatDurationHoursMinutes", () => {
  it("renders Jira timeSpent format", () => {
    expect(formatDurationHoursMinutes(45)).toBe("45m");
    expect(formatDurationHoursMinutes(60)).toBe("1h 0m");
    expect(formatDurationHoursMinutes(90)).toBe("1h 30m");
    expect(formatDurationHoursMinutes(125)).toBe("2h 5m");
    expect(formatDurationHoursMinutes(0)).toBe("0m");
  });
});

describe("dayKey", () => {
  it("returns the local calendar day for a Date", () => {
    expect(dayKey(new Date(2026, 4, 19, 10, 30))).toBe("2026-05-19");
    expect(dayKey(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });

  it("uses local time for a datetime ISO string", () => {
    expect(dayKey("2026-05-19T23:15:00")).toBe("2026-05-19");
  });
});

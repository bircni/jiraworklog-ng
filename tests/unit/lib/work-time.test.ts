import { describe, expect, it } from "vitest";
import {
  breakOverlapSeconds,
  effectiveDurationSeconds,
  parseBreaks,
} from "@/lib/work-time";

describe("parseBreaks", () => {
  it("returns [] for empty / invalid input", () => {
    expect(parseBreaks(null)).toEqual([]);
    expect(parseBreaks(undefined)).toEqual([]);
    expect(parseBreaks("")).toEqual([]);
    expect(parseBreaks("not json")).toEqual([]);
    expect(parseBreaks('{"start":"12:00"}')).toEqual([]); // not an array
  });

  it("keeps only well-formed windows and strips extra props", () => {
    expect(
      parseBreaks('[{"start":"12:00","end":"12:30","note":"lunch"}]'),
    ).toEqual([{ start: "12:00", end: "12:30" }]);
    expect(parseBreaks('[{"start":"12:00","end":"nope"}]')).toEqual([]);
  });
});

describe("breakOverlapSeconds", () => {
  const day = (h: number, m: number) => new Date(2026, 4, 19, h, m, 0, 0);

  it("returns 0 without breaks or for a zero/negative span", () => {
    expect(breakOverlapSeconds(day(12, 0), day(13, 0), [])).toBe(0);
    expect(
      breakOverlapSeconds(day(13, 0), day(12, 0), [{ start: "12:15", end: "12:45" }]),
    ).toBe(0);
  });

  it("counts the overlapping portion of a break window", () => {
    expect(
      breakOverlapSeconds(day(12, 0), day(13, 0), [{ start: "12:15", end: "12:45" }]),
    ).toBe(30 * 60);
  });

  it("counts the full break when the entry contains it and 0 when disjoint", () => {
    expect(
      breakOverlapSeconds(day(9, 0), day(17, 0), [{ start: "12:00", end: "12:30" }]),
    ).toBe(30 * 60);
    expect(
      breakOverlapSeconds(day(14, 0), day(15, 0), [{ start: "12:00", end: "12:30" }]),
    ).toBe(0);
  });
});

describe("effectiveDurationSeconds", () => {
  it("returns the raw duration when auto-pause is off", () => {
    expect(
      effectiveDurationSeconds(
        "2026-05-19T12:00:00",
        "2026-05-19T13:00:00",
        [{ start: "12:15", end: "12:45" }],
        false,
      ),
    ).toBe(3600);
  });

  it("subtracts break overlap when auto-pause is on", () => {
    expect(
      effectiveDurationSeconds(
        "2026-05-19T12:00:00",
        "2026-05-19T13:00:00",
        [{ start: "12:15", end: "12:45" }],
        true,
      ),
    ).toBe(1800);
  });

  it("uses `now` for a running timer (endIso = null)", () => {
    expect(
      effectiveDurationSeconds(
        "2026-05-19T12:00:00",
        null,
        [],
        false,
        new Date(2026, 4, 19, 12, 30, 0),
      ),
    ).toBe(1800);
  });
});

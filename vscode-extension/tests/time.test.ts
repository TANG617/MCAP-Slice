import { describe, expect, it } from "vitest";

import { formatNanoseconds, parseTimestampMilliseconds, parseTimestampNanoseconds } from "../src/shared/time";

describe("Shanghai RFC 3339 timestamps", () => {
  it("formats epoch nanoseconds at millisecond precision", () => {
    expect(formatNanoseconds(1_785_355_614_000_999_999n)).toBe("2026-07-30T04:06:54.000+08:00");
  });

  it("accepts Z and arbitrary offsets as the same instant", () => {
    expect(parseTimestampNanoseconds("2026-07-29T20:06:54.000Z")).toBe(1_785_355_614_000_000_000n);
    expect(parseTimestampNanoseconds("2026-07-30T04:06:54+08:00")).toBe(1_785_355_614_000_000_000n);
  });

  it("truncates fractional input to milliseconds", () => {
    expect(parseTimestampMilliseconds("2026-07-30T04:06:54.123999999+08:00")).toBe(1_785_355_614_123);
  });

  it("rejects malformed and impossible dates", () => {
    expect(parseTimestampMilliseconds("2026-02-30T00:00:00.000+08:00")).toBeUndefined();
    expect(parseTimestampMilliseconds("2026-01-01 00:00:00")).toBeUndefined();
  });
});

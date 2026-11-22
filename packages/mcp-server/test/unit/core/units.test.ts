import { describe, expect, it } from "vitest";
import { describeSpan, formatBytes } from "../../../src/lib/units.js";

describe("describeSpan", () => {
  it.each([
    [30, "30 seconds"],
    [60, "1 minute"],
    [3_600, "1 hour"],
    [5_400, "1.5 hours"],
    [86_400, "1 day"],
    [3 * 86_400, "3 days"],
  ])("describes %d seconds as %s", (seconds, text) => {
    expect(describeSpan(seconds)).toBe(text);
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1536, "1.5 KiB"],
    [9.5 * 1024 ** 3, "9.5 GiB"],
  ])("formats %d as %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

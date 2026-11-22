import { describe, expect, it } from "vitest";
import { isPast, parseThreshold, watermarksFrom } from "../../../src/tools/search/watermarks.js";

const GIB = 1024 ** 3;
const TIB = 1024 ** 4;

const defaults = (watermark: Record<string, string>) => ({
  defaults: { cluster: { routing: { allocation: { disk: { watermark } } } } },
});

describe("parseThreshold", () => {
  it.each([
    ["95%", { kind: "used_pct", pct: 95 }],
    ["0.9", { kind: "used_pct", pct: 90 }],
    ["20gb", { kind: "free_bytes", bytes: 20 * GIB }],
    ["500MB", { kind: "free_bytes", bytes: 500 * 1024 ** 2 }],
  ])("reads %j", (value, threshold) => {
    expect(parseThreshold(value)).toEqual(threshold);
  });

  it("ignores values it does not understand", () => {
    expect(parseThreshold("lots")).toBeUndefined();
  });
});

describe("watermarksFrom", () => {
  it("lets persistent and transient settings override the defaults", () => {
    const settings = {
      ...defaults({ low: "85%", high: "90%", flood_stage: "95%" }),
      persistent: { cluster: { routing: { allocation: { disk: { watermark: { high: "80%" } } } } } },
      transient: { cluster: { routing: { allocation: { disk: { watermark: { flood_stage: "1gb" } } } } } },
    };
    const values = watermarksFrom(settings, 3).map((watermark) => [watermark.level, watermark.value]);
    expect(values).toEqual([
      ["flood_stage", "1gb"],
      ["high", "80%"],
      ["low", "85%"],
    ]);
  });

  it("keeps only flood stage on a single OpenSearch data node that skips the others", () => {
    const settings = defaults({ low: "85%", high: "90%", flood_stage: "95%", enable_for_single_data_node: "false" });
    expect(watermarksFrom(settings, 1).map((watermark) => watermark.level)).toEqual(["flood_stage"]);
    expect(watermarksFrom(settings, 2)).toHaveLength(3);
  });
});

describe("isPast", () => {
  const [flood] = watermarksFrom(defaults({ flood_stage: "95%", "flood_stage.max_headroom": "100GB" }), 3);
  if (flood === undefined) throw new Error("no flood stage watermark parsed");

  it("counts a small disk past 95% as past flood stage", () => {
    expect(isPast(flood, { totalBytes: 10 * GIB, freeBytes: 0.4 * GIB })).toBe(true);
    expect(isPast(flood, { totalBytes: 10 * GIB, freeBytes: 0.6 * GIB })).toBe(false);
  });

  it("applies Elasticsearch's max headroom on a big disk: 96% used but 400 GiB free is fine", () => {
    expect(isPast(flood, { totalBytes: 10 * TIB, freeBytes: 400 * GIB })).toBe(false);
    expect(isPast(flood, { totalBytes: 10 * TIB, freeBytes: 90 * GIB })).toBe(true);
  });

  it("reads a byte watermark as the free space left", () => {
    const [byBytes] = watermarksFrom(defaults({ flood_stage: "1gb" }), 3);
    if (byBytes === undefined) throw new Error("no watermark parsed");
    expect(isPast(byBytes, { totalBytes: 100 * GIB, freeBytes: 0.5 * GIB })).toBe(true);
    expect(isPast(byBytes, { totalBytes: 100 * GIB, freeBytes: 2 * GIB })).toBe(false);
  });
});

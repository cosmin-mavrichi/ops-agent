import { describe, expect, it } from "vitest";
import { toolsFor } from "../../../src/tools/index.js";
import { defineTool, Level } from "../../../src/types.js";

describe("toolsFor", () => {
  const tool = (name: string, requires?: ("pg" | "k8s")[]) =>
    defineTool({ name, level: Level.Read, title: name, description: "t", input: {}, requires, run: async () => ({}) });

  it("exposes only tools whose adapters are configured", () => {
    const tools = [tool("pg_x", ["pg"]), tool("k8s_x", ["k8s"]), tool("both", ["pg", "k8s"]), tool("none")];
    expect(toolsFor(tools, ["pg"]).map((t) => t.name)).toEqual(["pg_x", "none"]);
    expect(toolsFor(tools, ["pg", "k8s"]).map((t) => t.name)).toEqual(["pg_x", "k8s_x", "both", "none"]);
  });
});

import { describe, expect, it } from "vitest";
import { statusError } from "../../../src/adapters/k8s.js";
import { ToolError } from "../../../src/types.js";

describe("statusError", () => {
  it.each([
    [400, "invalid_request"],
    [403, "forbidden"],
    [404, "not_found"],
  ])("maps %i to ToolError %s", (status, code) => {
    const err = statusError(status, "/api/v1/x", JSON.stringify({ message: "nope" }));
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe(code);
  });

  it("keeps other failures internal", () => {
    expect(statusError(500, "/api/v1/x", "boom")).not.toBeInstanceOf(ToolError);
  });
});

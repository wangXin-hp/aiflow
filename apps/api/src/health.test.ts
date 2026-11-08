import { describe, expect, it } from "vitest";
import { HealthController } from "./health.js";
describe("health endpoint", () => {
  it("reports the API is available", () => {
    expect(new HealthController().getHealth()).toEqual({
      status: "ok",
      service: "api",
    });
  });
});

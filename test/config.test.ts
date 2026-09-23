import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("normalizes trailing slashes in configured CORS origins", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://example.invalid/barpar",
      JWT_SECRET: "test-secret-that-is-at-least-32-characters-long",
      CORS_ORIGINS: "https://bar-par-kenya.onrender.com/",
    });

    expect(config.corsOrigins).toEqual(["https://bar-par-kenya.onrender.com"]);
  });
});

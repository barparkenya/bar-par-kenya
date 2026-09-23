import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  CORS_ORIGINS: z.string().optional(),
  ADMIN_API_KEY: z.string().min(32).optional(),
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
});

export type Config = z.infer<typeof schema> & { corsOrigins: string[] };

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(source);
  const configuredOrigins = parsed.CORS_ORIGINS
    ?.split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean) ?? [];
  const defaultOrigins = parsed.NODE_ENV === "production"
    ? ["https://bar-par-kenya.onrender.com"]
    : ["http://localhost:8081", "http://localhost:19006"];

  return {
    ...parsed,
    corsOrigins: configuredOrigins.length ? configuredOrigins : defaultOrigins,
  };
}

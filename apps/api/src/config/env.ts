type AppEnvironment = "development" | "test" | "staging" | "production";

const productionOnly = [
  "DATABASE_URL",
  "JWT_SECRET",
  "CORS_ORIGIN",
  "S3_BUCKET_NAME",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_ENDPOINT",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
];

const stagingOnly = ["DATABASE_URL", "JWT_SECRET", "CORS_ORIGIN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_CALLBACK_URL"];

function isPlaceholder(value: string | undefined) {
  if (!value) return true;
  return /change-me|placeholder|example|changeme/i.test(value);
}

function requireEnv(names: string[]) {
  const missing = names.filter((name) => isPlaceholder(process.env[name]));
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables for ${process.env.NODE_ENV}: ${missing.join(", ")}`);
  }
}

function assertProductionCors() {
  if (process.env.NODE_ENV !== "production") return;
  const origin = process.env.CORS_ORIGIN;
  if (!origin || origin.split(",").some((value) => value.trim() === "*")) {
    throw new Error("CORS_ORIGIN must be explicit in production and cannot contain '*'");
  }
}

export function getAppEnvironment(): AppEnvironment {
  const env = process.env.NODE_ENV;
  if (env === "production" || env === "staging" || env === "test") return env;
  return "development";
}

export function validateEnvironment() {
  const appEnv = getAppEnvironment();
  if (appEnv === "production") requireEnv(productionOnly);
  if (appEnv === "staging") requireEnv(stagingOnly);
  assertProductionCors();
}

export function getBuildInfo() {
  return {
    version: process.env.APP_VERSION ?? process.env.npm_package_version ?? "0.1.0",
    gitCommit: process.env.GIT_COMMIT_SHA ?? "local",
    environment: getAppEnvironment(),
  };
}

export function getAllowedOrigins() {
  const configured = process.env.CORS_ORIGIN?.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (configured?.length) return configured;
  return getAppEnvironment() === "production" ? [] : true;
}

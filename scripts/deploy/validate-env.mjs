const requiredByEnv = {
  staging: ["DATABASE_URL", "JWT_SECRET", "CORS_ORIGIN", "S3_BUCKET_NAME", "S3_ACCESS_KEY", "S3_SECRET_KEY"],
  production: ["DATABASE_URL", "JWT_SECRET", "CORS_ORIGIN", "S3_BUCKET_NAME", "S3_ACCESS_KEY", "S3_SECRET_KEY", "PUBLIC_DOMAIN", "ADMIN_DOMAIN", "API_DOMAIN"],
};

const env = process.argv[2] ?? process.env.NODE_ENV ?? "development";
const required = requiredByEnv[env] ?? [];
const missing = required.filter((name) => !process.env[name] || /change-me|placeholder|example|__/i.test(process.env[name]));

if (env === "production" && process.env.CORS_ORIGIN?.split(",").some((origin) => origin.trim() === "*")) {
  missing.push("CORS_ORIGIN(no wildcard)");
}

if (missing.length) {
  console.error(`Missing or placeholder ${env} variables: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`${env} environment validation passed`);

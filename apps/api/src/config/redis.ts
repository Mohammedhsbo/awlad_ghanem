import { createClient, type RedisClientType } from "redis";

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 4_000;

let redisUnavailableReported = false;

export function shouldConnectToRedis() {
  if (process.env.NODE_ENV === "test") {
    return Boolean(process.env.REDIS_URL);
  }

  return true;
}

export function createRedisClient(): RedisClientType {
  const socketOptions = {
    reconnectStrategy: (retries: number) => {
      if (retries >= MAX_RECONNECT_ATTEMPTS) {
        return new Error(`Redis reconnect attempts exhausted after ${retries} retries`);
      }
      return Math.min(BASE_RECONNECT_DELAY_MS * 2 ** retries, MAX_RECONNECT_DELAY_MS);
    },
  };
  const url = process.env.REDIS_URL;

  if (url) {
    return createClient({ url, socket: socketOptions });
  }

  return createClient({
    socket: {
      ...socketOptions,
      host: process.env.REDIS_HOST || "localhost",
      port: Number(process.env.REDIS_PORT || 6379),
    },
    password: process.env.REDIS_PASSWORD || undefined,
  });
}

export async function connectRedisClient(
  client: RedisClientType,
  fallbackDescription: string,
  logWarning: (message: string) => void = console.warn,
): Promise<boolean> {
  let isConnecting = true;
  client.on("error", (error) => {
    if (!isConnecting) {
      reportRedisUnavailable(fallbackDescription, error, logWarning);
    }
  });

  try {
    await client.connect();
    isConnecting = false;
    return true;
  } catch (error) {
    isConnecting = false;
    reportRedisUnavailable(fallbackDescription, error, logWarning);
    return false;
  }
}

export function reportRedisUnavailable(
  fallbackDescription: string,
  error: unknown,
  logWarning: (message: string) => void = console.warn,
) {
  if (redisUnavailableReported) return;
  redisUnavailableReported = true;
  const detail = error instanceof Error ? error.message : String(error);
  logWarning(`Redis unavailable; ${fallbackDescription}. ${detail}`);
}

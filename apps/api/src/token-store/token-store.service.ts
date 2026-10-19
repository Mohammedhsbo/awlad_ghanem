import { createHash } from "node:crypto";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { RedisClientType } from "redis";
import { connectRedisClient, createRedisClient, reportRedisUnavailable, shouldConnectToRedis } from "../config/redis.js";

interface StoredValue {
  value: string;
  expiresAt: number;
}

@Injectable()
export class TokenStoreService implements OnModuleInit, OnModuleDestroy {
  private client: RedisClientType | null = null;
  private readonly memory = new Map<string, StoredValue>();

  async onModuleInit() {
    if (!shouldConnectToRedis()) {
      return;
    }

    const client = createRedisClient();
    if (await connectRedisClient(client, "token storage will use in-memory storage")) {
      this.client = client;
    } else {
      try { if (client.isOpen) client.destroy(); } catch { /* already closed */ }
    }
  }

  async onModuleDestroy() {
    await this.client?.quit();
  }

  async saveRefreshToken(userId: string, tokenId: string, token: string, ttlSeconds: number) {
    await this.set(`refresh_token:${userId}:${tokenId}`, this.hashToken(token), ttlSeconds);
  }

  async isRefreshTokenValid(userId: string, tokenId: string, token: string) {
    const storedHash = await this.get(`refresh_token:${userId}:${tokenId}`);
    return storedHash === this.hashToken(token);
  }

  async deleteRefreshToken(userId: string, tokenId: string) {
    await this.delete(`refresh_token:${userId}:${tokenId}`);
  }

  async deleteRefreshTokensForUser(userId: string, exceptTokenId?: string) {
    const prefix = `refresh_token:${userId}:`;

    if (this.client) {
      // scanIterator yields a BATCH of keys per step, not one key. Passing the
      // batch straight to del() stringified the array, so the wrong key was
      // deleted, and an empty batch made Redis reject the call outright —
      // leaving the user's other sessions alive.
      try {
        for await (const batch of this.client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
          const keys = (Array.isArray(batch) ? batch : [batch]).map(String);
          const doomed = keys.filter((key) => key.slice(prefix.length) !== exceptTokenId);

          if (doomed.length > 0) {
            await this.client.del(doomed);
          }
        }
        return;
      } catch (error) {
        this.disableRedis(error);
      }
    }

    for (const key of this.memory.keys()) {
      if (key.startsWith(prefix) && key.slice(prefix.length) !== exceptTokenId) {
        this.memory.delete(key);
      }
    }
  }

  async blacklistToken(tokenId: string, ttlSeconds: number) {
    if (ttlSeconds <= 0) {
      return;
    }
    await this.set(`blacklist:${tokenId}`, "1", ttlSeconds);
  }

  async checkBlacklist(tokenId: string) {
    return (await this.get(`blacklist:${tokenId}`)) === "1";
  }

  private hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  async set(key: string, value: string, ttlSeconds: number) {
    if (this.client) {
      try {
        await this.client.set(key, value, { EX: ttlSeconds });
        return;
      } catch (error) {
        this.disableRedis(error);
      }
    }

    this.memory.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async get(key: string) {
    if (this.client) {
      try {
        return await this.client.get(key);
      } catch (error) {
        this.disableRedis(error);
      }
    }

    const stored = this.memory.get(key);
    if (!stored) {
      return null;
    }
    if (stored.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return stored.value;
  }

  async delete(key: string) {
    if (this.client) {
      try {
        await this.client.del(key);
        return;
      } catch (error) {
        this.disableRedis(error);
      }
    }

    this.memory.delete(key);
  }

  private disableRedis(error: unknown): void {
    if (!this.client) return;
    reportRedisUnavailable("token storage will use in-memory storage", error);
    try { if (this.client.isOpen) this.client.destroy(); } catch { /* already closed */ }
    this.client = null;
  }
}

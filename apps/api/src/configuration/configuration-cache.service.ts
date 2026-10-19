import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import type { RedisClientType } from 'redis';
import { connectRedisClient, createRedisClient, reportRedisUnavailable, shouldConnectToRedis } from '../config/redis.js';

interface CachedValue {
  value: any;
  expiresAt: number;
}

/**
 * Configuration caching service with multi-level caching strategy:
 * 1. In-memory cache (5 min TTL)
 * 2. Redis distributed cache (15 min TTL)
 * 3. PostgreSQL/Prisma (authoritative source)
 * 
 * Gracefully falls back to in-memory only when Redis unavailable.
 */
@Injectable()
export class ConfigurationCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConfigurationCacheService.name);
  private client: RedisClientType | null = null;
  private readonly memory = new Map<string, CachedValue>();
  
  // Cache TTLs in seconds
  private readonly MEMORY_TTL = 300; // 5 minutes
  private readonly REDIS_TTL = 900; // 15 minutes

  async onModuleInit() {
    if (!shouldConnectToRedis()) {
      return;
    }

    const client = createRedisClient();
    if (await connectRedisClient(client, 'configuration caching will use in-memory storage', (message) => this.logger.warn(message))) {
      this.client = client;
      this.logger.log('Redis connected for configuration caching');
    } else {
      try { if (client.isOpen) client.destroy(); } catch { /* already closed */ }
    }
  }

  async onModuleDestroy() {
    await this.client?.quit();
  }

  /**
   * Get cached configuration value
   * Checks memory first, then Redis, returns null if not found
   */
  async get<T = any>(key: string): Promise<T | null> {
    // Check memory cache first
    const memValue = this.getFromMemory(key);
    if (memValue !== null) {
      return memValue as T;
    }

    // Check Redis if available
    if (this.client) {
      try {
        const redisValue = await this.client.get(key);
        if (redisValue) {
          const parsed = JSON.parse(redisValue);
          // Populate memory cache
          this.setInMemory(key, parsed);
          return parsed as T;
        }
      } catch (error) {
        this.disableRedis(error);
      }
    }

    return null;
  }

  /**
   * Set configuration value in cache
   * Writes to both memory and Redis
   */
  async set(key: string, value: any): Promise<void> {
    // Set in memory
    this.setInMemory(key, value);

    // Set in Redis if available
    if (this.client) {
      try {
        await this.client.set(key, JSON.stringify(value), {
          EX: this.REDIS_TTL,
        });
      } catch (error) {
        this.disableRedis(error);
      }
    }
  }

  /**
   * Delete specific cache key(s)
   */
  async delete(keys: string | string[]): Promise<void> {
    const keyArray = Array.isArray(keys) ? keys : [keys];

    // Delete from memory
    for (const key of keyArray) {
      this.memory.delete(key);
    }

    // Delete from Redis if available
    if (this.client) {
      try {
        await this.client.del(keyArray);
      } catch (error) {
        this.disableRedis(error);
      }
    }
  }

  /**
   * Invalidate cache by pattern (e.g., 'config:branch:*')
   */
  async invalidatePattern(pattern: string): Promise<void> {
    // Invalidate memory cache by pattern
    for (const key of this.memory.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.memory.delete(key);
      }
    }

    // Invalidate Redis by pattern if available
    if (this.client) {
      try {
        const keys: string[] = [];
        for await (const key of this.client.scanIterator({ MATCH: pattern })) {
          keys.push(String(key));
        }
        if (keys.length > 0) {
          for (const key of keys) {
            await this.client.del(key);
          }
        }
      } catch (error) {
        this.disableRedis(error);
      }
    }
  }

  /**
   * Invalidate all configuration cache
   */
  async invalidateAll(): Promise<void> {
    this.memory.clear();

    if (this.client) {
      try {
        await this.invalidatePattern('config:*');
        await this.invalidatePattern('feature:*');
      } catch (error) {
        this.disableRedis(error);
      }
    }
  }

  /**
   * Invalidate branch-specific configuration
   */
  async invalidateBranch(branchId: string): Promise<void> {
    await this.invalidatePattern(`config:branch:${branchId}:*`);
    await this.invalidatePattern(`config:resolved:${branchId}:*`);
  }

  /**
   * Invalidate company-level configuration
   */
  async invalidateCompany(): Promise<void> {
    await this.invalidatePattern('config:company:*');
    // Also invalidate resolved configs as they may inherit company settings
    await this.invalidatePattern('config:resolved:*');
  }

  /**
   * Invalidate system-level configuration
   */
  async invalidateSystem(): Promise<void> {
    await this.invalidatePattern('config:system:*');
    // System changes affect all resolved configs
    await this.invalidatePattern('config:resolved:*');
  }

  /**
   * Invalidate feature flag cache
   */
  async invalidateFeatureFlag(flagKey: string): Promise<void> {
    await this.invalidatePattern(`feature:${flagKey}:*`);
  }

  /**
   * Get cache statistics (for monitoring)
   */
  getCacheStats() {
    return {
      memorySize: this.memory.size,
      redisConnected: !!this.client?.isReady,
      memoryTTL: this.MEMORY_TTL,
      redisTTL: this.REDIS_TTL,
    };
  }

  // Private helper methods

  private getFromMemory(key: string): any | null {
    const cached = this.memory.get(key);
    if (!cached) {
      return null;
    }

    // Check if expired
    if (cached.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }

    return cached.value;
  }

  private setInMemory(key: string, value: any): void {
    this.memory.set(key, {
      value,
      expiresAt: Date.now() + this.MEMORY_TTL * 1000,
    });
  }

  private matchPattern(key: string, pattern: string): boolean {
    // Simple pattern matching for * wildcard
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(key);
  }

  private disableRedis(error: unknown): void {
    if (!this.client) return;
    reportRedisUnavailable('configuration caching will use in-memory storage', error, (message) => this.logger.warn(message));
    try { if (this.client.isOpen) this.client.destroy(); } catch { /* already closed */ }
    this.client = null;
  }
}

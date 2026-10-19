import {
  Inject,
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { getStorageConfig } from "../config/storage.config.js";
import { getBuildInfo } from "../config/env.js";
import { renderPrometheusMetrics } from "../metrics/metrics.store.js";
import { connectRedisClient, createRedisClient, shouldConnectToRedis } from "../config/redis.js";

type DependencyState = { status: "ok" | "degraded"; latencyMs?: number; error?: string };

@Controller()
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get("health")
  health() {
    return { status: "ok" };
  }

  @Get("health/live")
  live() {
    return { status: "ok", timestamp: new Date().toISOString(), ...getBuildInfo() };
  }

  @Get("health/ready")
  async ready() {
    const db = await this.checkDatabase();
    if (db.status !== "ok") {
      throw new ServiceUnavailableException({ status: "degraded", dependencies: { database: db }, ...getBuildInfo() });
    }
    return { status: "ok", dependencies: { database: db }, ...getBuildInfo() };
  }

  @Get("health/deps")
  async deps() {
    const [database, redis, storage] = await Promise.all([this.checkDatabase(), this.checkRedis(), this.checkStorage()]);
    const status = [database, redis, storage].every((dep) => dep.status === "ok") ? "ok" : "degraded";
    if (status !== "ok") {
      throw new ServiceUnavailableException({ status, dependencies: { database, redis, storage }, ...getBuildInfo() });
    }
    return { status, dependencies: { database, redis, storage }, ...getBuildInfo() };
  }

  @Get("metrics")
  @Header("content-type", "text/plain; version=0.0.4")
  metrics() {
    return renderPrometheusMetrics();
  }

  private async checkDatabase(): Promise<DependencyState> {
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: "ok", latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { status: "degraded", error: error instanceof Error ? error.message : "database check failed" };
    }
  }

  private async checkRedis(): Promise<DependencyState> {
    if (!shouldConnectToRedis()) return { status: "degraded", error: "Redis not configured for tests" };
    const startedAt = Date.now();
    const client = createRedisClient();
    try {
      const connected = await connectRedisClient(client, "Redis dependency health checks will report unavailable");
      if (!connected) return { status: "degraded", error: "Redis unavailable" };
      await client.ping();
      return { status: "ok", latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { status: "degraded", error: error instanceof Error ? error.message : "redis check failed" };
    } finally {
      try { if (client.isOpen) await client.quit(); } catch { /* already closed */ }
    }
  }

  private async checkStorage(): Promise<DependencyState> {
    const startedAt = Date.now();
    try {
      const config = getStorageConfig();
      const client = new S3Client({
        region: config.region,
        credentials: config.credentials,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
      });
      await client.send(new HeadBucketCommand({ Bucket: config.bucketName }));
      return { status: "ok", latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { status: "degraded", error: error instanceof Error ? error.message : "storage check failed" };
    }
  }
}

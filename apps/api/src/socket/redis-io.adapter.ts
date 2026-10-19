import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { createSocketAuthMiddleware } from './auth.js';
import { connectRedisClient, createRedisClient, shouldConnectToRedis } from '../config/redis.js';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | undefined;

  constructor(private app: INestApplication) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    if (!shouldConnectToRedis()) {
      return;
    }

    const pubClient = createRedisClient();
    const subClient = pubClient.duplicate();
    const fallback = 'Socket.IO will use its in-memory adapter';
    const [pubConnected, subConnected] = await Promise.all([
      connectRedisClient(pubClient, fallback),
      connectRedisClient(subClient, fallback),
    ]);

    if (!pubConnected || !subConnected) {
      // Clean up each client independently; after exhausted retries the
      // Redis v5 client is already closed, so calling destroy() would
      // throw ClientClosedError.  Guard with isOpen and catch any
      // unexpected lifecycle errors so cleanup never masks the original
      // connection failure.
      await this.safeCleanupClient(pubClient, pubConnected);
      await this.safeCleanupClient(subClient, subConnected);
      return;
    }

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  /** Gracefully tear down a single Redis client, ignoring already-closed errors. */
  private async safeCleanupClient(
    client: ReturnType<typeof createRedisClient>,
    wasConnected: boolean,
  ): Promise<void> {
    try {
      if (!client.isOpen) return;
      if (wasConnected) {
        await client.quit();
      } else {
        client.destroy();
      }
    } catch {
      // Client already closed or transitioning — nothing to do.
    }
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    
    // Add Redis adapter if available
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }

    // Apply authentication middleware
    const prismaService = this.app.get(PrismaService);
    server.use(createSocketAuthMiddleware(prismaService));

    return server;
  }
}

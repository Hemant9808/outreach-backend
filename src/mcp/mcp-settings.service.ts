import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { decrypt, encrypt } from '../common/utils/crypto';
import { PrismaService } from '../prisma/prisma.service';

type Access = { enabled: boolean; key: string | null; source: 'settings' | 'env' | null };

const LAST_USED_THROTTLE_MS = 60_000;

@Injectable()
export class McpSettingsService {
  private cache = new Map<number, Access>();
  private lastUsedWrite = new Map<number, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async access(userId: number): Promise<Access> {
    const cached = this.cache.get(userId);
    if (cached) return cached;

    const row = await this.prisma.mcpSettings.findUnique({ where: { userId } });
    const envKey = this.config.get<string>('MCP_KEY') || null;
    const key = row?.keyEnc ? decrypt(row.keyEnc) : envKey;
    const access: Access = {
      enabled: row?.enabled ?? true,
      key,
      source: row?.keyEnc ? 'settings' : envKey ? 'env' : null,
    };
    this.cache.set(userId, access);
    return access;
  }

  async get(userId: number) {
    const [row, access] = await Promise.all([
      this.prisma.mcpSettings.findUnique({ where: { userId } }),
      this.access(userId),
    ]);
    return {
      enabled: access.enabled,
      key: access.key,
      keySource: access.source,
      publicUrl: row?.publicUrl ?? null,
      lastUsedAt: row?.lastUsedAt ?? null,
    };
  }

  async update(userId: number, input: { enabled?: boolean; publicUrl?: string | null }) {
    let publicUrl: string | null | undefined;
    if (input.publicUrl !== undefined) {
      publicUrl = input.publicUrl?.trim().replace(/\/+$/, '').replace(/\/mcp(\/.*)?$/, '') || null;
      if (publicUrl && !/^https?:\/\/[^\s/]+/i.test(publicUrl)) {
        throw new BadRequestException('Public URL must start with https://');
      }
    }
    await this.prisma.mcpSettings.upsert({
      where: { userId },
      create: { userId, enabled: input.enabled ?? true, publicUrl: publicUrl ?? null },
      update: { enabled: input.enabled, publicUrl },
    });
    this.cache.delete(userId);
    return this.get(userId);
  }

  async rotateKey(userId: number) {
    const keyEnc = encrypt(randomBytes(24).toString('base64url'));
    await this.prisma.mcpSettings.upsert({
      where: { userId },
      create: { userId, keyEnc },
      update: { keyEnc },
    });
    this.cache.delete(userId);
    return this.get(userId);
  }

  async removeKey(userId: number) {
    await this.prisma.mcpSettings.updateMany({ where: { userId }, data: { keyEnc: null } });
    this.cache.delete(userId);
    return this.get(userId);
  }

  async touch(userId: number) {
    const now = Date.now();
    if (now - (this.lastUsedWrite.get(userId) ?? 0) < LAST_USED_THROTTLE_MS) return;
    this.lastUsedWrite.set(userId, now);
    await this.prisma.mcpSettings.upsert({
      where: { userId },
      create: { userId, lastUsedAt: new Date(now) },
      update: { lastUsedAt: new Date(now) },
    });
  }

  async testPublicUrl(userId: number) {
    const settings = await this.get(userId);
    if (!settings.publicUrl) throw new BadRequestException('Add your public URL first');
    const url = `${settings.publicUrl}/mcp${settings.key ? `/${settings.key}` : ''}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: `Server answered ${res.status}: ${text.slice(0, 200)}` };
      const tools = (text.match(/"name":"[a-z_]+"/g) || []).length;
      return { ok: true, tools };
    } catch (err) {
      return {
        ok: false,
        error: `Could not reach ${settings.publicUrl}: ${err instanceof Error ? err.message : err}`,
      };
    }
  }
}

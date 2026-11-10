import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LocalUserService {
  private cachedId: number | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async id(): Promise<number> {
    if (this.cachedId) return this.cachedId;

    const existing = await this.prisma.user.findFirst({
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (existing) {
      this.cachedId = existing.id;
      return existing.id;
    }

    const created = await this.prisma.user.create({
      data: {
        email: 'local@outreach.desk',
        passwordHash: 'unused',
        name: 'Local',
      },
      select: { id: true },
    });
    this.cachedId = created.id;
    return created.id;
  }
}

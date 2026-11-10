import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { SendMode } from '@prisma/client';
import { Queue } from 'bullmq';
import { CloudinaryService, FileInput } from '../cloudinary/cloudinary.service';
import { nextTenAm } from '../common/utils/datetime';
import { LeadInput, LeadsService } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.service';

const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

export type SendSettings = {
  sendMode?: string;
  scheduledAt?: string;
  intervalDays?: string | number;
  maxSends?: string | number;
};

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly leads: LeadsService,
    @InjectQueue('extract') private readonly extractQueue: Queue,
  ) {}

  async create(userId: number, files: FileInput[], body: SendSettings) {
    if (!files?.length) {
      throw new BadRequestException('Upload at least one image or PDF');
    }

    const invalid = files.find(
      (file) =>
        !ALLOWED_TYPES.has(file.mimetype) &&
        !file.originalname.toLowerCase().match(/\.(jpe?g|png|webp|gif|pdf)$/),
    );
    if (invalid) {
      throw new BadRequestException(`Unsupported file: ${invalid.originalname}`);
    }

    const campaign = await this.prisma.campaign.create({
      data: { userId, ...this.parseSettings(body), status: 'UPLOADED' },
    });

    for (const file of files) {
      const uploaded = await this.cloudinary.uploadBuffer(file, 'mail/uploads');
      await this.prisma.upload.create({
        data: {
          campaignId: campaign.id,
          cloudinaryId: uploaded.public_id,
          url: uploaded.secure_url,
          mimeType: file.mimetype,
          originalName: file.originalname,
        },
      });
    }

    await this.extractQueue.add(
      'extract',
      { campaignId: campaign.id },
      { attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
    );

    return this.findOne(userId, campaign.id);
  }

  async createBatch(userId: number, body: SendSettings & { leads: LeadInput[] }) {
    if (!body.leads?.length) throw new BadRequestException('Provide at least one lead');
    const campaign = await this.prisma.campaign.create({
      data: { userId, ...this.parseSettings(body), status: 'READY' },
    });
    await this.leads.addLeads(userId, campaign.id, body.leads);
    return this.findOne(userId, campaign.id);
  }

  async addLeads(userId: number, id: number, leads: LeadInput[]) {
    await this.leads.addLeads(userId, id, leads);
    return this.findOne(userId, id);
  }

  async remove(userId: number, id: number) {
    await this.findOne(userId, id);
    await this.prisma.campaign.delete({ where: { id } });
    return { id, deleted: true };
  }

  async findAll(userId: number) {
    const campaigns = await this.prisma.campaign.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { leads: true, uploads: true } },
        leads: { select: { status: true, hrEmail: true } },
      },
    });

    return campaigns.map((campaign) => ({
      id: campaign.id,
      status: campaign.status,
      sendMode: campaign.sendMode,
      scheduledAt: campaign.scheduledAt,
      recurrenceIntervalDays: campaign.recurrenceIntervalDays,
      maxSends: campaign.maxSends,
      error: campaign.error,
      createdAt: campaign.createdAt,
      uploadCount: campaign._count.uploads,
      leadCount: campaign._count.leads,
      emailCount: campaign.leads.filter((lead) => lead.hrEmail).length,
      sentCount: campaign.leads.filter((lead) =>
        ['SENT', 'COMPLETED'].includes(lead.status),
      ).length,
    }));
  }

  async findOne(userId: number, id: number) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, userId },
      include: {
        uploads: true,
        leads: {
          include: {
            schedules: true,
            logs: { orderBy: { sentAt: 'desc' } },
          },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  private parseSettings(body: SendSettings) {
    const sendMode = this.parseSendMode(body.sendMode);
    let scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Invalid schedule time');
    }
    if (sendMode === 'SCHEDULED' || sendMode === 'RECURRING') {
      scheduledAt = scheduledAt || nextTenAm(new Date(), sendMode === 'RECURRING');
    }

    return {
      sendMode,
      scheduledAt: sendMode === 'IMMEDIATE' ? null : scheduledAt,
      recurrenceIntervalDays:
        sendMode === 'RECURRING' ? Math.max(1, Number(body.intervalDays || 1)) : null,
      maxSends: Math.max(1, Number(body.maxSends || 3)),
    };
  }

  private parseSendMode(value?: string): SendMode {
    const mode = (value || 'IMMEDIATE').toUpperCase();
    if (mode === 'IMMEDIATE' || mode === 'SCHEDULED' || mode === 'RECURRING') {
      return mode;
    }
    throw new BadRequestException('sendMode must be IMMEDIATE, SCHEDULED, or RECURRING');
  }
}

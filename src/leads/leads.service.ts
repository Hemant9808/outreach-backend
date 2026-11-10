import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { LeadStatus, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { firstRunAt, nextTenAm } from '../common/utils/datetime';
import { normalizeEmail } from '../common/utils/email';
import { ContactInput, ContactsService } from '../contacts/contacts.service';
import { PrismaService } from '../prisma/prisma.service';

export type LeadQuery = {
  kind?: string;
  status?: string;
  campaignId?: number;
  search?: string;
  leadIds?: number[];
};

export type LeadInput = {
  contactId?: number;
  contact?: ContactInput;
  hrName?: string | null;
  hrEmail?: string | null;
  company?: string | null;
  role?: string | null;
  jdSummary?: string | null;
  subject?: string | null;
  body?: string | null;
};

export type ScheduleInput = {
  nextRunAt?: string;
  intervalDays?: number | null;
  maxSends?: number;
};

export type BulkAction = 'send_now' | 'schedule' | 'pause' | 'resume' | 'delete';

const leadInclude = {
  campaign: { select: { id: true, sendMode: true } },
  schedules: { orderBy: { id: 'desc' }, take: 1 },
  logs: { orderBy: { sentAt: 'desc' }, take: 5 },
} satisfies Prisma.LeadInclude;

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
    @InjectQueue('send') private readonly sendQueue: Queue,
  ) {}

  async findAll(userId: number, query: LeadQuery) {
    const leads = await this.prisma.lead.findMany({
      where: this.buildWhere(userId, query),
      include: leadInclude,
      orderBy: { updatedAt: 'desc' },
    });
    return leads.map((lead) => this.serialize(lead));
  }

  async findOne(userId: number, id: number) {
    const lead = await this.requireLead(userId, id);
    return this.serialize(lead);
  }

  async addLeads(userId: number, campaignId: number, leads: LeadInput[]) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, userId },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!leads?.length) throw new BadRequestException('Provide at least one lead');

    const created: number[] = [];
    for (const raw of leads) {
      const input = await this.withSavedContact(userId, raw);
      const email = normalizeEmail(input.hrEmail);
      const contactId = email ? await this.contacts.fromLead(userId, input, input.contact) : null;
      const blocked = await this.contacts.isBlocked(contactId);
      const ready = Boolean(email && input.subject?.trim() && input.body?.trim() && !blocked);
      const lead = await this.prisma.lead.create({
        data: {
          campaignId,
          contactId,
          ...this.cleanInput(input),
          hrEmail: email,
          status: !email ? 'NO_EMAIL' : ready ? 'QUEUED' : 'EXTRACTED',
        },
      });
      created.push(lead.id);
      if (!ready) continue;

      const firstRun = firstRunAt(campaign.sendMode, campaign.scheduledAt);
      const schedule = await this.prisma.schedule.create({
        data: {
          leadId: lead.id,
          nextRunAt: firstRun,
          intervalDays: campaign.recurrenceIntervalDays,
          maxSends: campaign.maxSends,
          sendCount: 0,
          active: true,
        },
      });
      if (firstRun.getTime() <= Date.now()) {
        await this.enqueueSend(schedule.id);
      }
    }
    return created;
  }

  async update(userId: number, id: number, input: LeadInput) {
    const lead = await this.requireLead(userId, id);
    const data: Prisma.LeadUpdateInput = this.cleanInput(input);

    if (input.hrEmail !== undefined) {
      const email = normalizeEmail(input.hrEmail);
      if (input.hrEmail && !email) throw new BadRequestException('Invalid email');
      data.hrEmail = email;
      if (!email) {
        data.status = 'NO_EMAIL';
        if (lead.schedules[0]) {
          await this.prisma.schedule.update({
            where: { id: lead.schedules[0].id },
            data: { active: false },
          });
        }
      } else {
        if (lead.status === 'NO_EMAIL') data.status = 'EXTRACTED';
        const contactId = await this.contacts.fromLead(userId, {
          hrName: input.hrName ?? lead.hrName,
          hrEmail: email,
          company: input.company ?? lead.company,
          role: input.role ?? lead.role,
        });
        if (contactId) data.contact = { connect: { id: contactId } };
      }
    }

    await this.prisma.lead.update({ where: { id }, data });
    return this.findOne(userId, id);
  }

  async remove(userId: number, id: number) {
    await this.requireLead(userId, id);
    await this.prisma.lead.delete({ where: { id } });
    return { id, deleted: true };
  }

  async pause(userId: number, id: number) {
    const lead = await this.requireLead(userId, id);
    const schedule = lead.schedules[0];
    if (!schedule) throw new BadRequestException('This lead has no schedule');
    await this.prisma.schedule.update({
      where: { id: schedule.id },
      data: { active: false },
    });
    return this.findOne(userId, id);
  }

  async resume(userId: number, id: number) {
    const lead = await this.requireLead(userId, id);
    const schedule = lead.schedules[0];
    if (!schedule) throw new BadRequestException('This lead has no schedule');
    if (schedule.sendCount >= schedule.maxSends) {
      throw new BadRequestException('Max sends already reached');
    }
    const nextRunAt =
      schedule.nextRunAt.getTime() > Date.now()
        ? schedule.nextRunAt
        : nextTenAm(new Date(), Boolean(schedule.intervalDays));
    await this.prisma.schedule.update({
      where: { id: schedule.id },
      data: { active: true, nextRunAt },
    });
    await this.prisma.lead.update({
      where: { id: lead.id },
      data: { status: schedule.sendCount > 0 ? 'SENT' : 'QUEUED' },
    });
    return this.findOne(userId, id);
  }

  async sendNow(userId: number, id: number) {
    const lead = await this.requireLead(userId, id);
    await this.assertSendable(lead);
    const schedule = await this.ensureSchedule(lead.id, lead.schedules[0]);
    await this.enqueueSend(schedule.id, true);
    return this.findOne(userId, id);
  }

  async reschedule(userId: number, id: number, body: ScheduleInput) {
    const lead = await this.requireLead(userId, id);
    await this.assertSendable(lead);
    if (!body.nextRunAt) throw new BadRequestException('Pick a date and time');
    const nextRunAt = new Date(body.nextRunAt);
    if (Number.isNaN(nextRunAt.getTime())) {
      throw new BadRequestException('Invalid date and time');
    }

    const existing = lead.schedules[0];
    const intervalDays =
      body.intervalDays === undefined
        ? existing?.intervalDays ?? null
        : body.intervalDays === null
          ? null
          : Math.max(1, Number(body.intervalDays));
    const maxSends =
      body.maxSends === undefined ? undefined : Math.max(1, Number(body.maxSends));

    const schedule = existing
      ? await this.prisma.schedule.update({
          where: { id: existing.id },
          data: {
            nextRunAt,
            intervalDays,
            maxSends,
            active: true,
          },
        })
      : await this.prisma.schedule.create({
          data: {
            leadId: lead.id,
            nextRunAt,
            intervalDays,
            maxSends: maxSends ?? 3,
            sendCount: 0,
            active: true,
          },
        });

    await this.prisma.lead.update({
      where: { id: lead.id },
      data: { status: schedule.sendCount > 0 ? 'SENT' : 'QUEUED' },
    });

    if (nextRunAt.getTime() <= Date.now()) {
      await this.enqueueSend(schedule.id, true);
    }

    return this.findOne(userId, id);
  }

  async bulk(
    userId: number,
    target: LeadQuery & { all?: boolean },
    action: BulkAction,
    params: ScheduleInput & { staggerMinutes?: number } = {},
  ) {
    const hasSelector =
      target.all ||
      target.leadIds?.length ||
      target.campaignId ||
      target.status ||
      target.kind ||
      target.search;
    if (!hasSelector) {
      throw new BadRequestException(
        'Choose leads with leadIds, campaignId, status, kind, search, or all=true',
      );
    }

    const leads = await this.prisma.lead.findMany({
      where: this.buildWhere(userId, target),
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    const start = params.nextRunAt ? new Date(params.nextRunAt) : null;
    if (action === 'schedule' && (!start || Number.isNaN(start.getTime()))) {
      throw new BadRequestException('nextRunAt is required for schedule');
    }
    const stagger = Math.max(0, Number(params.staggerMinutes || 0));

    const succeeded: number[] = [];
    const failed: { id: number; error: string }[] = [];
    for (const [index, { id }] of leads.entries()) {
      try {
        if (action === 'send_now') await this.sendNow(userId, id);
        else if (action === 'pause') await this.pause(userId, id);
        else if (action === 'resume') await this.resume(userId, id);
        else if (action === 'delete') await this.remove(userId, id);
        else {
          const at = new Date(start!.getTime() + index * stagger * 60_000);
          await this.reschedule(userId, id, { ...params, nextRunAt: at.toISOString() });
        }
        succeeded.push(id);
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return { action, matched: leads.length, succeeded, failed };
  }

  async summary(userId: number) {
    const [byStatus, campaigns, upcoming] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['status'],
        where: { campaign: { userId } },
        _count: { _all: true },
      }),
      this.prisma.campaign.count({ where: { userId } }),
      this.prisma.schedule.findMany({
        where: { active: true, lead: { campaign: { userId } } },
        orderBy: { nextRunAt: 'asc' },
        take: 20,
        include: { lead: { select: { id: true, hrEmail: true, company: true, role: true } } },
      }),
    ]);

    return {
      campaigns,
      leadsByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      upcomingSends: upcoming.map((schedule) => ({
        leadId: schedule.lead.id,
        hrEmail: schedule.lead.hrEmail,
        company: schedule.lead.company,
        role: schedule.lead.role,
        nextRunAt: schedule.nextRunAt,
        recurring: Boolean(schedule.intervalDays),
        intervalDays: schedule.intervalDays,
        sendCount: schedule.sendCount,
        maxSends: schedule.maxSends,
      })),
    };
  }

  private buildWhere(userId: number, query: LeadQuery): Prisma.LeadWhereInput {
    const and: Prisma.LeadWhereInput[] = [{ campaign: { userId } }];

    if (query.leadIds?.length) and.push({ id: { in: query.leadIds } });
    if (query.campaignId) and.push({ campaignId: query.campaignId });
    if (query.search?.trim()) {
      const term = query.search.trim();
      and.push({
        OR: [
          { hrEmail: { contains: term } },
          { hrName: { contains: term } },
          { company: { contains: term } },
          { role: { contains: term } },
        ],
      });
    }

    if (query.kind === 'recurring') {
      and.push({ schedules: { some: { intervalDays: { not: null } } } });
    } else if (query.kind === 'one_time') {
      and.push({
        OR: [
          { schedules: { none: {} } },
          { schedules: { every: { intervalDays: null } } },
        ],
      });
    }

    if (query.status === 'STOPPED') {
      and.push({
        schedules: { some: { active: false } },
        status: { notIn: ['COMPLETED', 'NO_EMAIL'] },
      });
    } else if (query.status === 'ACTIVE') {
      and.push({
        hrEmail: { not: null },
        OR: [
          { status: 'QUEUED' },
          { status: 'SENT', schedules: { some: { active: true } } },
        ],
      });
    } else if (query.status && query.status !== 'ALL') {
      and.push({ status: query.status as LeadStatus });
    }

    return { AND: and };
  }

  private cleanInput(input: LeadInput) {
    const fields = ['hrName', 'company', 'role', 'jdSummary', 'subject', 'body'] as const;
    const data: Partial<Record<(typeof fields)[number], string | null>> = {};
    for (const field of fields) {
      if (input[field] !== undefined) data[field] = input[field]?.trim() || null;
    }
    return data;
  }

  private async assertSendable(lead: {
    hrEmail: string | null;
    subject: string | null;
    body: string | null;
    contactId: number | null;
  }) {
    if (!lead.hrEmail) throw new BadRequestException('This lead has no email');
    if (!lead.subject || !lead.body) {
      throw new BadRequestException('This lead needs a subject and body before sending');
    }
    if (await this.contacts.isBlocked(lead.contactId)) {
      throw new BadRequestException('This contact is marked Do not contact');
    }
  }

  private async withSavedContact(userId: number, input: LeadInput): Promise<LeadInput> {
    if (!input.contactId) return input;
    const contact = await this.prisma.contact.findFirst({
      where: { id: input.contactId, userId },
      include: { company: { select: { name: true } } },
    });
    if (!contact) throw new NotFoundException(`Contact #${input.contactId} not found`);
    return {
      ...input,
      hrEmail: input.hrEmail ?? contact.email,
      hrName: input.hrName ?? contact.name,
      company: input.company ?? contact.company?.name ?? null,
    };
  }

  private async requireLead(userId: number, id: number) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, campaign: { userId } },
      include: leadInclude,
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  private async ensureSchedule(
    leadId: number,
    existing?: { id: number } | null,
  ) {
    if (existing) return existing;
    return this.prisma.schedule.create({
      data: {
        leadId,
        nextRunAt: new Date(),
        intervalDays: null,
        maxSends: 3,
        sendCount: 0,
        active: true,
      },
    });
  }

  private async enqueueSend(scheduleId: number, force = false) {
    const lock = new Date();
    lock.setMinutes(lock.getMinutes() + 50);
    await this.prisma.schedule.update({
      where: { id: scheduleId },
      data: { nextRunAt: lock },
    });
    await this.sendQueue.add(
      'send',
      { scheduleId, force },
      {
        jobId: `send-${scheduleId}-${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 15000 },
      },
    );
  }

  private serialize(lead: {
    id: number;
    campaignId: number;
    hrName: string | null;
    hrEmail: string | null;
    company: string | null;
    role: string | null;
    jdSummary: string | null;
    subject: string | null;
    body: string | null;
    status: string;
    campaign: { id: number; sendMode: string };
    schedules: {
      id: number;
      nextRunAt: Date;
      intervalDays: number | null;
      sendCount: number;
      maxSends: number;
      active: boolean;
    }[];
    logs: { id: number; sentAt: Date; status: string; error: string | null }[];
  }) {
    const schedule = lead.schedules[0] || null;
    const stopped = Boolean(schedule && !schedule.active && lead.status !== 'COMPLETED');
    return {
      ...lead,
      kind: schedule?.intervalDays ? 'recurring' : 'one_time',
      stopped,
      schedule,
    };
  }
}

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { nextRecurrenceAt } from '../common/utils/datetime';
import { ContactsService } from '../contacts/contacts.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

@Processor('send')
export class SendProcessor extends WorkerHost {
  private readonly logger = new Logger(SendProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly contacts: ContactsService,
  ) {
    super();
  }

  async process(job: Job<{ scheduleId: number; force?: boolean }>) {
    const schedule = await this.prisma.schedule.findUnique({
      where: { id: job.data.scheduleId },
      include: {
        lead: {
          include: {
            campaign: { include: { user: true } },
          },
        },
      },
    });

    if (!schedule) return;
    if (!schedule.active && !job.data.force) return;

    const lead = schedule.lead;
    const blocked = await this.contacts.isBlocked(lead.contactId);
    if (!lead.hrEmail || !lead.subject || !lead.body || blocked) {
      await this.prisma.schedule.update({
        where: { id: schedule.id },
        data: { active: false },
      });
      return;
    }

    try {
      const result = await this.mail.sendColdEmail({
        userId: lead.campaign.userId,
        to: lead.hrEmail,
        subject: lead.subject,
        text: lead.body,
        resumeUrl: lead.campaign.user.resumeUrl,
        resumeFilename: lead.campaign.user.resumeFilename,
      });

      await this.prisma.sendLog.create({
        data: {
          leadId: lead.id,
          status: 'sent',
          providerId: result.id,
        },
      });

      const sendCount = schedule.sendCount + 1;
      const isRecurring = Boolean(schedule.intervalDays);
      const done = !isRecurring || sendCount >= schedule.maxSends;
      const stayPaused = !schedule.active && Boolean(job.data.force);

      await this.prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          sendCount,
          active: stayPaused ? false : !done,
          nextRunAt: done
            ? schedule.nextRunAt
            : nextRecurrenceAt(new Date(), schedule.intervalDays || 1),
        },
      });

      await this.prisma.lead.update({
        where: { id: lead.id },
        data: { status: done ? 'COMPLETED' : 'SENT' },
      });
      if (lead.contactId) {
        await this.contacts.markContacted(lead.contactId).catch((err) => this.logger.warn(err));
      }
    } catch (error) {
      this.logger.error(error);
      await this.prisma.sendLog.create({
        data: {
          leadId: lead.id,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Send failed',
        },
      });
      await this.prisma.lead.update({
        where: { id: lead.id },
        data: { status: 'FAILED' },
      });
      throw error;
    }
  }
}

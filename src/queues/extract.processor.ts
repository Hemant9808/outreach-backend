import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { firstRunAt } from '../common/utils/datetime';
import { normalizeEmail } from '../common/utils/email';
import { ContactsService } from '../contacts/contacts.service';
import { GeminiService } from '../gemini/gemini.service';
import { PrismaService } from '../prisma/prisma.service';

@Processor('extract')
export class ExtractProcessor extends WorkerHost {
  private readonly logger = new Logger(ExtractProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gemini: GeminiService,
    private readonly contacts: ContactsService,
    @InjectQueue('send') private readonly sendQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<{ campaignId: number }>) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: job.data.campaignId },
      include: { uploads: true, user: true },
    });
    if (!campaign) return;

    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'EXTRACTING', error: null },
    });

    try {
      const profile = {
        name: campaign.user.name,
        email: campaign.user.email,
        phone: campaign.user.phone,
        title: campaign.user.title,
        skills: campaign.user.skills,
        about: campaign.user.about,
        linkedin: campaign.user.linkedin,
      };

      const seenEmails = new Set<string>();

      for (const upload of campaign.uploads) {
        const response = await fetch(upload.url);
        if (!response.ok) {
          throw new Error(`Could not download ${upload.originalName}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const extracted = await this.gemini.extractFromFile(
          buffer,
          upload.mimeType,
          upload.originalName,
          profile,
        );

        for (const item of extracted) {
          const email = normalizeEmail(item.hrEmail);
          if (email && seenEmails.has(email)) continue;
          if (email) seenEmails.add(email);

          const contactId = email
            ? await this.contacts
                .fromLead(
                  campaign.userId,
                  { hrName: item.hrName, hrEmail: email, company: item.company, role: item.role },
                  {
                    phone: item.hrPhone,
                    position: item.hrPosition,
                    seniority: item.seniority,
                    recruiterType: item.recruiterType,
                    hiringFor: item.hiringFor,
                    hiresForCompanies: item.hiresForCompanies,
                    location: item.location,
                    source: 'gemini',
                    sourceUrl: upload.url,
                  },
                )
                .catch((err) => {
                  this.logger.warn(`Could not save contact ${email}: ${err}`);
                  return null;
                })
            : null;
          const blocked = await this.contacts.isBlocked(contactId);

          const lead = await this.prisma.lead.create({
            data: {
              campaignId: campaign.id,
              uploadId: upload.id,
              contactId,
              hrName: item.hrName,
              hrEmail: email,
              company: item.company,
              role: item.role,
              jdSummary: item.jdSummary,
              subject: item.subject,
              body: item.body,
              status: !email ? 'NO_EMAIL' : blocked ? 'EXTRACTED' : 'QUEUED',
            },
          });

          if (!email || blocked) continue;

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
            await this.sendQueue.add(
              'send',
              { scheduleId: schedule.id },
              {
                jobId: `send-${schedule.id}-0`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 15000 },
              },
            );
            const lock = new Date(firstRun.getTime());
            lock.setMinutes(lock.getMinutes() + 50);
            await this.prisma.schedule.update({
              where: { id: schedule.id },
              data: { nextRunAt: lock },
            });
          }
        }
      }

      await this.prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'READY' },
      });
    } catch (error) {
      this.logger.error(error);
      await this.prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : 'Extraction failed',
        },
      });
      throw error;
    }
  }
}

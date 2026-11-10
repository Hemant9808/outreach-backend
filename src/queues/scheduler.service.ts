import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('send') private readonly sendQueue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async enqueueDue() {
    const due = await this.prisma.schedule.findMany({
      where: {
        active: true,
        nextRunAt: { lte: new Date() },
      },
      take: 50,
    });

    for (const schedule of due) {
      const farFuture = new Date(schedule.nextRunAt.getTime());
      farFuture.setMinutes(farFuture.getMinutes() + 50);

      await this.prisma.schedule.update({
        where: { id: schedule.id },
        data: { nextRunAt: farFuture },
      });

      await this.sendQueue.add(
        'send',
        { scheduleId: schedule.id },
        {
          jobId: `send-${schedule.id}-${schedule.sendCount}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 15000 },
        },
      );
      this.logger.log(`Queued send for schedule ${schedule.id}`);
    }
  }
}

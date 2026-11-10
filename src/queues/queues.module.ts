import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { GeminiModule } from '../gemini/gemini.module';
import { MailModule } from '../mail/mail.module';
import { ExtractProcessor } from './extract.processor';
import { SchedulerService } from './scheduler.service';
import { SendProcessor } from './send.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'extract' }, { name: 'send' }),
    ContactsModule,
    GeminiModule,
    MailModule,
  ],
  providers: [ExtractProcessor, SendProcessor, SchedulerService],
})
export class QueuesModule {}

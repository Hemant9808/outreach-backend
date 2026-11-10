import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'send' }), ContactsModule],
  controllers: [LeadsController],
  providers: [LeadsService],
  exports: [LeadsService],
})
export class LeadsModule {}

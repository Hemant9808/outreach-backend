import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'extract' }), LeadsModule],
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}

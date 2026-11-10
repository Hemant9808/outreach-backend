import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { ContactsModule } from '../contacts/contacts.module';
import { LeadsModule } from '../leads/leads.module';
import { ProfileModule } from '../profile/profile.module';
import { McpSettingsController } from './mcp-settings.controller';
import { McpSettingsService } from './mcp-settings.service';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

@Module({
  imports: [CampaignsModule, ContactsModule, LeadsModule, ProfileModule],
  controllers: [McpController, McpSettingsController],
  providers: [McpService, McpSettingsService],
})
export class McpModule {}

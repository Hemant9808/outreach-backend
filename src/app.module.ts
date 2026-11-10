import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CampaignsModule } from './campaigns/campaigns.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { ContactsModule } from './contacts/contacts.module';
import { LeadsModule } from './leads/leads.module';
import { McpModule } from './mcp/mcp.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProfileModule } from './profile/profile.module';
import { QueuesModule } from './queues/queues.module';
import { SettingsModule } from './settings/settings.module';
import { UserModule } from './user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST') || '127.0.0.1',
          port: Number(config.get('REDIS_PORT') || 6379),
        },
      }),
    }),
    PrismaModule,
    UserModule,
    CloudinaryModule,
    ProfileModule,
    CampaignsModule,
    ContactsModule,
    LeadsModule,
    QueuesModule,
    McpModule,
    SettingsModule,
  ],
})
export class AppModule {}

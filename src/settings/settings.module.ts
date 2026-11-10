import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [MailModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}

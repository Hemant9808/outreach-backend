import { Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { LocalUserService } from '../user/local-user.service';
import { EmailSettingsInput, SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly localUser: LocalUserService,
  ) {}

  @Get('email')
  async getEmail() {
    return this.settings.getEmail(await this.localUser.id());
  }

  @Put('email')
  async saveEmail(@Body() body: EmailSettingsInput) {
    return this.settings.saveEmail(await this.localUser.id(), body);
  }

  @Post('email/test')
  async testEmail(@Body() body: EmailSettingsInput & { sendTo?: string }) {
    return this.settings.testEmail(await this.localUser.id(), body);
  }

  @Delete('email')
  async deleteEmail() {
    return this.settings.deleteEmail(await this.localUser.id());
  }
}

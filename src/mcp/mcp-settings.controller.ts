import { Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { LocalUserService } from '../user/local-user.service';
import { McpSettingsService } from './mcp-settings.service';
import { McpService } from './mcp.service';

@Controller('settings/mcp')
export class McpSettingsController {
  constructor(
    private readonly settings: McpSettingsService,
    private readonly mcp: McpService,
    private readonly localUser: LocalUserService,
  ) {}

  @Get()
  async get() {
    return {
      ...(await this.settings.get(await this.localUser.id())),
      tools: this.mcp.listTools(),
    };
  }

  @Put()
  async update(@Body() body: { enabled?: boolean; publicUrl?: string | null }) {
    return this.settings.update(await this.localUser.id(), body);
  }

  @Post('key')
  async rotateKey() {
    return this.settings.rotateKey(await this.localUser.id());
  }

  @Delete('key')
  async removeKey() {
    return this.settings.removeKey(await this.localUser.id());
  }

  @Post('test')
  async test() {
    return this.settings.testPublicUrl(await this.localUser.id());
  }
}

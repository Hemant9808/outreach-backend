import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { LeadInput } from '../leads/leads.service';
import { LocalUserService } from '../user/local-user.service';
import { CampaignsService, SendSettings } from './campaigns.service';

@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly localUser: LocalUserService,
  ) {}

  @Post()
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: memoryStorage(),
      limits: { fileSize: 12 * 1024 * 1024 },
    }),
  )
  async create(@UploadedFiles() files: Express.Multer.File[], @Body() body: SendSettings) {
    return this.campaigns.create(await this.localUser.id(), files, body);
  }

  @Post('batch')
  async createBatch(@Body() body: SendSettings & { leads: LeadInput[] }) {
    return this.campaigns.createBatch(await this.localUser.id(), body);
  }

  @Get()
  async findAll() {
    return this.campaigns.findAll(await this.localUser.id());
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.findOne(await this.localUser.id(), id);
  }

  @Post(':id/leads')
  async addLeads(@Param('id', ParseIntPipe) id: number, @Body() body: { leads: LeadInput[] }) {
    return this.campaigns.addLeads(await this.localUser.id(), id, body.leads);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.campaigns.remove(await this.localUser.id(), id);
  }
}

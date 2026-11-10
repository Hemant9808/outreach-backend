import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { LocalUserService } from '../user/local-user.service';
import { BulkAction, LeadInput, LeadQuery, LeadsService, ScheduleInput } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly localUser: LocalUserService,
  ) {}

  @Get()
  async findAll(
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('campaignId') campaignId?: string,
    @Query('search') search?: string,
  ) {
    return this.leads.findAll(await this.localUser.id(), {
      kind,
      status,
      search,
      campaignId: campaignId ? Number(campaignId) : undefined,
    });
  }

  @Get('summary')
  async summary() {
    return this.leads.summary(await this.localUser.id());
  }

  @Post('bulk')
  async bulk(
    @Body()
    body: {
      action: BulkAction;
      target: LeadQuery & { all?: boolean };
      params?: ScheduleInput & { staggerMinutes?: number };
    },
  ) {
    return this.leads.bulk(await this.localUser.id(), body.target || {}, body.action, body.params);
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.leads.findOne(await this.localUser.id(), id);
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: LeadInput) {
    return this.leads.update(await this.localUser.id(), id, body);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.leads.remove(await this.localUser.id(), id);
  }

  @Post(':id/pause')
  async pause(@Param('id', ParseIntPipe) id: number) {
    return this.leads.pause(await this.localUser.id(), id);
  }

  @Post(':id/resume')
  async resume(@Param('id', ParseIntPipe) id: number) {
    return this.leads.resume(await this.localUser.id(), id);
  }

  @Post(':id/send-now')
  async sendNow(@Param('id', ParseIntPipe) id: number) {
    return this.leads.sendNow(await this.localUser.id(), id);
  }

  @Patch(':id/schedule')
  async reschedule(@Param('id', ParseIntPipe) id: number, @Body() body: ScheduleInput) {
    return this.leads.reschedule(await this.localUser.id(), id, body);
  }
}

import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ContactStatus, RecruiterType } from '@prisma/client';
import { LocalUserService } from '../user/local-user.service';
import { CompanyUpdate, ContactInput, ContactQuery, ContactsService } from './contacts.service';

@Controller()
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly localUser: LocalUserService,
  ) {}

  @Get('contacts')
  async findAll(
    @Query('search') search?: string,
    @Query('companyId') companyId?: string,
    @Query('status') status?: string,
    @Query('recruiterType') recruiterType?: string,
    @Query('minSeniority') minSeniority?: string,
    @Query('hiringFor') hiringFor?: string,
    @Query('sort') sort?: ContactQuery['sort'],
  ) {
    return this.contacts.findAll(await this.localUser.id(), {
      search,
      hiringFor,
      sort,
      companyId: companyId ? Number(companyId) : undefined,
      status: status && status !== 'ALL' ? (status as ContactStatus) : undefined,
      recruiterType: (recruiterType as RecruiterType) || undefined,
      minSeniority: minSeniority ? Number(minSeniority) : undefined,
    });
  }

  @Post('contacts')
  async upsertMany(@Body() body: { contacts: ContactInput[] }) {
    return this.contacts.upsertMany(await this.localUser.id(), body.contacts || []);
  }

  @Get('contacts/:id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.contacts.findOne(await this.localUser.id(), id);
  }

  @Patch('contacts/:id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: ContactInput) {
    return this.contacts.update(await this.localUser.id(), id, body);
  }

  @Delete('contacts/:id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.contacts.remove(await this.localUser.id(), id);
  }

  @Get('companies')
  async companies(@Query('search') search?: string) {
    return this.contacts.listCompanies(await this.localUser.id(), { search });
  }

  @Post('companies/merge')
  async merge(@Body() body: { targetId: number; sourceIds: number[] }) {
    return this.contacts.mergeCompanies(await this.localUser.id(), body.targetId, body.sourceIds || []);
  }

  @Get('companies/:id')
  async company(@Param('id', ParseIntPipe) id: number) {
    return this.contacts.getCompany(await this.localUser.id(), id);
  }

  @Patch('companies/:id')
  async updateCompany(@Param('id', ParseIntPipe) id: number, @Body() body: CompanyUpdate) {
    return this.contacts.updateCompany(await this.localUser.id(), id, body);
  }

  @Delete('companies/:id')
  async removeCompany(@Param('id', ParseIntPipe) id: number) {
    return this.contacts.removeCompany(await this.localUser.id(), id);
  }
}

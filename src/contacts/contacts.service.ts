import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ContactStatus, Prisma, RecruiterType } from '@prisma/client';
import { normalizeEmail } from '../common/utils/email';
import { PrismaService } from '../prisma/prisma.service';
import { cleanCompanyName, companyDomainFromEmail, companyKey, domainFromUrl } from './company-name';

export const CONTACT_STATUSES = Object.values(ContactStatus);
export const RECRUITER_TYPES = Object.values(RecruiterType);

export type CompanyInput = {
  company?: string | null;
  companyDomain?: string | null;
  companyWebsite?: string | null;
  companyLinkedin?: string | null;
  companyIndustry?: string | null;
  companySize?: string | null;
  companyLocation?: string | null;
};

export type ContactInput = CompanyInput & {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  position?: string | null;
  seniority?: number | null;
  department?: string | null;
  recruiterType?: RecruiterType | null;
  hiringFor?: string[] | null;
  hiresForCompanies?: string[] | null;
  location?: string | null;
  linkedin?: string | null;
  tags?: string[] | null;
  notes?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  status?: ContactStatus | null;
};

export type ContactQuery = {
  search?: string;
  companyId?: number;
  company?: string;
  status?: ContactStatus | ContactStatus[];
  recruiterType?: RecruiterType;
  minSeniority?: number;
  maxSeniority?: number;
  hiringFor?: string;
  tag?: string;
  neverContacted?: boolean;
  sort?: 'company' | 'recent' | 'seniority' | 'last_contacted';
  limit?: number;
  offset?: number;
};

export type CompanyUpdate = {
  name?: string;
  domain?: string | null;
  website?: string | null;
  linkedin?: string | null;
  industry?: string | null;
  size?: string | null;
  location?: string | null;
  notes?: string | null;
};

const SCALAR_FIELDS = [
  'name',
  'phone',
  'position',
  'department',
  'location',
  'linkedin',
  'notes',
  'source',
  'sourceUrl',
] as const;

const contactInclude = {
  company: { select: { id: true, name: true, domain: true } },
} satisfies Prisma.ContactInclude;

type ContactRow = Prisma.ContactGetPayload<{ include: typeof contactInclude }>;

function toList(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function cleanList(values?: string[] | null) {
  const seen = new Map<string, string>();
  for (const value of values ?? []) {
    const cleaned = value?.replace(/\s+/g, ' ').trim();
    if (cleaned && !seen.has(cleaned.toLowerCase())) seen.set(cleaned.toLowerCase(), cleaned);
  }
  return [...seen.values()];
}

function text(value?: string | null) {
  return value?.trim() || null;
}

@Injectable()
export class ContactsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContactsService.name);

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap() {
    void this.syncAllFromLeads().catch((err) => this.logger.warn(`Contact backfill failed: ${err}`));
  }

  async upsert(userId: number, input: ContactInput, options: { replaceLists?: boolean } = {}) {
    const email = normalizeEmail(input.email);
    if (!email) throw new BadRequestException(`Invalid or missing email: ${input.email ?? ''}`);

    const existing = await this.prisma.contact.findUnique({
      where: { userId_email: { userId, email } },
    });

    const data: Prisma.ContactUncheckedUpdateInput = {};
    for (const field of SCALAR_FIELDS) {
      const value = input[field];
      if (value === undefined) continue;
      if (options.replaceLists) data[field] = text(value);
      else if (text(value)) data[field] = text(value);
    }

    if (input.seniority !== undefined && input.seniority !== null) {
      const seniority = Math.round(Number(input.seniority));
      if (!Number.isFinite(seniority) || seniority < 1 || seniority > 10) {
        throw new BadRequestException('Seniority must be between 1 and 10');
      }
      data.seniority = seniority;
    } else if (input.seniority === null && options.replaceLists) {
      data.seniority = null;
    }

    if (input.recruiterType && (input.recruiterType !== 'UNKNOWN' || !existing)) {
      data.recruiterType = input.recruiterType;
    }
    if (input.status) {
      data.status = input.status;
      if (input.status === 'REPLIED' && !existing?.lastRepliedAt) data.lastRepliedAt = new Date();
    }

    for (const field of ['hiringFor', 'hiresForCompanies', 'tags'] as const) {
      if (input[field] === undefined) continue;
      const next = options.replaceLists
        ? cleanList(input[field])
        : cleanList([...toList(existing?.[field]), ...(input[field] ?? [])]);
      data[field] = next.length ? next : Prisma.DbNull;
    }

    const hasCompanyInput = Boolean(input.company || input.companyDomain || input.companyWebsite);
    const company =
      hasCompanyInput || !existing?.companyId ? await this.resolveCompany(userId, input, email) : null;
    if (company) data.companyId = company.id;
    else if (input.company === null && options.replaceLists) data.companyId = null;

    const contact = existing
      ? await this.prisma.contact.update({ where: { id: existing.id }, data, include: contactInclude })
      : await this.prisma.contact.create({
          data: { ...(data as Prisma.ContactUncheckedCreateInput), userId, email },
          include: contactInclude,
        });
    return { contact: this.serialize(contact), created: !existing };
  }

  async upsertMany(userId: number, inputs: ContactInput[]) {
    const saved: ReturnType<ContactsService['serialize']>[] = [];
    const failed: { email: string | null | undefined; error: string }[] = [];
    let created = 0;
    for (const input of inputs) {
      try {
        const result = await this.upsert(userId, input);
        saved.push(result.contact);
        if (result.created) created += 1;
      } catch (err) {
        failed.push({ email: input.email, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { created, updated: saved.length - created, contacts: saved, failed };
  }

  async update(userId: number, id: number, input: ContactInput) {
    const contact = await this.require(userId, id);
    if (input.email !== undefined) {
      const email = normalizeEmail(input.email);
      if (!email) throw new BadRequestException('Invalid email');
      if (email !== contact.email) {
        const clash = await this.prisma.contact.findUnique({ where: { userId_email: { userId, email } } });
        if (clash) throw new BadRequestException(`Contact #${clash.id} already uses ${email}`);
        await this.prisma.contact.update({ where: { id }, data: { email } });
        await this.prisma.lead.updateMany({ where: { contactId: id }, data: { hrEmail: email } });
      }
    }
    const result = await this.upsert(userId, { ...input, email: input.email ?? contact.email }, { replaceLists: true });
    return result.contact;
  }

  async findAll(userId: number, query: ContactQuery = {}) {
    const and: Prisma.ContactWhereInput[] = [{ userId }];
    if (query.companyId) and.push({ companyId: query.companyId });
    if (query.company?.trim()) and.push({ company: { name: { contains: query.company.trim() } } });
    if (query.status) {
      and.push({ status: Array.isArray(query.status) ? { in: query.status } : query.status });
    }
    if (query.recruiterType) and.push({ recruiterType: query.recruiterType });
    if (query.minSeniority) and.push({ seniority: { gte: query.minSeniority } });
    if (query.maxSeniority) and.push({ seniority: { lte: query.maxSeniority } });
    if (query.neverContacted) and.push({ contactCount: 0 });
    if (query.search?.trim()) {
      const term = query.search.trim();
      and.push({
        OR: [
          { name: { contains: term } },
          { email: { contains: term } },
          { position: { contains: term } },
          { phone: { contains: term } },
          { notes: { contains: term } },
          { company: { name: { contains: term } } },
        ],
      });
    }

    const orderBy: Prisma.ContactOrderByWithRelationInput[] =
      query.sort === 'recent'
        ? [{ createdAt: 'desc' }]
        : query.sort === 'seniority'
          ? [{ seniority: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }]
          : query.sort === 'last_contacted'
            ? [{ lastContactedAt: { sort: 'desc', nulls: 'last' } }]
            : [{ company: { name: 'asc' } }, { seniority: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }];

    let rows = await this.prisma.contact.findMany({ where: { AND: and }, include: contactInclude, orderBy });

    const matches = (values: string[], needle?: string) =>
      !needle?.trim() || values.some((v) => v.toLowerCase().includes(needle.trim().toLowerCase()));
    rows = rows.filter((row) => matches(toList(row.hiringFor), query.hiringFor) && matches(toList(row.tags), query.tag));

    const offset = query.offset ?? 0;
    const limit = query.limit ?? rows.length;
    return {
      total: rows.length,
      offset,
      contacts: rows.slice(offset, offset + limit).map((row) => this.serialize(row)),
    };
  }

  async findOne(userId: number, id: number) {
    const contact = await this.require(userId, id);
    const leads = await this.prisma.lead.findMany({
      where: { contactId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        campaignId: true,
        role: true,
        company: true,
        subject: true,
        status: true,
        createdAt: true,
        schedules: { orderBy: { id: 'desc' }, take: 1 },
        logs: { orderBy: { sentAt: 'desc' }, take: 3 },
      },
    });
    return { ...this.serialize(contact), leads };
  }

  async remove(userId: number, id: number) {
    await this.require(userId, id);
    await this.prisma.contact.delete({ where: { id } });
    return { id, deleted: true };
  }

  async markContacted(contactId: number) {
    await this.prisma.contact.update({
      where: { id: contactId },
      data: { contactCount: { increment: 1 }, lastContactedAt: new Date() },
    });
    await this.prisma.contact.updateMany({
      where: { id: contactId, status: 'NEW' },
      data: { status: 'CONTACTED' },
    });
  }

  async isBlocked(contactId?: number | null) {
    if (!contactId) return false;
    const contact = await this.prisma.contact.findUnique({ where: { id: contactId }, select: { status: true } });
    return contact?.status === 'DO_NOT_CONTACT';
  }

  /** Creates/updates the contact behind a lead and returns its id. */
  async fromLead(
    userId: number,
    lead: { hrName?: string | null; hrEmail?: string | null; company?: string | null; role?: string | null },
    extra: ContactInput = {},
  ) {
    if (!normalizeEmail(lead.hrEmail)) return null;
    const { contact } = await this.upsert(userId, {
      ...extra,
      name: extra.name ?? lead.hrName,
      email: lead.hrEmail,
      company: extra.company ?? lead.company,
      hiringFor: [...(extra.hiringFor ?? []), ...(lead.role ? [lead.role] : [])],
      source: extra.source ?? 'lead',
    });
    return contact.id;
  }

  async listCompanies(userId: number, query: { search?: string; limit?: number; offset?: number } = {}) {
    const companies = await this.prisma.company.findMany({
      where: {
        userId,
        ...(query.search?.trim()
          ? {
              OR: [
                { name: { contains: query.search.trim() } },
                { domain: { contains: query.search.trim() } },
                { industry: { contains: query.search.trim() } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      include: {
        contacts: { select: { status: true, contactCount: true, lastContactedAt: true, hiringFor: true } },
      },
    });

    const rows = companies.map(({ contacts, nameKey: _key, userId: _user, ...company }) => {
      const last = contacts
        .map((c) => c.lastContactedAt?.getTime() ?? 0)
        .reduce((a, b) => Math.max(a, b), 0);
      return {
        ...company,
        contactCount: contacts.length,
        contactedCount: contacts.filter((c) => c.contactCount > 0).length,
        repliedCount: contacts.filter((c) => ['REPLIED', 'INTERVIEWING', 'OFFER'].includes(c.status)).length,
        lastContactedAt: last ? new Date(last) : null,
        hiringFor: cleanList(contacts.flatMap((c) => toList(c.hiringFor))).slice(0, 15),
      };
    });
    const offset = query.offset ?? 0;
    return { total: rows.length, offset, companies: rows.slice(offset, offset + (query.limit ?? rows.length)) };
  }

  async getCompany(userId: number, id: number) {
    const company = await this.prisma.company.findFirst({ where: { id, userId } });
    if (!company) throw new NotFoundException('Company not found');
    const { contacts } = await this.findAll(userId, { companyId: id, sort: 'seniority' });
    const { nameKey: _key, ...rest } = company;
    return { ...rest, contacts };
  }

  async updateCompany(userId: number, id: number, input: CompanyUpdate) {
    const company = await this.prisma.company.findFirst({ where: { id, userId } });
    if (!company) throw new NotFoundException('Company not found');

    const data: Prisma.CompanyUpdateInput = {};
    if (input.name !== undefined) {
      const name = cleanCompanyName(input.name);
      if (!name) throw new BadRequestException('Company name is required');
      const nameKey = companyKey(name);
      if (nameKey !== company.nameKey) {
        const clash = await this.prisma.company.findUnique({ where: { userId_nameKey: { userId, nameKey } } });
        if (clash) {
          throw new BadRequestException(
            `"${clash.name}" (#${clash.id}) already exists. Merge the two companies instead.`,
          );
        }
      }
      data.name = name;
      data.nameKey = nameKey;
    }
    if (input.domain !== undefined) data.domain = domainFromUrl(input.domain);
    if (input.website !== undefined) data.website = text(input.website);
    for (const field of ['linkedin', 'industry', 'size', 'location', 'notes'] as const) {
      if (input[field] !== undefined) data[field] = text(input[field]);
    }

    await this.prisma.company.update({ where: { id }, data });
    return this.getCompany(userId, id);
  }

  async mergeCompanies(userId: number, targetId: number, sourceIds: number[]) {
    const ids = [...new Set(sourceIds)].filter((id) => id !== targetId);
    if (!ids.length) throw new BadRequestException('Pick at least one other company to merge');
    const companies = await this.prisma.company.findMany({ where: { userId, id: { in: [targetId, ...ids] } } });
    const target = companies.find((c) => c.id === targetId);
    if (!target) throw new NotFoundException('Target company not found');
    const missing = ids.filter((id) => !companies.some((c) => c.id === id));
    if (missing.length) throw new NotFoundException(`Companies not found: ${missing.join(', ')}`);

    const fill: Prisma.CompanyUpdateInput = {};
    for (const field of ['domain', 'website', 'linkedin', 'industry', 'size', 'location', 'notes'] as const) {
      if (!target[field]) {
        const value = companies.find((c) => c.id !== targetId && c[field])?.[field];
        if (value) fill[field] = value;
      }
    }

    await this.prisma.$transaction([
      this.prisma.contact.updateMany({ where: { userId, companyId: { in: ids } }, data: { companyId: targetId } }),
      this.prisma.company.deleteMany({ where: { userId, id: { in: ids } } }),
      this.prisma.company.update({ where: { id: targetId }, data: fill }),
    ]);
    return this.getCompany(userId, targetId);
  }

  async removeCompany(userId: number, id: number) {
    const company = await this.prisma.company.findFirst({ where: { id, userId } });
    if (!company) throw new NotFoundException('Company not found');
    await this.prisma.company.delete({ where: { id } });
    return { id, deleted: true };
  }

  private async resolveCompany(userId: number, input: CompanyInput, email: string) {
    const name = cleanCompanyName(input.company);
    const domain =
      domainFromUrl(input.companyDomain) || domainFromUrl(input.companyWebsite) || companyDomainFromEmail(email);
    if (!name && !domain) return null;

    let company = name
      ? await this.prisma.company.findUnique({ where: { userId_nameKey: { userId, nameKey: companyKey(name) } } })
      : null;
    if (!company && domain) {
      company = await this.prisma.company.findFirst({ where: { userId, domain }, orderBy: { id: 'asc' } });
    }

    const details = {
      website: text(input.companyWebsite),
      linkedin: text(input.companyLinkedin),
      industry: text(input.companyIndustry),
      size: text(input.companySize),
      location: text(input.companyLocation),
    };

    if (!company) {
      const displayName = name || this.nameFromDomain(domain!);
      return this.prisma.company.upsert({
        where: { userId_nameKey: { userId, nameKey: companyKey(displayName) } },
        create: { userId, name: displayName, nameKey: companyKey(displayName), domain, ...details },
        update: {},
      });
    }

    const fill: Prisma.CompanyUpdateInput = {};
    if (!company.domain && domain) fill.domain = domain;
    for (const [field, value] of Object.entries(details) as [keyof typeof details, string | null][]) {
      if (value && !company[field]) fill[field] = value;
    }
    if (Object.keys(fill).length) {
      company = await this.prisma.company.update({ where: { id: company.id }, data: fill });
    }
    return company;
  }

  private nameFromDomain(domain: string) {
    const label = domain.split('.').slice(-2)[0] || domain;
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  private async require(userId: number, id: number) {
    const contact = await this.prisma.contact.findFirst({ where: { id, userId }, include: contactInclude });
    if (!contact) throw new NotFoundException('Contact not found');
    return contact;
  }

  private serialize(contact: ContactRow) {
    const { userId: _user, ...rest } = contact;
    return {
      ...rest,
      hiringFor: toList(contact.hiringFor),
      hiresForCompanies: toList(contact.hiresForCompanies),
      tags: toList(contact.tags),
    };
  }

  private async syncAllFromLeads() {
    const users = await this.prisma.user.findMany({ select: { id: true } });
    for (const { id } of users) {
      const leads = await this.prisma.lead.findMany({
        where: { contactId: null, hrEmail: { not: null }, campaign: { userId: id } },
        orderBy: { id: 'asc' },
      });
      for (const lead of leads) {
        const contactId = await this.fromLead(id, lead).catch(() => null);
        if (!contactId) continue;
        await this.prisma.lead.update({ where: { id: lead.id }, data: { contactId } });
        const sent = await this.prisma.sendLog.findMany({
          where: { leadId: lead.id, status: 'sent' },
          orderBy: { sentAt: 'desc' },
        });
        if (!sent.length) continue;
        const contact = await this.prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
        const last = sent[0].sentAt;
        await this.prisma.contact.update({
          where: { id: contactId },
          data: {
            contactCount: { increment: sent.length },
            lastContactedAt: !contact.lastContactedAt || contact.lastContactedAt < last ? last : undefined,
            status: contact.status === 'NEW' ? 'CONTACTED' : undefined,
          },
        });
      }
      if (leads.length) this.logger.log(`Linked ${leads.length} existing leads to contacts`);
    }
  }
}

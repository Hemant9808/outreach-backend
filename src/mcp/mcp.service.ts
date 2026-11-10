import { HttpException, Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CampaignsService } from '../campaigns/campaigns.service';
import { ContactsService } from '../contacts/contacts.service';
import { LeadsService } from '../leads/leads.service';
import { ProfileService } from '../profile/profile.service';
import { LocalUserService } from '../user/local-user.service';
import { fileSourceSchema, loadFile } from './file-source';

const INSTRUCTIONS = `Outreach Desk: a cold-email tool for job hunting.
- A campaign is a batch of leads (HR contacts). Each lead has a drafted subject + body and a schedule.
- Send modes: IMMEDIATE (send now), SCHEDULED (send once at scheduledAt), RECURRING (send every intervalDays, weekdays only, up to maxSends).
- To create leads from a hiring post the user shares in chat, read it yourself, write the email, and call create_batch. Use create_campaign_from_files only when you have a URL or local path to the file; extraction then runs in the background, so poll get_campaign until status is READY.
- Use bulk_leads to act on a whole group (a campaign, a status, a search, or a list of ids).
- Times are ISO 8601. Always include the offset (e.g. 2026-11-11T10:00:00+05:30). Call get_overview to learn the current server time and timezone.
- Sending emails is irreversible: confirm with the user before send_lead_now, or before bulk send_now/delete on many leads.

Contact directory:
- Every lead with an email is also saved as a contact (deduplicated by email) and grouped under a company. Use save_contacts to store HRs without sending anything.
- Whenever you see contact details, fill as much as you can: name, email, phone, position (their own title), seniority, recruiterType, hiringFor, location, linkedin. Pass them in the lead's "contact" object for create_batch, or directly to save_contacts.
- Company name accuracy matters most. Use the official brand name of the person's employer exactly as written in the post, signature, or company page, cross-checked with the email domain (e.g. "Talent Socio" for @talentsocio.com). Drop legal suffixes (Pvt Ltd, Inc). Never guess or put a role, location, or team in it. If the poster is a recruitment agency hiring for a client, company = the agency, recruiterType = AGENCY, and list the client in hiresForCompanies. Before saving, call list_companies with a search to reuse an existing spelling; fix duplicates with merge_companies.
- Seniority is 1-10 for the contact (not the job): 1-2 intern/coordinator, 3-4 recruiter/HR executive, 5-6 senior recruiter/TA lead, 7-8 TA or HR manager/HRBP, 9 director/VP, 10 CHRO/founder/CEO. Hiring managers are rated by their own level. Leave it out when unsure.
- hiringFor is the list of roles/profiles they hire for (short titles like "Backend Engineer"). New values are merged with existing ones.
- To email existing contacts, pass contactId in each create_batch lead (email/name/company are filled from the contact). Contacts marked DO_NOT_CONTACT are never emailed.`;

const sendSettings = {
  sendMode: z
    .enum(['IMMEDIATE', 'SCHEDULED', 'RECURRING'])
    .default('IMMEDIATE')
    .describe('IMMEDIATE sends right away; SCHEDULED sends once; RECURRING repeats'),
  scheduledAt: z
    .string()
    .optional()
    .describe('ISO time of the first send for SCHEDULED/RECURRING. Defaults to the next 10:00'),
  intervalDays: z.number().int().min(1).optional().describe('RECURRING only: days between sends'),
  maxSends: z.number().int().min(1).max(20).optional().describe('RECURRING cap on total sends (default 3)'),
};

const contactStatus = z.enum([
  'NEW',
  'CONTACTED',
  'REPLIED',
  'INTERVIEWING',
  'OFFER',
  'NOT_INTERESTED',
  'DO_NOT_CONTACT',
]);
const recruiterType = z.enum(['IN_HOUSE', 'AGENCY', 'FREELANCE', 'HIRING_MANAGER', 'UNKNOWN']);

const contactFields = {
  name: z.string().nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish().describe('Include country code when known, e.g. +91 98765 43210'),
  position: z.string().nullish().describe("The contact's own job title, e.g. Talent Acquisition Lead"),
  seniority: z.number().int().min(1).max(10).nullish().describe('1-10, see server instructions'),
  department: z.string().nullish().describe('e.g. Talent Acquisition, Engineering'),
  recruiterType: recruiterType.nullish().describe('AGENCY = recruitment firm hiring for clients'),
  hiringFor: z.array(z.string()).nullish().describe('Roles/profiles they hire for'),
  hiresForCompanies: z.array(z.string()).nullish().describe('Agency recruiters: client companies'),
  location: z.string().nullish(),
  linkedin: z.string().nullish().describe('LinkedIn profile URL'),
  tags: z.array(z.string()).nullish().describe('Free labels, e.g. ["startup", "referral"]'),
  notes: z.string().nullish(),
  source: z.string().nullish().describe('Where you found them, e.g. "LinkedIn post"'),
  sourceUrl: z.string().nullish(),
  status: contactStatus.nullish(),
  company: z.string().nullish().describe("Official brand name of the contact's employer"),
  companyDomain: z.string().nullish().describe('e.g. talentsocio.com'),
  companyWebsite: z.string().nullish(),
  companyLinkedin: z.string().nullish(),
  companyIndustry: z.string().nullish(),
  companySize: z.string().nullish().describe('e.g. 51-200'),
  companyLocation: z.string().nullish(),
};

const { name: _n, email: _e, company: _c, ...contactExtras } = contactFields;

const leadFields = {
  contactId: z.number().int().optional().describe('Email an existing contact; fills hrEmail/hrName/company'),
  contact: z.object(contactExtras).optional().describe('Extra details saved to the contact directory'),
  hrName: z.string().nullish(),
  hrEmail: z.string().nullish().describe('Recipient email. Leads without one are saved as NO_EMAIL'),
  company: z.string().nullish().describe("Official brand name of the HR's employer"),
  role: z.string().nullish(),
  jdSummary: z.string().nullish().describe('Short summary of the job description'),
  subject: z.string().nullish().describe('Email subject'),
  body: z.string().nullish().describe('Plain-text email body. The resume is attached automatically'),
};

const leadStatus = z
  .enum(['ALL', 'ACTIVE', 'STOPPED', 'EXTRACTED', 'NO_EMAIL', 'QUEUED', 'SENT', 'FAILED', 'COMPLETED'])
  .describe('ACTIVE = still has sends pending, STOPPED = paused');

const leadFilters = {
  leadIds: z.array(z.number().int()).optional(),
  campaignId: z.number().int().optional(),
  status: leadStatus.optional(),
  kind: z.enum(['recurring', 'one_time']).optional(),
  search: z.string().optional().describe('Matches email, name, company, or role'),
};

type AnyLead = {
  id: number;
  campaignId: number;
  hrName: string | null;
  hrEmail: string | null;
  company: string | null;
  role: string | null;
  status: string;
  subject: string | null;
  body: string | null;
  jdSummary: string | null;
  schedules?: { id: number; nextRunAt: Date; intervalDays: number | null; sendCount: number; maxSends: number; active: boolean }[];
  logs?: { sentAt: Date; status: string; error: string | null }[];
};

function compactLead(lead: AnyLead, includeDrafts = false) {
  const schedule = [...(lead.schedules ?? [])].sort((a, b) => b.id - a.id)[0] ?? null;
  const lastLog = lead.logs?.[0];
  return {
    id: lead.id,
    campaignId: lead.campaignId,
    hrName: lead.hrName,
    hrEmail: lead.hrEmail,
    company: lead.company,
    role: lead.role,
    status: lead.status,
    schedule: schedule && {
      nextRunAt: schedule.nextRunAt,
      recurring: Boolean(schedule.intervalDays),
      intervalDays: schedule.intervalDays,
      sendCount: schedule.sendCount,
      maxSends: schedule.maxSends,
      active: schedule.active,
    },
    lastSend: lastLog ? { at: lastLog.sentAt, status: lastLog.status, error: lastLog.error } : null,
    ...(includeDrafts
      ? { jdSummary: lead.jdSummary, subject: lead.subject, body: lead.body }
      : {}),
  };
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const detail = typeof response === 'object' ? (response as { message?: unknown }).message : response;
    message = Array.isArray(detail) ? detail.join(', ') : String(detail ?? message);
  }
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

@Injectable()
export class McpService {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly contacts: ContactsService,
    private readonly leads: LeadsService,
    private readonly profile: ProfileService,
    private readonly localUser: LocalUserService,
  ) {}

  listTools() {
    const catalog: { name: string; description: string; readOnly: boolean; destructive: boolean }[] = [];
    this.createServer(catalog);
    return catalog;
  }

  createServer(
    catalog?: { name: string; description: string; readOnly: boolean; destructive: boolean }[],
  ) {
    const server = new McpServer(
      { name: 'outreach-desk', version: '1.0.0' },
      { instructions: INSTRUCTIONS },
    );

    const tool = <Shape extends z.ZodRawShape>(
      name: string,
      description: string,
      inputSchema: Shape,
      handler: (args: z.infer<z.ZodObject<Shape>>, userId: number) => Promise<unknown>,
      annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {},
    ) => {
      catalog?.push({
        name,
        description,
        readOnly: Boolean(annotations.readOnlyHint),
        destructive: Boolean(annotations.destructiveHint),
      });
      server.registerTool(name, { description, inputSchema, annotations }, (async (args: z.infer<z.ZodObject<Shape>>) => {
        try {
          return ok(await handler(args, await this.localUser.id()));
        } catch (error) {
          return fail(error);
        }
      }) as never);
    };

    tool(
      'get_overview',
      'Dashboard: current server time, campaign count, lead counts by status, and the next 20 scheduled sends.',
      {},
      async (_args, userId) => ({
        now: new Date().toISOString(),
        timezone: process.env.TZ,
        ...(await this.leads.summary(userId)),
      }),
      { readOnlyHint: true },
    );

    tool(
      'get_profile',
      'Get the sender profile (name, title, skills, about, LinkedIn, resume) used to write and sign emails.',
      {},
      (_args, userId) => this.profile.get(userId),
      { readOnlyHint: true },
    );

    tool(
      'update_profile',
      'Update the sender profile. Only the fields you pass are changed.',
      {
        name: z.string().optional(),
        email: z.string().optional().describe('Sender email shown in the signature'),
        phone: z.string().optional(),
        title: z.string().optional(),
        skills: z.string().optional(),
        about: z.string().optional(),
        linkedin: z.string().optional(),
        timezone: z.string().optional(),
      },
      (args, userId) => this.profile.update(userId, args),
    );

    tool(
      'upload_resume',
      'Replace the resume that is attached to every outgoing email. The resume is parsed by AI and the profile fields are refreshed from it.',
      { file: fileSourceSchema },
      async ({ file }, userId) => this.profile.uploadResume(userId, await loadFile(file)),
    );

    tool(
      'list_campaigns',
      'List all campaigns (batches) with send mode, status, and lead/sent counts.',
      {},
      (_args, userId) => this.campaigns.findAll(userId),
      { readOnlyHint: true },
    );

    tool(
      'get_campaign',
      'Get one campaign with its uploads and leads. Set includeDrafts to see each email subject/body.',
      { campaignId: z.number().int(), includeDrafts: z.boolean().default(false) },
      async ({ campaignId, includeDrafts }, userId) => {
        const campaign = await this.campaigns.findOne(userId, campaignId);
        return {
          ...campaign,
          uploads: campaign.uploads.map(({ id, originalName, url }) => ({ id, originalName, url })),
          leads: campaign.leads.map((lead) => compactLead(lead, includeDrafts)),
        };
      },
      { readOnlyHint: true },
    );

    tool(
      'create_campaign_from_files',
      'Upload hiring-post screenshots or PDFs (by URL, local path, or base64). Gemini extracts HR contacts and drafts emails in the background, then sends per the send mode. Poll get_campaign until status is READY.',
      { files: z.array(fileSourceSchema).min(1).max(10), ...sendSettings },
      async ({ files, ...settings }, userId) => {
        const loaded = await Promise.all(files.map(loadFile));
        const campaign = await this.campaigns.create(userId, loaded, settings);
        return { id: campaign.id, status: campaign.status, sendMode: campaign.sendMode, scheduledAt: campaign.scheduledAt };
      },
    );

    tool(
      'create_batch',
      'Create a campaign from leads you provide (e.g. extracted from a post the user pasted). Leads with email + subject + body are scheduled per the send mode; IMMEDIATE sends right away. Leads missing a draft are saved but not scheduled.',
      { leads: z.array(z.object(leadFields)).min(1).max(200), ...sendSettings },
      async ({ leads, ...settings }, userId) => {
        const campaign = await this.campaigns.createBatch(userId, { ...settings, leads });
        return { ...campaign, uploads: undefined, leads: campaign.leads.map((lead) => compactLead(lead)) };
      },
    );

    tool(
      'add_leads_to_campaign',
      "Add leads to an existing campaign. They use that campaign's send mode and schedule.",
      { campaignId: z.number().int(), leads: z.array(z.object(leadFields)).min(1).max(200) },
      async ({ campaignId, leads }, userId) => {
        const campaign = await this.campaigns.addLeads(userId, campaignId, leads);
        return { id: campaign.id, leads: campaign.leads.map((lead) => compactLead(lead)) };
      },
    );

    tool(
      'delete_campaign',
      'Delete a campaign and all of its leads, schedules, and send logs.',
      { campaignId: z.number().int() },
      ({ campaignId }, userId) => this.campaigns.remove(userId, campaignId),
      { destructiveHint: true },
    );

    tool(
      'list_leads',
      'List leads with optional filters. Returns compact rows; set includeDrafts to include subject/body.',
      {
        ...leadFilters,
        includeDrafts: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      },
      async ({ includeDrafts, limit, offset, ...filters }, userId) => {
        const leads = await this.leads.findAll(userId, filters);
        return {
          total: leads.length,
          offset,
          leads: leads.slice(offset, offset + limit).map((lead) => compactLead(lead, includeDrafts)),
        };
      },
      { readOnlyHint: true },
    );

    tool(
      'get_lead',
      'Get one lead with its full email draft, schedule, and the last 5 send attempts.',
      { leadId: z.number().int() },
      ({ leadId }, userId) => this.leads.findOne(userId, leadId),
      { readOnlyHint: true },
    );

    tool(
      'update_lead',
      'Edit a lead: recipient, company, role, or the email subject/body. Only passed fields change.',
      { leadId: z.number().int(), ...leadFields },
      ({ leadId, ...fields }, userId) => this.leads.update(userId, leadId, fields),
    );

    tool(
      'delete_lead',
      'Delete a lead and its schedule and send history.',
      { leadId: z.number().int() },
      ({ leadId }, userId) => this.leads.remove(userId, leadId),
      { destructiveHint: true },
    );

    tool(
      'send_lead_now',
      'Send the email to this lead immediately (counts toward its sends).',
      { leadId: z.number().int() },
      ({ leadId }, userId) => this.leads.sendNow(userId, leadId),
    );

    tool(
      'schedule_lead',
      'Schedule (or reschedule) a lead. Pass intervalDays to make it recurring, or null for a one-time send. A time in the past sends now.',
      {
        leadId: z.number().int(),
        nextRunAt: z.string().describe('ISO time with offset'),
        intervalDays: z.number().int().min(1).nullable().optional().describe('Omit to keep current, null = one-time'),
        maxSends: z.number().int().min(1).max(20).optional(),
      },
      ({ leadId, ...schedule }, userId) => this.leads.reschedule(userId, leadId, schedule),
    );

    tool(
      'pause_lead',
      'Stop future sends for a lead.',
      { leadId: z.number().int() },
      ({ leadId }, userId) => this.leads.pause(userId, leadId),
    );

    tool(
      'resume_lead',
      'Resume a paused lead. If its next send time has passed, it moves to the next 10:00.',
      { leadId: z.number().int() },
      ({ leadId }, userId) => this.leads.resume(userId, leadId),
    );

    tool(
      'bulk_leads',
      'Apply one action to a group of leads chosen by ids, campaign, status, kind, or search (filters combine). Actions: send_now, schedule (needs nextRunAt; staggerMinutes spaces sends apart; intervalDays makes them recurring), pause, resume, delete. Set all=true to target every lead.',
      {
        action: z.enum(['send_now', 'schedule', 'pause', 'resume', 'delete']),
        ...leadFilters,
        all: z.boolean().optional(),
        nextRunAt: z.string().optional().describe('schedule only: ISO time of the first send'),
        intervalDays: z.number().int().min(1).nullable().optional().describe('schedule only: null = one-time'),
        maxSends: z.number().int().min(1).max(20).optional(),
        staggerMinutes: z.number().int().min(0).max(1440).optional(),
      },
      ({ action, nextRunAt, intervalDays, maxSends, staggerMinutes, ...target }, userId) =>
        this.leads.bulk(userId, target, action, { nextRunAt, intervalDays, maxSends, staggerMinutes }),
      { destructiveHint: true },
    );

    tool(
      'save_contacts',
      'Add or update HR contacts in the directory without sending anything. Matched by email: provided fields overwrite, hiringFor/tags/hiresForCompanies are merged. Companies are matched by name or email domain and created if new.',
      { contacts: z.array(z.object({ ...contactFields, email: z.string() })).min(1).max(200) },
      ({ contacts }, userId) => this.contacts.upsertMany(userId, contacts),
    );

    tool(
      'list_contacts',
      'Search the contact directory. Filters combine. Sorted by company by default.',
      {
        search: z.string().optional().describe('Matches name, email, phone, position, notes, or company'),
        companyId: z.number().int().optional(),
        company: z.string().optional().describe('Company name contains'),
        status: contactStatus.optional(),
        recruiterType: recruiterType.optional(),
        minSeniority: z.number().int().min(1).max(10).optional(),
        maxSeniority: z.number().int().min(1).max(10).optional(),
        hiringFor: z.string().optional().describe('Role they hire for contains, e.g. "backend"'),
        tag: z.string().optional(),
        neverContacted: z.boolean().optional(),
        sort: z.enum(['company', 'recent', 'seniority', 'last_contacted']).optional(),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      },
      (query, userId) => this.contacts.findAll(userId, query),
      { readOnlyHint: true },
    );

    tool(
      'get_contact',
      'Get one contact with company and their last 20 leads/emails.',
      { contactId: z.number().int() },
      ({ contactId }, userId) => this.contacts.findOne(userId, contactId),
      { readOnlyHint: true },
    );

    tool(
      'update_contact',
      'Edit a contact. Passed fields replace current values (lists are replaced, not merged; null clears). Use status to track the pipeline: REPLIED, INTERVIEWING, OFFER, NOT_INTERESTED, or DO_NOT_CONTACT to block all emails.',
      { contactId: z.number().int(), ...contactFields },
      ({ contactId, ...fields }, userId) => this.contacts.update(userId, contactId, fields),
    );

    tool(
      'delete_contact',
      'Delete a contact. Their past leads stay but are unlinked.',
      { contactId: z.number().int() },
      ({ contactId }, userId) => this.contacts.remove(userId, contactId),
      { destructiveHint: true },
    );

    tool(
      'list_companies',
      'List companies with contact counts, how many were contacted/replied, last contact time, and roles they hire for.',
      {
        search: z.string().optional().describe('Matches name, domain, or industry'),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      },
      (query, userId) => this.contacts.listCompanies(userId, query),
      { readOnlyHint: true },
    );

    tool(
      'get_company',
      'Get a company and all of its HR contacts, most senior first.',
      { companyId: z.number().int() },
      ({ companyId }, userId) => this.contacts.getCompany(userId, companyId),
      { readOnlyHint: true },
    );

    tool(
      'update_company',
      'Fix a company name or add details. Renaming to an existing company fails; use merge_companies instead.',
      {
        companyId: z.number().int(),
        name: z.string().optional(),
        domain: z.string().nullish(),
        website: z.string().nullish(),
        linkedin: z.string().nullish(),
        industry: z.string().nullish(),
        size: z.string().nullish(),
        location: z.string().nullish(),
        notes: z.string().nullish(),
      },
      ({ companyId, ...fields }, userId) => this.contacts.updateCompany(userId, companyId, fields),
    );

    tool(
      'merge_companies',
      'Merge duplicate companies into one: moves all contacts to targetId and deletes the others.',
      { targetId: z.number().int(), sourceIds: z.array(z.number().int()).min(1) },
      ({ targetId, sourceIds }, userId) => this.contacts.mergeCompanies(userId, targetId, sourceIds),
      { destructiveHint: true },
    );

    tool(
      'delete_company',
      'Delete a company. Its contacts are kept without a company.',
      { companyId: z.number().int() },
      ({ companyId }, userId) => this.contacts.removeCompany(userId, companyId),
      { destructiveHint: true },
    );

    return server;
  }
}

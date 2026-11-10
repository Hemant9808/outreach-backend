import { GoogleGenerativeAI } from '@google/generative-ai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type CandidateProfile = {
  name: string;
  email: string;
  phone?: string | null;
  title?: string | null;
  skills?: string | null;
  about?: string | null;
  linkedin?: string | null;
};

export type ParsedResume = {
  name?: string;
  email?: string;
  phone?: string;
  title?: string;
  skills?: string;
  about?: string;
  linkedin?: string;
};

export type ExtractedLead = {
  hrName: string | null;
  hrEmail: string | null;
  company: string | null;
  role: string | null;
  jdSummary: string;
  subject: string;
  body: string;
  hrPhone: string | null;
  hrPosition: string | null;
  seniority: number | null;
  recruiterType: 'IN_HOUSE' | 'AGENCY' | 'FREELANCE' | 'HIRING_MANAGER' | 'UNKNOWN';
  hiringFor: string[];
  hiresForCompanies: string[];
  location: string | null;
};

const RECRUITER_TYPES = ['IN_HOUSE', 'AGENCY', 'FREELANCE', 'HIRING_MANAGER', 'UNKNOWN'] as const;

@Injectable()
export class GeminiService {
  private readonly client: GoogleGenerativeAI;
  private readonly modelName: string;

  constructor(config: ConfigService) {
    this.client = new GoogleGenerativeAI(config.get<string>('GEMINI_API_KEY') || '');
    this.modelName = config.get<string>('GEMINI_MODEL') || 'gemini-3.6-flash';
  }

  async extractFromFile(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
    profile: CandidateProfile,
  ): Promise<ExtractedLead[]> {
    const model = this.client.getGenerativeModel({
      model: this.modelName,
      generationConfig: { temperature: 0.3 },
    });

    const prompt = this.buildPrompt(profile, fileName);
    console.log("prompt",prompt);
    const result = await model.generateContent([
      { text: prompt },
      {
        inlineData: {
          mimeType: mimeType || 'image/jpeg',
          data: buffer.toString('base64'),
        },
      },
    ]);
    const text = result.response.text();
    console.log("text",text);
    return this.parseLeads(text);
  }

  async parseResume(buffer: Buffer, mimeType: string): Promise<ParsedResume> {
    const model = this.client.getGenerativeModel({
      model: this.modelName,
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    });

    const prompt = `Read this resume and extract the candidate's profile.

Rules:
- Copy contact details exactly as written. Never invent values; use null when absent.
- "title": current or most recent job title (e.g. "Full Stack Developer").
- "skills": comma-separated list of the key technical skills, most important first, max 20.
- "about": 3-5 sentence professional summary in first person covering years of experience, notable roles/companies, and impact. Plain text.
- "linkedin": full LinkedIn URL if present.

Return ONLY JSON:
{"name": string|null, "email": string|null, "phone": string|null, "title": string|null, "skills": string|null, "about": string|null, "linkedin": string|null}`;

    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { mimeType: mimeType || 'application/pdf', data: buffer.toString('base64') } },
    ]);
    return this.parseResumeJson(result.response.text());
  }

  private parseResumeJson(raw: string): ParsedResume {
    const json = raw.replace(/```json|```/g, '').trim();
    const start = json.indexOf('{');
    const end = json.lastIndexOf('}');
    if (start === -1 || end === -1) return {};
    try {
      const parsed = JSON.parse(json.slice(start, end + 1));
      const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      return {
        name: pick(parsed.name),
        email: pick(parsed.email)?.toLowerCase(),
        phone: pick(parsed.phone),
        title: pick(parsed.title),
        skills: pick(parsed.skills),
        about: pick(parsed.about),
        linkedin: pick(parsed.linkedin),
      };
    } catch {
      return {};
    }
  }

  private buildPrompt(profile: CandidateProfile, fileName: string) {
    return `You extract hiring leads from a screenshot or PDF of an HR / recruiting post (LinkedIn, Instagram, WhatsApp, job poster, etc.).

Candidate (use this to write the cold email):
- Name: ${profile.name}
- Email: ${profile.email}
- Phone: ${profile.phone || 'n/a'}
- Title: ${profile.title || 'n/a'}
- Skills: ${profile.skills || 'n/a'}
- About: ${profile.about || 'n/a'}
- LinkedIn: ${profile.linkedin || 'n/a'}

Source file: ${fileName}

Rules:
- Extract every distinct job / HR contact you can see.
- If an email is visible, copy it exactly. Never invent an email.
- If there is no email, still return the lead with hrEmail as null.
- Write a short professional cold email tailored to that JD. Plain text only. No markdown.
- Mention 1-2 specifics from the JD. Keep it under 160 words.
- Sign off with the candidate's name, phone, and LinkedIn when available.
- Do not mention that you are an AI or that the post was a screenshot.
- "company" is the employer of the person who posted (the HR's company), using its official brand name exactly as written in the post, signature, or email domain. Drop legal suffixes like "Pvt Ltd". Never guess. If the poster is a recruitment agency hiring for a client, company = the agency, recruiterType = "AGENCY", and put the client in hiresForCompanies.
- "hrPosition": the poster's own job title (e.g. "Talent Acquisition Lead"), not the role being hired.
- "seniority": the poster's seniority 1-10 (1-2 intern/coordinator, 3-4 recruiter/HR executive, 5-6 senior recruiter/TA lead, 7-8 TA/HR manager or HRBP, 9 director/VP, 10 CHRO/founder/CEO). null if unknown.
- "hiringFor": every role/profile they are hiring for, short titles (e.g. ["Backend Engineer", "SDE 2"]).

Return ONLY valid JSON in this shape:
{
  "leads": [
    {
      "hrName": "string or null",
      "hrEmail": "string or null",
      "hrPhone": "string or null",
      "hrPosition": "string or null",
      "seniority": "number 1-10 or null",
      "recruiterType": "IN_HOUSE | AGENCY | FREELANCE | HIRING_MANAGER | UNKNOWN",
      "company": "string or null",
      "hiresForCompanies": ["string"],
      "location": "string or null",
      "role": "string or null",
      "hiringFor": ["string"],
      "jdSummary": "string",
      "subject": "string",
      "body": "string"
    }
  ]
}`;
  }

  private parseLeads(raw: string): ExtractedLead[] {
    const json = raw.replace(/```json|```/g, '').trim();
    const start = json.indexOf('{');
    const end = json.lastIndexOf('}');
    if (start === -1 || end === -1) return [];

    try {
      const parsed = JSON.parse(json.slice(start, end + 1));
      const leads = Array.isArray(parsed?.leads) ? parsed.leads : [];
      return leads.map((lead) => ({
        hrName: lead.hrName || null,
        hrEmail: lead.hrEmail || null,
        company: lead.company || null,
        role: lead.role || null,
        jdSummary: lead.jdSummary || '',
        subject: lead.subject || 'Application for the open role',
        body: lead.body || '',
        hrPhone: lead.hrPhone || null,
        hrPosition: lead.hrPosition || null,
        seniority: lead.seniority != null && Number.isInteger(Number(lead.seniority))
          ? Math.min(10, Math.max(1, Number(lead.seniority)))
          : null,
        recruiterType: RECRUITER_TYPES.includes(lead.recruiterType) ? lead.recruiterType : 'UNKNOWN',
        hiringFor: Array.isArray(lead.hiringFor) ? lead.hiringFor.filter((v) => typeof v === 'string') : [],
        hiresForCompanies: Array.isArray(lead.hiresForCompanies)
          ? lead.hiresForCompanies.filter((v) => typeof v === 'string')
          : [],
        location: lead.location || null,
      }));
    } catch {
      return [];
    }
  }
}

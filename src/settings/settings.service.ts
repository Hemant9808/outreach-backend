import { BadRequestException, Injectable } from '@nestjs/common';
import { encrypt } from '../common/utils/crypto';
import { MailService, SmtpConfig } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

export type EmailSettingsInput = {
  host?: string;
  port?: number | string;
  secure?: boolean;
  username?: string;
  password?: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async getEmail(userId: number) {
    const s = await this.prisma.emailSettings.findUnique({ where: { userId } });
    if (!s) return { configured: false, hasPassword: false };
    return {
      configured: true,
      host: s.host,
      port: s.port,
      secure: s.secure,
      username: s.username,
      hasPassword: Boolean(s.passwordEnc),
      fromName: s.fromName,
      fromEmail: s.fromEmail,
      replyTo: s.replyTo,
      verifiedAt: s.verifiedAt,
      updatedAt: s.updatedAt,
    };
  }

  async saveEmail(userId: number, input: EmailSettingsInput) {
    const existing = await this.prisma.emailSettings.findUnique({ where: { userId } });
    const cfg = this.normalize(input, existing?.passwordEnc ? 'keep' : null);

    const data = {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      username: cfg.username,
      fromName: cfg.fromName,
      fromEmail: cfg.fromEmail,
      replyTo: cfg.replyTo,
      verifiedAt: null,
      ...(cfg.password !== 'keep' ? { passwordEnc: encrypt(cfg.password) } : {}),
    };

    if (existing) {
      await this.prisma.emailSettings.update({ where: { userId }, data });
    } else {
      await this.prisma.emailSettings.create({
        data: { ...data, userId, passwordEnc: encrypt(cfg.password) },
      });
    }
    return this.getEmail(userId);
  }

  async testEmail(userId: number, input: EmailSettingsInput & { sendTo?: string }) {
    const existing = await this.prisma.emailSettings.findUnique({ where: { userId } });
    const hasInput = Boolean(input.host || input.username);
    let cfg: SmtpConfig | null;

    if (hasInput) {
      const normalized = this.normalize(input, existing?.passwordEnc ? 'keep' : null);
      if (normalized.password === 'keep') {
        const saved = await this.mail.configFor(userId);
        normalized.password = saved?.password || '';
      }
      cfg = normalized;
    } else {
      cfg = await this.mail.configFor(userId);
    }
    if (!cfg) throw new BadRequestException('Enter SMTP details first');

    const transport = this.mail.transport(cfg);
    try {
      await transport.verify();
    } catch (err) {
      return { ok: false, stage: 'connect', error: this.explain(err) };
    }

    const to = input.sendTo?.trim() || cfg.fromEmail || cfg.username;
    try {
      await transport.sendMail({
        from: this.mail.fromAddress(cfg),
        to,
        subject: 'Outreach Desk — SMTP test',
        text: 'Your email settings work. Outreach Desk can now send cold emails from this account.',
      });
    } catch (err) {
      return { ok: false, stage: 'send', error: this.explain(err) };
    }

    if (existing && !hasInput) {
      await this.prisma.emailSettings.update({ where: { userId }, data: { verifiedAt: new Date() } });
    }
    return { ok: true, sentTo: to };
  }

  async deleteEmail(userId: number) {
    await this.prisma.emailSettings.deleteMany({ where: { userId } });
    return { configured: false, hasPassword: false };
  }

  private normalize(input: EmailSettingsInput, fallbackPassword: 'keep' | null) {
    const host = input.host?.trim();
    const username = input.username?.trim();
    const port = Number(input.port || 587);
    if (!host) throw new BadRequestException('SMTP host is required');
    if (!username) throw new BadRequestException('Username is required');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BadRequestException('Port must be between 1 and 65535');
    }
    const password = input.password ? input.password : fallbackPassword;
    if (!password) throw new BadRequestException('Password is required');

    const fromEmail = input.fromEmail?.trim() || null;
    const replyTo = input.replyTo?.trim() || null;
    if (fromEmail && !EMAIL_RE.test(fromEmail)) throw new BadRequestException('From email is not valid');
    if (replyTo && !EMAIL_RE.test(replyTo)) throw new BadRequestException('Reply-to email is not valid');

    return {
      host,
      port,
      secure: input.secure ?? port === 465,
      username,
      password,
      fromName: input.fromName?.trim() || null,
      fromEmail,
      replyTo,
    };
  }

  private explain(err: unknown) {
    const e = err as { code?: string; responseCode?: number; message?: string };
    if (e.code === 'EAUTH' || e.responseCode === 535) {
      return 'Authentication failed. Check the username and password (Gmail needs an App Password).';
    }
    if (e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' || e.code === 'ESOCKET') {
      return 'Could not reach the SMTP server. Check host, port and the SSL/TLS setting.';
    }
    if (e.code === 'EDNS' || e.code === 'ENOTFOUND') return 'SMTP host not found.';
    return e.message || 'Unknown SMTP error';
  }
}

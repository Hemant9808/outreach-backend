import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { decrypt } from '../common/utils/crypto';
import { PrismaService } from '../prisma/prisma.service';

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromName?: string | null;
  fromEmail?: string | null;
  replyTo?: string | null;
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async configFor(userId: number): Promise<SmtpConfig | null> {
    const saved = await this.prisma.emailSettings.findUnique({ where: { userId } });
    if (saved) {
      return {
        host: saved.host,
        port: saved.port,
        secure: saved.secure,
        username: saved.username,
        password: decrypt(saved.passwordEnc),
        fromName: saved.fromName,
        fromEmail: saved.fromEmail,
        replyTo: saved.replyTo,
      };
    }

    const host = this.config.get<string>('SMTP_HOST');
    const username = this.config.get<string>('SMTP_USER');
    if (!host || !username) return null;
    const port = Number(this.config.get('SMTP_PORT') || 587);
    return {
      host,
      port,
      secure: port === 465,
      username,
      password: this.config.get<string>('SMTP_PASS') || '',
      fromEmail: this.config.get<string>('SMTP_FROM') || username,
    };
  }

  transport(cfg: SmtpConfig) {
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.username, pass: cfg.password },
      connectionTimeout: 15000,
    });
  }

  fromAddress(cfg: SmtpConfig) {
    const email = cfg.fromEmail || cfg.username;
    return cfg.fromName ? { name: cfg.fromName, address: email } : email;
  }

  async sendColdEmail(opts: {
    userId: number;
    to: string;
    subject: string;
    text: string;
    resumeUrl?: string | null;
    resumeFilename?: string | null;
  }) {
    const cfg = await this.configFor(opts.userId);
    if (!cfg) {
      throw new BadRequestException('Email sending is not configured. Add SMTP details in Settings → Email.');
    }

    const attachments: { filename: string; path: string }[] = [];
    if (opts.resumeUrl) {
      attachments.push({
        filename: opts.resumeFilename || 'Resume.pdf',
        path: opts.resumeUrl,
      });
    }

    const info = await this.transport(cfg).sendMail({
      from: this.fromAddress(cfg),
      replyTo: cfg.replyTo || undefined,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      attachments,
    });

    this.logger.log(`Sent mail to ${opts.to} id=${info.messageId}`);
    return { id: info.messageId };
  }
}

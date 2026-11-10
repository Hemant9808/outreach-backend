import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CloudinaryService, FileInput } from '../cloudinary/cloudinary.service';
import { GeminiService } from '../gemini/gemini.service';
import { PrismaService } from '../prisma/prisma.service';

export type ProfileUpdate = {
  name?: string;
  email?: string;
  phone?: string;
  title?: string;
  skills?: string;
  about?: string;
  linkedin?: string;
  timezone?: string;
};

const profileSelect = {
  id: true,
  email: true,
  name: true,
  phone: true,
  title: true,
  skills: true,
  about: true,
  linkedin: true,
  resumeUrl: true,
  resumeFilename: true,
  timezone: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

function optional(value: string | undefined) {
  return value === undefined ? undefined : value.trim() || null;
}

const RESUME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly gemini: GeminiService,
  ) {}

  async get(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: profileSelect,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async update(userId: number, data: ProfileUpdate) {
    const name = data.name?.trim();
    if (data.name !== undefined && !name) {
      throw new BadRequestException('Full name is required');
    }
    const email = data.email?.trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Enter a valid email address');
    }

    try {
      return await this.prisma.user.update({
        where: { id: userId },
        data: {
          name,
          email: email || undefined,
          phone: optional(data.phone),
          title: optional(data.title),
          skills: optional(data.skills),
          about: optional(data.about),
          linkedin: optional(data.linkedin),
          timezone: data.timezone?.trim() || undefined,
        },
        select: profileSelect,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That email is already in use');
      }
      throw err;
    }
  }

  async uploadResume(userId: number, file: FileInput) {
    if (!file) {
      throw new BadRequestException('Resume file is required');
    }
    if (!RESUME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('Upload a PDF, PNG, JPG or WEBP file');
    }

    const [uploaded, parsed] = await Promise.all([
      this.cloudinary.uploadBuffer(file, 'mail/resumes'),
      this.gemini.parseResume(file.buffer, file.mimetype).catch((err) => {
        this.logger.warn(`Resume parsing failed: ${err instanceof Error ? err.message : err}`);
        return null;
      }),
    ]);

    const current = await this.get(userId);
    const fields: Prisma.UserUpdateInput = {};
    if (parsed) {
      if (parsed.name) fields.name = parsed.name;
      if (parsed.phone) fields.phone = parsed.phone;
      if (parsed.title) fields.title = parsed.title;
      if (parsed.skills) fields.skills = parsed.skills;
      if (parsed.about) fields.about = parsed.about;
      if (parsed.linkedin) fields.linkedin = parsed.linkedin;
      if (parsed.email && parsed.email !== current.email) {
        const taken = await this.prisma.user.count({
          where: { email: parsed.email, NOT: { id: userId } },
        });
        if (!taken) fields.email = parsed.email;
      }
    }

    const profile = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...fields,
        resumeUrl: uploaded.secure_url,
        resumePublicId: uploaded.public_id,
        resumeFilename: file.originalname,
      },
      select: profileSelect,
    });

    return {
      profile,
      parsed: Boolean(parsed),
      updatedFields: Object.keys(fields),
    };
  }
}

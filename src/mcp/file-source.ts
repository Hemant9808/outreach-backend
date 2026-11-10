import { BadRequestException } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { basename, extname } from 'path';
import { z } from 'zod';
import { FileInput } from '../cloudinary/cloudinary.service';

const MAX_BYTES = 12 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export const fileSourceSchema = z
  .object({
    url: z.string().url().optional().describe('Public http(s) URL of the file'),
    path: z
      .string()
      .optional()
      .describe('Absolute path on the machine running the API, e.g. C:\\Users\\me\\Downloads\\post.png'),
    base64: z.string().optional().describe('Base64 file content (no data: prefix needed)'),
    filename: z.string().optional().describe('File name with extension, e.g. post.png'),
    mimeType: z.string().optional().describe('e.g. image/png or application/pdf'),
  })
  .describe('Provide exactly one of url, path, or base64');

export type FileSource = z.infer<typeof fileSourceSchema>;

export async function loadFile(source: FileSource): Promise<FileInput> {
  let buffer: Buffer;
  let name = source.filename;
  let mimetype = source.mimeType;

  if (source.path) {
    buffer = await readFile(source.path);
    name ||= basename(source.path);
  } else if (source.url) {
    const response = await fetch(source.url);
    if (!response.ok) {
      throw new BadRequestException(`Could not download ${source.url} (${response.status})`);
    }
    buffer = Buffer.from(await response.arrayBuffer());
    mimetype ||= response.headers.get('content-type')?.split(';')[0] || undefined;
    name ||= basename(new URL(source.url).pathname) || 'upload';
  } else if (source.base64) {
    buffer = Buffer.from(source.base64.replace(/^data:[^,]+,/, ''), 'base64');
  } else {
    throw new BadRequestException('Each file needs url, path, or base64');
  }

  if (buffer.length > MAX_BYTES) throw new BadRequestException(`${name} is larger than 12 MB`);

  name ||= 'upload';
  mimetype ||= MIME_BY_EXT[extname(name).toLowerCase()] || 'application/octet-stream';
  if (!extname(name)) {
    const ext = Object.entries(MIME_BY_EXT).find(([, mime]) => mime === mimetype)?.[0];
    if (ext) name += ext;
  }
  return { buffer, mimetype, originalname: name };
}

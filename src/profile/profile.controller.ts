import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { LocalUserService } from '../user/local-user.service';
import { ProfileService, ProfileUpdate } from './profile.service';

@Controller('profile')
export class ProfileController {
  constructor(
    private readonly profile: ProfileService,
    private readonly localUser: LocalUserService,
  ) {}

  @Get()
  async get() {
    return this.profile.get(await this.localUser.id());
  }

  @Patch()
  async update(@Body() body: ProfileUpdate) {
    return this.profile.update(await this.localUser.id(), body);
  }

  @Post('resume')
  @UseInterceptors(
    FileInterceptor('resume', {
      storage: memoryStorage(),
      limits: { fileSize: 12 * 1024 * 1024 },
    }),
  )
  async uploadResume(@UploadedFile() file: Express.Multer.File) {
    return this.profile.uploadResume(await this.localUser.id(), file);
  }
}

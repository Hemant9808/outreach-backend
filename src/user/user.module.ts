import { Global, Module } from '@nestjs/common';
import { LocalUserService } from './local-user.service';

@Global()
@Module({
  providers: [LocalUserService],
  exports: [LocalUserService],
})
export class UserModule {}

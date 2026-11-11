import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  process.env.TZ = process.env.APP_TZ || 'Asia/Kolkata';

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser('json', { limit: '40mb' });
  const allowedOrigins = [
    'http://localhost:5173',
    'https://outreach-frontend-dybpzpa4z-hemant-kumars-projects-ca694d0b.vercel.app',
    process.env.FRONTEND_URL,
  ].filter((origin, index, list): origin is string =>
    Boolean(origin) && list.indexOf(origin) === index,
  );
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}`);
  console.log(`MCP endpoint on http://localhost:${port}/mcp`);
}

bootstrap();

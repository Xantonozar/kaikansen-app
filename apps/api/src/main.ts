import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { applyHttpSetup } from './http/http-setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Compression + Cache-Control policy (perf problem 10). Applied
  // here AND in the e2e harness via the same helper.
  applyHttpSetup(app);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Kaikansen API')
    .setDescription('Kaikansen mobile backend (new NestJS API, Gate 5 prototype)')
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') ?? 4000;
  await app.listen(port);
}
void bootstrap();

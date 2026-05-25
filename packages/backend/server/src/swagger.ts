import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { env } from './base';

export function setupSwagger(app: NestExpressApplication) {
  const docConfig = new DocumentBuilder()
    .setTitle('AFFiNE API')
    .setDescription(`AFFiNE Server ${env.version} API documentation`)
    .setVersion(`${env.version}`)
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, docConfig);
  SwaggerModule.setup('/api/docs', app, documentFactory, {
    useGlobalPrefix: true,
    swaggerOptions: { persistAuthorization: true },
  });
}

import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: NestExpressApplication) {
  const docConfig = new DocumentBuilder()
    .setTitle('AFFiNE API')
    .setDescription(`AFFiNE Server ${globalThis.env.version} API documentation`)
    .setVersion(`${globalThis.env.version}`)
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, docConfig);
  SwaggerModule.setup('/api/docs', app, documentFactory, {
    useGlobalPrefix: true,
    swaggerOptions: { persistAuthorization: true },
  });
}

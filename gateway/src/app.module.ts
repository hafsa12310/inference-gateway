import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import * as Joi from 'joi';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        PORT: Joi.number().default(3000),
        REDIS_URL: Joi.string().uri().required(),
        DATABASE_URL: Joi.string().uri().required(),
      }),
    }),
    PrometheusModule.register(), // exposes GET /metrics
    HealthModule,
  ],
})
export class AppModule {}
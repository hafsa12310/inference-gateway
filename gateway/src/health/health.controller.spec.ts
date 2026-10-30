import { Test } from '@nestjs/testing';
import { HealthCheckService } from '@nestjs/terminus';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  const mockHealthService = {
    check: jest
      .fn()
      .mockResolvedValue({ status: 'ok', info: {}, error: {}, details: {} }),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthCheckService, useValue: mockHealthService }],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('returns ok status', async () => {
    const result = await controller.check();
    expect(result.status).toBe('ok');
  });
});

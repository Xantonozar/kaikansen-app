import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns the ok health payload', () => {
    const controller = new HealthController();
    expect(controller.health()).toEqual({
      status: 'ok',
      service: 'kaikansen-api',
    });
  });
});

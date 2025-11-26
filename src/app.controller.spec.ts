import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
    }).compile();

    appController = module.get<AppController>(AppController);
  });

  describe('healthCheck', () => {
    it('should return health status', () => {
      const result = appController.healthCheck();

      expect(result).toHaveProperty('status', 'ok');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('uptime');

      // Validate timestamp is a valid ISO string
      expect(() => new Date(result.timestamp)).not.toThrow();

      // Validate uptime is a number
      expect(typeof result.uptime).toBe('number');
    });
  });
});

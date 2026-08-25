import { Module } from '@nestjs/common';

import { CommonModule } from '../common/common.module.js';
import { AlertsController } from './alerts.controller.js';

/** Boundary for future alert command controllers and application services. */
@Module({
  imports: [CommonModule],
  controllers: [AlertsController],
})
export class AlertsModule {}

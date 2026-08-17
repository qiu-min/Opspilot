import { Module } from '@nestjs/common';

import { CommonModule } from '../common/common.module.js';
import { IncidentsController } from './incidents.controller.js';

/** Boundary for future incident query controllers and application services. */
@Module({
  imports: [CommonModule],
  controllers: [IncidentsController],
})
export class IncidentsModule {}

import { Module } from '@nestjs/common';

import { SessionsController } from './sessions.controller.js';
import { TurnsController } from '../turns/turns.controller.js';

@Module({
  controllers: [SessionsController, TurnsController],
})
export class SessionsModule {}

import { DynamicModule, Module } from '@nestjs/common';

import {
  ApplicationBindingsModule,
  type ApplicationBindingsOptions,
} from './application-bindings.module.js';
import { CommonModule } from './common/common.module.js';
import { SessionsModule } from './sessions/sessions.module.js';

@Module({
  imports: [CommonModule, SessionsModule],
})
export class ApiModule {
  static register(bindings: ApplicationBindingsOptions): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        CommonModule,
        SessionsModule,
        ApplicationBindingsModule.register(bindings),
      ],
    };
  }
}

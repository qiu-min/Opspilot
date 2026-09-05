import { DynamicModule, Module } from '@nestjs/common';

import {
  ApplicationBindingsModule,
  type ApplicationBindingsOptions,
} from './application-bindings.module.js';
import { CommonModule } from './common/common.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { SessionsModule } from './sessions/sessions.module.js';

@Module({
  imports: [CommonModule, ConversationsModule, SessionsModule],
})
export class ApiModule {
  static register(bindings: ApplicationBindingsOptions): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        CommonModule,
        ConversationsModule,
        SessionsModule,
        ApplicationBindingsModule.register(bindings),
      ],
    };
  }
}

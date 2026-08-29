import { DynamicModule, Module } from '@nestjs/common';

import {
  ApplicationBindingsModule,
  type ApplicationBindingsOptions,
} from './application-bindings.module.js';
import { CommonModule } from './common/common.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';

@Module({
  imports: [CommonModule, ConversationsModule],
})
export class ApiModule {
  static register(bindings: ApplicationBindingsOptions): DynamicModule {
    return {
      module: ApiModule,
      imports: [CommonModule, ConversationsModule, ApplicationBindingsModule.register(bindings)],
    };
  }
}

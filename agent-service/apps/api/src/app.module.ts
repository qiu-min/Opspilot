import { DynamicModule, Module } from '@nestjs/common';

import {
  ApplicationBindingsModule,
  type ApplicationBindingsOptions,
} from './application-bindings.module.js';
import { CommonModule } from './common/common.module.js';

@Module({
  imports: [CommonModule],
})
export class ApiModule {
  static register(bindings: ApplicationBindingsOptions): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        CommonModule,
        ApplicationBindingsModule.register(bindings),
      ],
    };
  }
}

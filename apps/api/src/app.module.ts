import { DynamicModule, Module } from '@nestjs/common';

import { AlertsModule } from './alerts/alerts.module.js';
import {
  ApplicationBindingsModule,
  type ApplicationBindingsOptions,
} from './application-bindings.module.js';
import { CommonModule } from './common/common.module.js';
import { IncidentsModule } from './incidents/incidents.module.js';

@Module({
  imports: [CommonModule, AlertsModule, IncidentsModule],
})
export class ApiModule {
  static register(bindings: ApplicationBindingsOptions): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        CommonModule,
        ApplicationBindingsModule.register(bindings),
        AlertsModule,
        IncidentsModule,
      ],
    };
  }
}

import { DynamicModule, Global, Module, type InjectionToken, type Provider } from '@nestjs/common';

export interface ApplicationBindingsOptions {
  readonly providers: readonly Provider[];
  readonly exports: readonly InjectionToken[];
}

/**
 * Receives application service bindings from the external composition root.
 * This module deliberately has no dependency on a persistence implementation.
 */
@Global()
@Module({})
export class ApplicationBindingsModule {
  static register(options: ApplicationBindingsOptions): DynamicModule {
    return {
      module: ApplicationBindingsModule,
      providers: [...options.providers],
      exports: [...options.exports],
    };
  }
}

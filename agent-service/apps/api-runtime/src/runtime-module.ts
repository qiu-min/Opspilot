import { ApiModule } from '@opspilot/api';
export function createApiRuntimeModule() {
  return ApiModule.register({ providers: [], exports: [] });
}

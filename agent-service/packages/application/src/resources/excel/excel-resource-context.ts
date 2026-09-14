import type { Session } from '@opspilot/domain';

import type { ExcelResource } from '../../tools/excel-resource.js';
import type { ExcelSourceResourceStore } from './excel-source-resource-store.js';

/** All source locators available to one Turn, with the Session default identified separately. */
export interface ExcelResourceContext {
  readonly resources: readonly ExcelResource[];
  readonly activeResourceId: string | null;
  readonly activeResource: ExcelResource | null;
}

/** Resolves every registered Excel resource; a missing locator is not considered available. */
export async function resolveExcelResourceContext(
  session: Session,
  sourceResourceStore: ExcelSourceResourceStore,
): Promise<ExcelResourceContext> {
  const registeredResources = session
    .getResources()
    .filter((resource) => resource.kind === 'excel');
  const resources: ExcelResource[] = [];

  for (const registered of registeredResources) {
    const resource = await sourceResourceStore.get(session.getId(), registered.id);
    if (resource === null)
      throw new Error(
        `Excel source locator is registered but not available: ${registered.id}.`,
      );
    if (resource.id !== registered.id) {
      throw new Error(
        `Excel source locator id does not match the requested resource: ${resource.id} !== ${registered.id}.`,
      );
    }
    resources.push({ id: resource.id, filePath: resource.filePath });
  }

  const activeResourceId = session.getActiveResourceId();
  return {
    resources,
    activeResourceId,
    activeResource: resources.find((resource) => resource.id === activeResourceId) ?? null,
  };
}

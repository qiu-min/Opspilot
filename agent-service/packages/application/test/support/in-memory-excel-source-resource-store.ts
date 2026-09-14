import type { ExcelResource, ExcelSourceResourceStore } from '../../src/index.js';

/** Test-only source locator store that survives multiple ExecuteTurn calls. */
export class InMemoryExcelSourceResourceStore implements ExcelSourceResourceStore {
  private readonly resources = new Map<string, ExcelResource>();

  public async get(sessionId: string, resourceId: string): Promise<ExcelResource | null> {
    const resource = this.resources.get(`${sessionId}\u0000${resourceId}`);
    return resource === undefined ? null : { ...resource };
  }

  public async save(sessionId: string, resource: ExcelResource): Promise<void> {
    this.resources.set(`${sessionId}\u0000${resource.id}`, { ...resource });
  }
}

export class ApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export class IncidentNotFoundError extends ApplicationError {
  constructor(incidentId: string) {
    super(`Incident ${incidentId} was not found.`);
    this.name = 'IncidentNotFoundError';
  }
}

export class UnexpectedInitialStateError extends ApplicationError {
  constructor(entity: 'Incident' | 'AnalysisRun', received: string, expected: string) {
    super(`${entity} was created with status ${received}; expected ${expected}.`);
    this.name = 'UnexpectedInitialStateError';
  }
}

import type { TurnStore } from '../turn-store/turn-store.js';
import type { ResumeTurn, ResumeTurnResult } from './resume-turn.js';

export interface RecoverTurnsOnStartupDependencies {
  readonly turnStore: TurnStore;
  readonly resumeTurn: Pick<ResumeTurn, 'execute'>;
  readonly logger?: Pick<Console, 'error' | 'info'>;
}

export interface RecoverTurnsOnStartupSummary {
  readonly inspected: number;
  readonly resumed: number;
  readonly reconciled: number;
  readonly blocked: number;
  readonly failed: number;
}

/** Scans recoverable Turns serially; one blocked or failed Turn never stops startup. */
export class RecoverTurnsOnStartup {
  private readonly turnStore: TurnStore;
  private readonly resumeTurn: Pick<ResumeTurn, 'execute'>;
  private readonly logger: Pick<Console, 'error' | 'info'>;

  public constructor(options: RecoverTurnsOnStartupDependencies) {
    this.turnStore = options.turnStore;
    this.resumeTurn = options.resumeTurn;
    this.logger = options.logger ?? console;
  }

  public async execute(): Promise<RecoverTurnsOnStartupSummary> {
    const turns = this.turnStore.listRecoverable();
    const summary = { inspected: 0, resumed: 0, reconciled: 0, blocked: 0, failed: 0 };

    for (const turn of turns) {
      summary.inspected += 1;
      try {
        const result = await this.resumeTurn.execute(turn.getId());
        this.logResult(result);
        if (result.kind === 'resumed') summary.resumed += 1;
        else if (result.kind === 'reconciled') summary.reconciled += 1;
        else if (result.kind === 'blocked' || result.kind === 'unrecoverable') summary.blocked += 1;
      } catch (error: unknown) {
        summary.failed += 1;
        this.logger.error(
          `[recovery] turn=${turn.getId()} session=${turn.getSessionId()} ` +
            `result=failed errorType=${error instanceof Error ? error.name : 'unknown'}`,
        );
        // Do not log exception messages: adapters may include paths or other sensitive details.
      }
    }

    return summary;
  }

  private logResult(result: ResumeTurnResult): void {
    this.logger.info(
      `[recovery] turn=${result.turnId} session=${result.sessionId} attempt=${result.attempt} ` +
        `plan=${result.plan?.kind ?? 'none'} result=${result.kind}`,
    );
  }
}

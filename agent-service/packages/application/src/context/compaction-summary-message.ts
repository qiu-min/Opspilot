import type { UserMessage } from '@opspilot/model-gateway';

const COMPACTION_SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:';

/** Creates a standard user message that marks a persisted compaction summary. */
export function createCompactionSummaryMessage(summary: string): UserMessage {
  if (summary.trim().length === 0) throw new Error('Compaction summary must be non-empty.');

  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `${COMPACTION_SUMMARY_PREFIX}\n\n<summary>\n${summary}\n</summary>`,
      },
    ],
  };
}

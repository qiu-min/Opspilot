import { Ajv } from 'ajv';
import type {
  JsonObject,
  ModelToolCall,
  Tool,
} from './contracts/index.js';

const ajv = new Ajv();

export function validateToolArguments(
  tool: Tool,
  toolCall: ModelToolCall,
): JsonObject {
  const args = structuredClone(toolCall.arguments);

  const validate = ajv.compile(tool.parameters);

  const valid = validate(args);

  if (!valid) {
    throw new Error(
      `Validation failed for tool "${toolCall.name}": ${ajv.errorsText(validate.errors)}`,
    );
  }

  return args;
}
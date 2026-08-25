import type { JsonObject } from '../contracts/context.js';

/** 尝试把尚未接收完整的 JSON 参数解析成对象。
 * @param source 当前已经接收的 JSON 文本。
 * @returns 能解析出的对象；无法推断时返回空对象。
 */
export function parseStreamingJson(source: string): JsonObject {
  const parsed = parseObject(source);
  if (parsed) return parsed;

  let repaired = source.trim();
  if (repaired.length === 0) return {};

  let inString = false;
  let escaped = false;
  const closers: string[] = [];
  for (const character of repaired) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === '{') closers.push('}');
    if (character === '[') closers.push(']');
    if (character === '}' || character === ']') closers.pop();
  }

  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/u, '');
  repaired += closers.reverse().join('');
  return parseObject(repaired) ?? {};
}

/** 解析完整 JSON，并仅接受对象作为工具参数。
 * @param source 待解析的 JSON 文本。
 * @returns JSON 对象；文本不完整或结果不是对象时返回 undefined。
 */
function parseObject(source: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value === 'object' && value !== null && !Array.isArray(value))
      return value as JsonObject;
  } catch {
    // 流式 JSON 尚未完整时，交给外层修复后再尝试一次。
  }
  return undefined;
}

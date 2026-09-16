/** JSON primitives that can be stored in durable execution facts. */
export type JsonPrimitive = string | number | boolean | null;

/** A recursively JSON-serializable value. */
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Maximum UTF-8 size for one durable structured JSON value. */
export const MAX_DURABLE_JSON_VALUE_BYTES = 1_000_000;

/** Validates a value before it crosses a durable JSON boundary. */
export function assertJsonValue(value: unknown, field = 'value'): asserts value is JsonValue {
  const work: JsonValidationWorkItem[] = [{ kind: 'enter', value, path: field }];
  const active = new WeakSet<object>();

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.kind === 'exit') {
      active.delete(item.value);
      continue;
    }

    if (item.value === null) continue;
    if (typeof item.value === 'string' || typeof item.value === 'boolean') continue;
    if (typeof item.value === 'number') {
      if (Number.isFinite(item.value)) continue;
      throw new JsonValueError(`${item.path} must be JSON serializable.`);
    }
    if (typeof item.value !== 'object') {
      throw new JsonValueError(`${item.path} must be JSON serializable.`);
    }
    if (active.has(item.value)) {
      throw new JsonValueError(`${item.path} must not contain circular references.`);
    }

    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(item.value);
    } catch {
      throw new JsonValueError(`${item.path} must be JSON serializable.`);
    }

    if (Array.isArray(item.value)) {
      let keys: string[];
      try {
        if (Object.getOwnPropertySymbols(item.value).length > 0) {
          throw new JsonValueError(`${item.path} must be JSON serializable.`);
        }
        keys = Object.keys(item.value);
      } catch (error) {
        if (error instanceof JsonValueError) throw error;
        throw new JsonValueError(`${item.path} must be JSON serializable.`);
      }
      if (keys.length !== item.value.length) {
        throw new JsonValueError(`${item.path} must be JSON serializable.`);
      }

      active.add(item.value);
      work.push({ kind: 'exit', value: item.value });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        if (!isArrayIndexKey(key, item.value.length)) {
          throw new JsonValueError(`${item.path} must be JSON serializable.`);
        }
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(item.value, key);
        } catch {
          throw new JsonValueError(`${item.path}[${key}] must be JSON serializable.`);
        }
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new JsonValueError(`${item.path}[${key}] must be JSON serializable.`);
        }
        work.push({
          kind: 'enter',
          value: descriptor.value,
          path: `${item.path}[${key}]`,
        });
      }
      continue;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      throw new JsonValueError(`${item.path} must be JSON serializable.`);
    }

    let keys: string[];
    try {
      if (Object.getOwnPropertySymbols(item.value).length > 0) {
        throw new JsonValueError(`${item.path} must be JSON serializable.`);
      }
      keys = Object.keys(item.value);
    } catch (error) {
      if (error instanceof JsonValueError) throw error;
      throw new JsonValueError(`${item.path} must be JSON serializable.`);
    }

    active.add(item.value);
    work.push({ kind: 'exit', value: item.value });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(item.value, key);
      } catch {
        throw new JsonValueError(`${item.path} must be JSON serializable.`);
      }
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new JsonValueError(`${item.path}.${key} must be JSON serializable.`);
      }
      work.push({ kind: 'enter', value: descriptor.value, path: `${item.path}.${key}` });
    }
  }
}

/** Validates JSON shape and the bounded size required by durable event storage. */
export function assertDurableJsonValue(
  value: unknown,
  field = 'value',
): asserts value is JsonValue {
  assertJsonValue(value, field);

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new JsonValueError(`${field} must be JSON serializable.`);
  }

  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > MAX_DURABLE_JSON_VALUE_BYTES) {
    throw new JsonValueError(
      `${field} exceeds the ${MAX_DURABLE_JSON_VALUE_BYTES}-byte durable JSON value limit.`,
    );
  }
}

/** Returns whether a value satisfies the JSON-safe durable value contract. */
export function isJsonValue(value: unknown): value is JsonValue {
  try {
    assertJsonValue(value);
    return true;
  } catch {
    return false;
  }
}

interface JsonValidationEnter {
  readonly kind: 'enter';
  readonly value: unknown;
  readonly path: string;
}

interface JsonValidationExit {
  readonly kind: 'exit';
  readonly value: object;
}

type JsonValidationWorkItem = JsonValidationEnter | JsonValidationExit;

function isArrayIndexKey(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    index < 2 ** 32 - 1 &&
    String(index) === key
  );
}

class JsonValueError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'JsonValueError';
  }
}

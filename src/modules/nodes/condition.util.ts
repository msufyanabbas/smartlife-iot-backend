// src/modules/nodes/condition.util.ts
//
// Shared condition-evaluation logic used by the FILTER and SWITCH node
// processors. Extracted from FilterNodeProcessor so both processors evaluate
// `data[key] <operator> value` identically.

export type ConditionOperator =
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'GREATER_THAN'
  | 'LESS_THAN'
  | 'GREATER_THAN_OR_EQUAL'
  | 'LESS_THAN_OR_EQUAL'
  | 'CONTAINS'
  | 'NOT_CONTAINS'
  | 'EXISTS'
  | 'NOT_EXISTS'
  | 'IN'
  | 'NOT_IN';

/**
 * Resolve a dot-notation key (e.g. "location.city") against an object.
 */
export function getNestedValue(obj: Record<string, any>, key: string): any {
  if (!key) return undefined;
  return key.split('.').reduce((cur, part) => cur?.[part], obj);
}

/**
 * Evaluate a single condition: `data[key] <operator> value`.
 * Operator set is shared between FILTER and SWITCH nodes.
 */
export function evaluateCondition(
  data: Record<string, any>,
  key: string,
  operator: string,
  value?: any,
): boolean {
  const actual = getNestedValue(data ?? {}, key);
  const expected = value;

  switch (operator) {
    case 'EQUALS':
      return actual == expected; // intentional loose equality for string/number coercion

    case 'NOT_EQUALS':
      return actual != expected;

    case 'GREATER_THAN':
      return Number(actual) > Number(expected);

    case 'LESS_THAN':
      return Number(actual) < Number(expected);

    case 'GREATER_THAN_OR_EQUAL':
      return Number(actual) >= Number(expected);

    case 'LESS_THAN_OR_EQUAL':
      return Number(actual) <= Number(expected);

    case 'CONTAINS':
      if (Array.isArray(actual)) return actual.includes(expected);
      return String(actual ?? '').includes(String(expected));

    case 'NOT_CONTAINS':
      if (Array.isArray(actual)) return !actual.includes(expected);
      return !String(actual ?? '').includes(String(expected));

    case 'EXISTS':
      return actual !== undefined && actual !== null;

    case 'NOT_EXISTS':
      return actual === undefined || actual === null;

    case 'IN':
      if (!Array.isArray(expected)) return false;
      return expected.includes(actual);

    case 'NOT_IN':
      if (!Array.isArray(expected)) return true;
      return !expected.includes(actual);

    default:
      return false;
  }
}

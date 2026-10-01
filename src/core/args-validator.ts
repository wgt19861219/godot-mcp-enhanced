// src/core/args-validator.ts
/**
 * 手写 JSON schema 参数验证器(spec §2)。
 * 覆盖 inputSchema 实际用的关键字:type / required / enum / items(递归) / properties(嵌套)。
 * 不覆盖(YAGNI):pattern/format/minLength/maxItems。
 * P8-2 (2026-09-11, regiellis _reject_unknown_params 移植):顶层 unknown-param 拒绝 + [上游 godot-mcp-go license:MIT,2026-10-01 GitHub API 核实,见 THIRD_PARTY_NOTICES.md]
 * did-you-mean(similarity>=0.4)——handler 只读认识的 key,未声明参数静默成功 = 值进黑洞
 * (regiellis 动机:三个 eval worker 踩过 scene.validate --path 这类 typo 静默成功)。
 * 只查顶层(嵌套 properties 不查——game.params 等直通 dict 的内层自由是设计);
 * 嵌套 object 的 unknown 同样放过(params dict 语义)。
 */

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

function actualType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function checkType(value: unknown, expected: string | string[]): boolean {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((t) => TYPE_CHECKS[t]?.(value) ?? false);
}

/** Levenshtein 相似度 0-1(对齐 GD String.similarity 语义, did-you-mean 阈值 0.4 同源)。 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

/**
 * dispatcher 级公共参数键豁免集合(P8 审查 B-1 清偿,2026-09-12)。
 * ToolDispatcher 对**所有工具**读 args.godot_path 做 per-call Godot 二进制覆盖
 * (消费点在 validateArgs 之前)——schema 未声明 godot_path 的 ~19 个 headless 工具
 * (particles/tilemap/signal/physics 等)同样支持该覆盖。unknown-param 拒绝若不豁免,
 * 这些工具的 per-call 覆盖会被硬拒(did-you-mean 还可能误导)。
 * 与 scripts/check-ssot-params.mjs 的 godot_path 特判同源——两处须一起改。
 */
const DISPATCHER_COMMON_KEYS = new Set(['godot_path']);

/** P8-2: 顶层 unknown-param 检查(regiellis 移植)。返回错误消息数组(空=通过)。 */
export function checkUnknownParams(
  args: Record<string, unknown>,
  declared: Record<string, unknown>,
): string[] {
  const unknown: string[] = [];
  const hints: string[] = [];
  for (const key of Object.keys(args)) {
    if (key in declared || DISPATCHER_COMMON_KEYS.has(key)) continue;
    unknown.push(key);
    let best = '';
    let bestScore = 0;
    for (const d of Object.keys(declared)) {
      const score = similarity(key, d);
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    hints.push(bestScore >= 0.4
      ? `'${key}' 不是已声明参数——想传 '${best}'?(拼写相似度 ${bestScore.toFixed(2)})`
      : `'${key}' 不是已声明参数(声明的参数:${Object.keys(declared).join(', ')})`);
  }
  if (unknown.length === 0) return [];
  return [`未知参数: ${unknown.join(', ')}。${hints.join(';')}`];
}

interface SubSchema {
  type?: string | string[];
  enum?: unknown[];
  items?: SubSchema;
  properties?: Record<string, SubSchema>;
  required?: string[];
}

function validateValue(value: unknown, schema: SubSchema, path: string, errors: string[]): void {
  // type
  if (schema.type !== undefined && !checkType(value, schema.type)) {
    const exp = Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
    errors.push(`${path}: 期望 type ${exp},实际 ${actualType(value)}`);
    return; // 类型错,后续 enum/items/properties 跳过(避免噪音)
  }
  // enum
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: 值 ${JSON.stringify(value)} 不在 enum [${schema.enum.map((e) => String(e)).join(',')}]`);
  }
  // items 递归(array 元素)
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateValue(item, schema.items as SubSchema, `${path}[${i}]`, errors));
  }
  // properties 嵌套(object)
  if (checkType(value, 'object') && schema.properties) {
    validateObject(value as Record<string, unknown>, schema, path, errors);
  }
}

function validateObject(obj: Record<string, unknown>, schema: SubSchema, path: string, errors: string[]): void {
  // required
  if (schema.required) {
    for (const req of schema.required) {
      if (!(req in obj)) errors.push(`${path}.${req}: required 字段缺失`);
    }
  }
  // properties(只校验出现的字段;嵌套层 unknown 不查——params dict 直通语义)
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in obj && sub) {
        validateValue(obj[key], sub as SubSchema, `${path}.${key}`, errors);
      }
    }
  }
}

export function validateArgs(args: Record<string, unknown>, inputSchema: object): ValidationResult {
  const errors: string[] = [];
  const schema = inputSchema as SubSchema;
  // inputSchema 顶层是 object(MCP 惯例),校验 args 的 properties/required
  if (schema.properties || schema.required) {
    validateObject(args, schema, 'args', errors);
    // P8-2: 顶层 unknown-param 拒绝(schema 有 properties 才有意义;无 properties 的
    // schema 是自由 dict 工具,不查)
    if (schema.properties && Object.keys(schema.properties).length > 0) {
      errors.push(...checkUnknownParams(args, schema.properties));
    }
  }
  return { ok: errors.length === 0, errors };
}

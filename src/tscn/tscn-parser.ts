// src/tscn-parser.ts — Godot .tscn scene file parser
//
// I-10: Non-null assertions (!) on regex match groups (e.g. match[1]!) are used
// extensively. These are safe because each is guarded by an `if (match)` check
// that ensures the match succeeded. If the regex pattern has N capture groups,
// match[N] is guaranteed non-null when the overall match succeeds.
// For dynamic array indexing or untrusted input, prefer `is` checks instead.

export interface ExtResource {
  id: string | number;
  type: string;
  path: string;
  [key: string]: string | number;
}

export interface SubResource {
  id: string;
  type: string;
  [key: string]: string | number | boolean | unknown;
}

export interface NodeProperty {
  name: string;
  type: string;
  value: unknown;
}

export interface ParsedNode {
  name: string;
  type: string;
  parent: string;
  instance?: string | number; // ExtResource id
  instance_of?: string; // resolved path from ext_resources
  properties: NodeProperty[];
  children: ParsedNode[];
}

export interface Connection {
  signal: string;
  from: string;
  to: string;
  method: string;
  /** v0.30 C 批：连接可选属性（原样字符串）。flags 常见 4=DEFERRED/8=PERSIST；
   * binds=[...] 为绑定参数数组。此前头部正则只匹配引号值，这三个键被静默丢弃。 */
  flags?: string;
  binds?: string;
  unbinds?: string;
}

export interface ParsedScene {
  header: {
    format?: number;
    load_steps?: number;
    uid?: string;
    [key: string]: string | number | undefined;
  };
  extResources: ExtResource[];
  subResources: SubResource[];
  nodes: ParsedNode[];
  connections: Connection[];
  nodeMap: Map<string, ParsedNode>;
}

/**
 * Extract balanced parenthesis content from a typed constructor like "Type(...)".
 * Handles one level of nested parentheses.
 * Returns the inner content string, or null if the format doesn't match.
 */
function extractBalancedParenContent(input: string, typeName: string): string | null {
  const prefix = typeName + '(';
  if (!input.startsWith(prefix) || !input.endsWith(')')) return null;
  // Start from the opening '(' at end of prefix; depth=1 on first iteration
  let depth = 0;
  for (let i = prefix.length - 1; i < input.length; i++) {
    if (input[i] === '(') depth++;
    else if (input[i] === ')') depth--;
    if (depth === 0 && i === input.length - 1) {
      return input.slice(prefix.length, i);
    }
  }
  return null;
}

/**
 * Parse a raw value string into a JS value.
 *
 * IMPORTANT: splitTopLevel() only splits on commas at the top level; it does NOT
 * unescape "" sequences — they pass through unchanged in the split result.
 * All unescaping of Godot's "" → " string escaping happens HERE, exactly once.
 */
function parseValue(raw: string, maxDepth: number, budget: ParseBudget): unknown {
  if (!checkParseBudget(budget)) return raw; // C-PERF-03: budget exhausted, return raw
  const trimmed = raw.trim();

  // String — Godot uses "" (two double-quotes) to escape a literal " inside strings.
  // splitTopLevel preserves "" verbatim, so we unescape exactly once here.
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }

  // Bool
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Null
  if (trimmed === 'null' || trimmed === 'None') return null;

  // ExtResource("N") — supports both numeric and string UIDs (Godot 4.x)
  const extMatch = trimmed.match(/^ExtResource\("([^"]+)"\)$/);
  if (extMatch) {
    const rawId = extMatch[1];
    const numericId = Number(rawId);
    return { __type: 'ExtResource', id: !isNaN(numericId) && rawId !== '' ? numericId : rawId };
  }

  // SubResource("N")
  const subMatch = trimmed.match(/^SubResource\("([^"]+)"\)$/);
  if (subMatch) return { __type: 'SubResource', id: subMatch[1] };

  // Array (with depth guard)
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    if (maxDepth <= 0) return trimmed;
    return parseArrayContent(trimmed.slice(1, -1), maxDepth - 1, budget);
  }

  // Dictionary (with depth guard)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    if (maxDepth <= 0) return trimmed;
    return parseDictContent(trimmed.slice(1, -1), maxDepth - 1, budget);
  }

  // NodePath("...")
  const npMatch = trimmed.match(/^NodePath\("(.*)"\)$/);
  if (npMatch) return { __type: 'NodePath', value: npMatch[1] };

  // Color(r, g, b, a) — handle nested parentheses
  const colorMatch = trimmed.match(/^Color\(/);
  if (colorMatch) {
    const inner = extractBalancedParenContent(trimmed, 'Color');
    if (inner !== null) return { __type: 'Color', value: inner };
    // C-PAR-01: Malformed constructor (unbalanced parens) — return raw string, don't fall through
    return trimmed;
  }

  // Vector2(x, y) — handle nested parentheses
  const v2Match = trimmed.match(/^Vector2\(/);
  if (v2Match) {
    const inner = extractBalancedParenContent(trimmed, 'Vector2');
    if (inner !== null) return { __type: 'Vector2', value: inner };
    return trimmed;
  }

  // Vector3(x, y, z) — handle nested parentheses
  const v3Match = trimmed.match(/^Vector3\(/);
  if (v3Match) {
    const inner = extractBalancedParenContent(trimmed, 'Vector3');
    if (inner !== null) return { __type: 'Vector3', value: inner };
    return trimmed;
  }

  // Vector2i(x, y) — 整数版本(网格/TileMap 坐标)。正则 ^Vector2i\( 不会误匹配 Vector2( 因 i ≠ (
  const v2iMatch = trimmed.match(/^Vector2i\(/);
  if (v2iMatch) {
    const inner = extractBalancedParenContent(trimmed, 'Vector2i');
    if (inner !== null) return { __type: 'Vector2i', value: inner };
    return trimmed;
  }

  // Vector3i(x, y, z) — 整数版本(3D 网格坐标)
  const v3iMatch = trimmed.match(/^Vector3i\(/);
  if (v3iMatch) {
    const inner = extractBalancedParenContent(trimmed, 'Vector3i');
    if (inner !== null) return { __type: 'Vector3i', value: inner };
    return trimmed;
  }

  // Transform3D(basis 9 分量, ox, oy, oz) — Node3D transform
  // 真实样本 test/e2e-scene/scenes/test_3d.tscn:24: Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 5)
  const tf3dMatch = trimmed.match(/^Transform3D\(/);
  if (tf3dMatch) {
    const inner = extractBalancedParenContent(trimmed, 'Transform3D');
    if (inner !== null) return { __type: 'Transform3D', value: inner };
    return trimmed;
  }

  // PackedInt32Array(1, 2, 3) — TileMap tile_data 等紧凑整型数组
  // 空数组 PackedInt32Array() → inner='' (非 null) → {__type, value:''},符合"value 是原始 inner"约定
  const piaMatch = trimmed.match(/^PackedInt32Array\(/);
  if (piaMatch) {
    const inner = extractBalancedParenContent(trimmed, 'PackedInt32Array');
    if (inner !== null) return { __type: 'PackedInt32Array', value: inner };
    return trimmed;
  }

  // Number (int or float) — Number.isFinite rejects NaN, Infinity, and
  // Number("") == 0 is excluded by the trimmed !== '' guard above.
  if (trimmed !== '') {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }

  // Fallback: raw string
  return trimmed;
}

/**
 * Split a string by commas at the top level (respecting nesting and strings).
 * Limits output to MAX_ELEMENTS to prevent O(n^2) ReDoS.
 */
const MAX_SPLIT_ELEMENTS = 10000;
const MAX_TSCN_INPUT_SIZE = 10 * 1024 * 1024; // 10MB
// C-PERF-03: Operation budget prevents pathological recursion.
// H-10: Budget is now a parameter object instead of module-level mutable state,
// preventing corruption if two parseTscn() calls interleave at await points.
const MAX_PARSE_OPERATIONS = 1_000_000;
interface ParseBudget { opsRemaining: number }
function checkParseBudget(budget: ParseBudget): boolean {
  return --budget.opsRemaining >= 0;
}
function createBudget(): ParseBudget {
  return { opsRemaining: MAX_PARSE_OPERATIONS };
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  // C-PERF-02: Use char array instead of string concatenation to avoid O(n²).
  // Each += on a string copies the entire buffer; for large .tscn property
  // values (e.g. 1MB PackedStringArray) this means millions of copies.
  const currentChars: string[] = [];
  let inString = false;

  for (let i = 0; i < input.length; i++) {
    if (parts.length >= MAX_SPLIT_ELEMENTS) break;
    const ch = input[i]!;
    if (inString) {
      currentChars.push(ch);
      if (ch === '"') {
        if (i + 1 < input.length && input[i + 1] === '"') {
          currentChars.push('"');
          i++;
        } else {
          inString = false;
        }
      }
    } else {
      if (ch === '"') {
        inString = true;
        currentChars.push(ch);
      } else if (ch === '[' || ch === '{' || ch === '(') {
        depth++;
        currentChars.push(ch);
      } else if (ch === ']' || ch === '}' || ch === ')') {
        depth--;
        currentChars.push(ch);
      } else if (ch === ',' && depth === 0) {
        parts.push(currentChars.join('').trim());
        currentChars.length = 0;
      } else {
        currentChars.push(ch);
      }
    }
  }
  if (currentChars.length > 0 && parts.length < MAX_SPLIT_ELEMENTS) {
    const tail = currentChars.join('').trim();
    if (tail) parts.push(tail);
  }
  return parts;
}

function parseArrayContent(inner: string, maxDepth: number, budget: ParseBudget): unknown[] {
  const trimmed = inner.trim();
  if (!trimmed) return [];
  const elements = splitTopLevel(trimmed);
  return elements.map(el => parseValue(el, maxDepth, budget));
}

function parseDictContent(inner: string, maxDepth: number, budget: ParseBudget): Record<string, unknown> {
  const trimmed = inner.trim();
  if (!trimmed) return {};
  const result: Record<string, unknown> = {};
  const entries = splitTopLevel(trimmed);
  for (const entry of entries) {
    // GDScript dict syntax: "key": value (Godot 4.x standard) OR key = value (compat)
    // Check colon first — it's the standard separator and avoids confusion with =
    // inside values (e.g. Resource("id") where the value contains an = sign).
    const colonIdx = entry.indexOf(':');
    const eqIdx = entry.indexOf('=');
    let key: string;
    let valRaw: string;
    if (colonIdx !== -1) {
      key = entry.slice(0, colonIdx).trim();
      valRaw = entry.slice(colonIdx + 1).trim();
    } else if (eqIdx !== -1) {
      key = entry.slice(0, eqIdx).trim();
      valRaw = entry.slice(eqIdx + 1).trim();
    } else {
      continue;
    }
    if (key.startsWith('"') && key.endsWith('"')) {
      key = key.slice(1, -1).replace(/""/g, '"');
    }
    result[key] = parseValue(valRaw, maxDepth, budget);
  }
  return result;
}

function parseTypedValue(raw: string, budget: ParseBudget): NodeProperty {
  // CRITICAL-1 fix: Godot 4.x node multi-line properties use `key = value`
  // (equals sign, no colon). The parser entry guard at parseTscn:452
  // (`trimmed.includes('=')`) guarantees every line reaching here contains `=`.
  // Prefer `=` as the key/value separator; fall back to `:` only for the rare
  // legacy `key: Type value` form (which no Godot 4.x file emits).
  const eqIdx = raw.indexOf('=');
  if (eqIdx !== -1) {
    // `name` may contain `/` (e.g. theme_override_styles/panel) — preserve verbatim.
    const name = raw.slice(0, eqIdx).trim();
    const rest = raw.slice(eqIdx + 1).trim();
    // Godot 4.x values are bare (Vector2(1,2), ExtResource("1"), 3, "text").
    // Do NOT try to split "Type value" — it misreads `Vector2(100, 200)` as
    // type=Vector2 + value=(100, 200). parseValue() resolves the real type.
    return { name, type: 'unknown', value: parseValue(rest, 20, budget) };
  }

  // Legacy `key: Type value` form (Godot 3.x / hand-written). Defensive only.
  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) {
    return { name: raw.trim(), type: 'unknown', value: raw.trim() };
  }
  const name = raw.slice(0, colonIdx).trim();
  const rest = raw.slice(colonIdx + 1).trim();
  const typeMatch = rest.match(/^(\w+)\s+(.+)$/s);
  if (typeMatch) {
    return { name, type: typeMatch[1]!, value: parseValue(typeMatch[2]!, 20, budget) };
  }
  return { name, type: 'unknown', value: parseValue(rest, 20, budget) };
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

export function parseTscn(content: string): ParsedScene {
  const budget = createBudget(); // H-10: per-call budget, not module-level state
  if (content.length > MAX_TSCN_INPUT_SIZE) {
    throw new Error(`tscn input too large: ${content.length} bytes exceeds ${MAX_TSCN_INPUT_SIZE} byte limit`);
  }
  const lines = splitLines(content);
  const result: ParsedScene = {
    header: {},
    extResources: [],
    subResources: [],
    nodes: [],
    connections: [],
    nodeMap: new Map(),
  };

  let currentSection: 'header' | 'ext_resource' | 'sub_resource' | 'node' | 'connection' | 'unknown' = 'header';
  let sawGdSceneHeader = false; // C1: track whether a [gd_scene] header section was matched
  let currentExt: Partial<ExtResource> | null = null;
  let currentSub: Partial<SubResource> & { id?: string } | null = null;
  let currentNode: Partial<ParsedNode> & { properties: NodeProperty[] } | null = null;
  let currentConnection: Partial<Connection> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty and comments
    if (!trimmed || trimmed.startsWith(';')) continue;

    // Section headers
    // CRITICAL-2 fix: header is `[gd_scene ...]` (with bracket) — matches the
    // form used by every other section below. Was `startsWith('gd_scene')`
    // which never matched, leaving header permanently `{}`.
    if (trimmed.startsWith('[gd_scene')) {
      currentSection = 'header';
      sawGdSceneHeader = true;
      const headerMatch = trimmed.match(/\[gd_scene\s+([^\]]*)\]/);
      const attrs = headerMatch ? headerMatch[1]! : '';
      const pairs = attrs.match(/(\w+)=(?:"([^"]*)"|((?:(?!\s+\w+=).)+))/g);
      if (pairs) {
        for (const pair of pairs) {
          const eqIdx = pair.indexOf('=');
          const key = pair.slice(0, eqIdx);
          const val = pair.slice(eqIdx + 1).replace(/^"|"$/g, '').replace(/""/g, '"');
          const num = Number(val);
          result.header[key] = isNaN(num) || val === '' ? val : num;
        }
      }
      continue;
    }

    if (trimmed.startsWith('[ext_resource')) {
      // Flush previous ext_resource
      if (currentExt && currentExt.id !== undefined) {
        result.extResources.push(currentExt as ExtResource);
      }
      currentExt = {};
      currentSection = 'ext_resource';

      // Parse inline attributes
      const attrMatch = trimmed.match(/\[(\w+)\s+(.*)\]/);
      if (attrMatch) {
        const attrs = attrMatch[2]!;
        // I-02: 非引号分支改为匹配到下一个 key= 或行尾，支持含空格的值（如 PackedStringArray(...)）
        const pairs = attrs.match(/(\w+)=(?:"([^"]*)"|((?:(?!\s+\w+=).)+))/g);
        if (pairs) {
          for (const pair of pairs) {
            const eq = pair.indexOf('=');
            const key = pair.slice(0, eq);
            const val = pair.slice(eq + 1).replace(/^"|"$/g, '').replace(/""/g, '"');
            if (key === 'id') {
              const numericId = Number(val);
              currentExt!.id = !isNaN(numericId) && val !== '' ? numericId : val;
            }
            else if (key === 'type') currentExt!.type = val;
            else if (key === 'path') currentExt!.path = val;
            else currentExt![key] = val;
          }
        }
      }
      continue;
    }

    if (trimmed.startsWith('[sub_resource')) {
      if (currentSub && currentSub.id !== undefined) {
        result.subResources.push(currentSub as SubResource);
      }
      currentSub = {};
      currentSection = 'sub_resource';

      const attrMatch = trimmed.match(/\[(\w+)\s+(.*)\]/);
      if (attrMatch) {
        const attrs = attrMatch[2]!;
        // I-02: 非引号分支匹配到下一个 key= 或行尾，支持含空格的值
        const pairs = attrs.match(/(\w+)=(?:"([^"]*)"|((?:(?!\s+\w+=).)+))/g);
        if (pairs) {
          for (const pair of pairs) {
            const eq = pair.indexOf('=');
            const key = pair.slice(0, eq);
            const val = pair.slice(eq + 1).replace(/^"|"$/g, '').replace(/""/g, '"');
            if (key === 'id') currentSub!.id = val;
            else if (key === 'type') currentSub!.type = val;
            else currentSub![key] = val;
          }
        }
      }
      continue;
    }

    if (trimmed.startsWith('[node')) {
      if (currentNode && currentNode.name) {
        result.nodes.push(currentNode as ParsedNode);
      }
      currentNode = { name: '', type: 'Node', parent: '', properties: [] };
      currentSection = 'node';

      const attrMatch = trimmed.match(/\[(\w+)\s+(.*)\]/);
      if (attrMatch) {
        const attrs = attrMatch[2]!;
        // I-02: 非引号分支匹配到下一个 key= 或行尾，支持含空格的值
        const pairs = attrs.match(/(\w+)=(?:"([^"]*)"|((?:(?!\s+\w+=).)+))/g);
        if (pairs) {
          for (const pair of pairs) {
            const eq = pair.indexOf('=');
            const key = pair.slice(0, eq);
            const val = pair.slice(eq + 1).replace(/^"|"$/g, '').replace(/""/g, '"');
            if (key === 'name') currentNode!.name = val;
            else if (key === 'type') currentNode!.type = val;
            else if (key === 'parent') currentNode!.parent = val;
            else if (key === 'instance') {
              const erMatch = val.match(/ExtResource\(["']?([^"']+)["']?\)/);
              if (erMatch) {
                const rawId = erMatch[1]!;
                const numericId = Number(rawId);
                currentNode!.instance = !isNaN(numericId) && rawId !== '' ? numericId : rawId;
              }
            }
          }
        }
      }
      continue;
    }

    if (trimmed.startsWith('[connection')) {
      if (currentConnection && currentConnection.signal) {
        result.connections.push(currentConnection as Connection);
      }
      currentConnection = {};
      currentSection = 'connection';

      const attrMatch = trimmed.match(/\[(\w+)\s+(.*)\]/);
      if (attrMatch) {
        const attrs = attrMatch[2]!;
        const pairs = attrs.match(/(\w+)="([^"]*)"/g);
        if (pairs) {
          for (const pair of pairs) {
            const eq = pair.indexOf('=');
            const key = pair.slice(0, eq);
            const val = pair.slice(eq + 1).replace(/^"|"$/g, '').replace(/""/g, '"');
            if (key === 'signal') currentConnection!.signal = val;
            else if (key === 'from') currentConnection!.from = val;
            else if (key === 'to') currentConnection!.to = val;
            else if (key === 'method') currentConnection!.method = val;
          }
        }
        // v0.30 C 批：非引号值键（flags=4 / binds=[...] / unbinds=2）——原正则只匹配
        // 引号值致其静默丢弃。binds 数组值以 ] 结束（数组内可含空格/逗号）。
        const barePairs = attrs.match(/\b(flags|binds|unbinds)=(\[[^\]]*\]|[^\s"\]]+)/g);
        if (barePairs) {
          for (const pair of barePairs) {
            const eq = pair.indexOf('=');
            const key = pair.slice(0, eq);
            const val = pair.slice(eq + 1);
            if (key === 'flags') currentConnection!.flags = val;
            else if (key === 'binds') currentConnection!.binds = val;
            else if (key === 'unbinds') currentConnection!.unbinds = val;
          }
        }
      }
      continue;
    }

    // Properties / attributes within sections
    if (trimmed.includes('=') && !trimmed.startsWith('[')) {
      const prop = parseTypedValue(trimmed, budget);

      switch (currentSection) {
        case 'ext_resource':
          if (currentExt) currentExt[prop.name] = prop.value as string | number;
          break;
        case 'sub_resource':
          if (currentSub) currentSub[prop.name] = prop.value;
          break;
        case 'node':
          if (currentNode) {
            if (prop.name === 'name') currentNode.name = String(prop.value);
            else if (prop.name === 'type') currentNode.type = String(prop.value);
            else if (prop.name === 'parent') currentNode.parent = String(prop.value);
            else currentNode.properties.push(prop);
          }
          break;
        case 'connection':
          if (currentConnection) {
            if (prop.name === 'signal') currentConnection.signal = String(prop.value);
            else if (prop.name === 'from') currentConnection.from = String(prop.value);
            else if (prop.name === 'to') currentConnection.to = String(prop.value);
            else if (prop.name === 'method') currentConnection.method = String(prop.value);
            else if (prop.name === 'flags') currentConnection.flags = String(prop.value);
            else if (prop.name === 'binds') currentConnection.binds = String(prop.value);
            else if (prop.name === 'unbinds') currentConnection.unbinds = String(prop.value);
          }
          break;
      }
    }
  }

  // Flush last items
  if (currentExt && currentExt.id !== undefined) {
    result.extResources.push(currentExt as ExtResource);
  }
  if (currentSub && currentSub.id !== undefined) {
    result.subResources.push(currentSub as SubResource);
  }
  if (currentNode && currentNode.name) {
    result.nodes.push(currentNode as ParsedNode);
  }
  if (currentConnection && currentConnection.signal) {
    result.connections.push(currentConnection as Connection);
  }

  // Build node tree using unique paths as keys (avoids collisions when nodes share the same name)
  const nodeMap = new Map<string, ParsedNode>();

  // Resolve instance_of paths from ext_resources
  const extMap = new Map<string | number, string>();
  for (const ext of result.extResources) {
    if (ext.path) extMap.set(ext.id, ext.path as string);
  }
  for (const node of result.nodes) {
    if (node.instance != null) {
      const path = extMap.get(node.instance);
      if (path) node.instance_of = path;
    }
  }

  let rootNode: ParsedNode | undefined;
  for (const node of result.nodes) {
    node.children = [];
    if (!node.parent) {
      // C-01: Guard against malformed .tscn with multiple root nodes
      // Godot enforces single root — if we see a second, skip it (preserve first)
      if (!rootNode) {
        rootNode = node;
      }
      nodeMap.set(node.name, node);
    } else if (node.parent === '.') {
      const uniquePath = rootNode ? `${rootNode.name}/${node.name}` : node.name;
      nodeMap.set(uniquePath, node);
    } else {
      // parent like "Child" or "Child/GrandChild" — relative to root
      const uniquePath = rootNode ? `${rootNode.name}/${node.parent}/${node.name}` : `${node.parent}/${node.name}`;
      nodeMap.set(uniquePath, node);
    }
  }

  for (const node of result.nodes) {
    if (node.parent) {
      let parent: ParsedNode | undefined;
      if (node.parent === '.') {
        parent = rootNode;
      } else {
        // parent path is relative to root — prepend root name for nodeMap lookup
        const fullParentPath = rootNode ? `${rootNode.name}/${node.parent}` : node.parent;
        parent = nodeMap.get(fullParentPath);
      }
      if (parent) {
        parent.children.push(node);
      }
    }
  }

  // Root nodes (no parent) are the top-level
  result.nodeMap = nodeMap;

  // C1: malformed input with no [gd_scene] header would otherwise silently yield an empty parse.
  if (content.trim() && !sawGdSceneHeader) {
    console.warn('[tscn-parser] input has no [gd_scene] header — malformed .tscn? Returning empty parse.');
  }

  return result;
}

export function parseTscnSummary(content: string): string {
  const parsed = parseTscn(content);
  const lines: string[] = [];

  lines.push('=== Scene Summary ===');

  // Header
  if (Object.keys(parsed.header).length > 0) {
    lines.push(`Format: ${parsed.header.format ?? 'unknown'}, Steps: ${parsed.header.load_steps ?? 'unknown'}`);
    if (parsed.header.uid) lines.push(`UID: ${parsed.header.uid}`);
  }

  // Resources
  lines.push(`\nExternal Resources: ${parsed.extResources.length}`);
  for (const r of parsed.extResources) {
    lines.push(`  [${r.id}] ${r.type}: ${r.path}`);
  }

  lines.push(`Sub Resources: ${parsed.subResources.length}`);
  for (const r of parsed.subResources) {
    lines.push(`  [${r.id}] ${r.type}`);
  }

  // Nodes
  const roots = parsed.nodes.filter(n => !n.parent);
  // L-25(2026-10-22 审查):printNode 递归加环防护——恶意 parent 环可致无限递归
  // 栈溢出。实测当前 nodeMap 键构造(键含完整 parent 路径)下互指环挂不进 children,
  // 环实际不可达;此防护为纵深防御(键逻辑演进/children 外部构造时兜底)。
  // visited 按对象引用 + 深度上限 64 双保险,触顶时打提示行不静默截断。
  const printed = new Set<ParsedNode>();
  function printNode(node: ParsedNode, indent: number): void {
    if (printed.has(node)) return;
    printed.add(node);
    if (indent > 64) {
      lines.push(`${'  '.repeat(indent)}… (depth limit 64 reached — cycle suspected)`);
      return;
    }
    const pad = '  '.repeat(indent);
    const inst = node.instance ? ` (instance: ExtResource(${node.instance}))` : '';
    lines.push(`${pad}${node.name} [${node.type}]${inst}`);
    for (const child of node.children) {
      printNode(child, indent + 1);
    }
  }
  lines.push(`\nNodes (${parsed.nodes.length} total):`);
  for (const root of roots) {
    printNode(root, 1);
  }

  // Connections
  if (parsed.connections.length > 0) {
    lines.push(`\nConnections: ${parsed.connections.length}`);
    for (const c of parsed.connections) {
      lines.push(`  ${c.from}.${c.signal} -> ${c.to}.${c.method}`);
    }
  }

  return lines.join('\n');
}

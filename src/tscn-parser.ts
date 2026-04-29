// src/tscn-parser.ts — Godot .tscn scene file parser

export interface ExtResource {
  id: number;
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
  instance?: number; // ExtResource id
  properties: NodeProperty[];
  children: ParsedNode[];
}

export interface Connection {
  signal: string;
  from: string;
  to: string;
  method: string;
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

function parseValue(raw: string, maxDepth: number = 50): unknown {
  const trimmed = raw.trim();

  // String
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }

  // Bool
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Null
  if (trimmed === 'null' || trimmed === 'None') return null;

  // ExtResource(N)
  const extMatch = trimmed.match(/^ExtResource\("(\d+)"\)$/);
  if (extMatch) return { __type: 'ExtResource', id: parseInt(extMatch[1]) };

  // SubResource("N")
  const subMatch = trimmed.match(/^SubResource\("([^"]+)"\)$/);
  if (subMatch) return { __type: 'SubResource', id: subMatch[1] };

  // Array (with depth guard)
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    if (maxDepth <= 0) return trimmed;
    return parseArrayContent(trimmed.slice(1, -1), maxDepth - 1);
  }

  // Dictionary (with depth guard)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    if (maxDepth <= 0) return trimmed;
    return parseDictContent(trimmed.slice(1, -1), maxDepth - 1);
  }

  // NodePath("...")
  const npMatch = trimmed.match(/^NodePath\("(.*)"\)$/);
  if (npMatch) return { __type: 'NodePath', value: npMatch[1] };

  // Color(r, g, b, a)
  const colorMatch = trimmed.match(/^Color\(([^)]+)\)$/);
  if (colorMatch) return { __type: 'Color', value: colorMatch[1] };

  // Vector2(x, y)
  const v2Match = trimmed.match(/^Vector2\(([^)]+)\)$/);
  if (v2Match) return { __type: 'Vector2', value: v2Match[1] };

  // Vector3(x, y, z)
  const v3Match = trimmed.match(/^Vector3\(([^)]+)\)$/);
  if (v3Match) return { __type: 'Vector3', value: v3Match[1] };

  // Number (int or float)
  const num = Number(trimmed);
  if (!isNaN(num)) return num;

  // Fallback: raw string
  return trimmed;
}

/**
 * Split a string by commas at the top level (respecting nesting and strings).
 */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inString = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      current += ch;
      if (ch === '"') {
        if (i + 1 < input.length && input[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inString = false;
        }
      }
    } else {
      if (ch === '"') {
        inString = true;
        current += ch;
      } else if (ch === '[' || ch === '{' || ch === '(') {
        depth++;
        current += ch;
      } else if (ch === ']' || ch === '}' || ch === ')') {
        depth--;
        current += ch;
      } else if (ch === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseArrayContent(inner: string, maxDepth: number): unknown[] {
  const trimmed = inner.trim();
  if (!trimmed) return [];
  const elements = splitTopLevel(trimmed);
  return elements.map(el => parseValue(el, maxDepth));
}

function parseDictContent(inner: string, maxDepth: number): Record<string, unknown> {
  const trimmed = inner.trim();
  if (!trimmed) return {};
  const result: Record<string, unknown> = {};
  const entries = splitTopLevel(trimmed);
  for (const entry of entries) {
    // GDScript dict syntax: key = value  OR  "key": value
    const eqIdx = entry.indexOf('=');
    const colonIdx = entry.indexOf(':');
    let key: string;
    let valRaw: string;
    if (eqIdx !== -1) {
      key = entry.slice(0, eqIdx).trim();
      valRaw = entry.slice(eqIdx + 1).trim();
    } else if (colonIdx !== -1) {
      key = entry.slice(0, colonIdx).trim();
      valRaw = entry.slice(colonIdx + 1).trim();
    } else {
      continue;
    }
    if (key.startsWith('"') && key.endsWith('"')) {
      key = key.slice(1, -1).replace(/""/g, '"');
    }
    result[key] = parseValue(valRaw, maxDepth);
  }
  return result;
}

function parseTypedValue(raw: string): NodeProperty {
  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) {
    return { name: raw.trim(), type: 'unknown', value: raw.trim() };
  }
  const name = raw.slice(0, colonIdx).trim();
  const rest = raw.slice(colonIdx + 1).trim();

  // Type is before the value if there's a space after a type name
  const typeMatch = rest.match(/^(\w+)\s+(.+)$/s);
  if (typeMatch) {
    return { name, type: typeMatch[1], value: parseValue(typeMatch[2]) };
  }

  return { name, type: 'unknown', value: parseValue(rest) };
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

export function parseTscn(content: string): ParsedScene {
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
  let currentExt: Partial<ExtResource> | null = null;
  let currentSub: Partial<SubResource> & { id?: string } | null = null;
  let currentNode: Partial<ParsedNode> & { properties: NodeProperty[] } | null = null;
  let currentConnection: Partial<Connection> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty and comments
    if (!trimmed || trimmed.startsWith(';')) continue;

    // Section headers
    if (trimmed.startsWith('gd_scene')) {
      currentSection = 'header';
      const parts = trimmed.split(/\s+/);
      for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx !== -1) {
          const key = part.slice(0, eqIdx);
          const val = part.slice(eqIdx + 1);
          const num = Number(val);
          result.header[key] = isNaN(num) ? val : num;
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
        const attrs = attrMatch[2];
        const pairs = attrs.match(/(\w+)=(?:"([^"]*)"|(\S+))/g);
        if (pairs) {
          for (const pair of pairs) {
            const eq = pair.indexOf('=');
            const key = pair.slice(0, eq);
            const val = pair.slice(eq + 1);
            if (key === 'id') currentExt!.id = parseInt(val);
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
        const attrs = attrMatch[2];
        const pairs = attrs.match(/(\w+)=(?:"([^"]*)"|(\S+))/g);
        if (pairs) {
          for (const pair of pairs) {
            const eq = pair.indexOf('=');
            const key = pair.slice(0, eq);
            const val = pair.slice(eq + 1);
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
        const attrs = attrMatch[2];
        const pairs = attrs.match(/(\w+)=(?:"([^"]*)"|(\S+))/g);
        if (pairs) {
          for (const pair of pairs) {
            const eq = pair.indexOf('=');
            const key = pair.slice(0, eq);
            const val = pair.slice(eq + 1).replace(/^"|"$/g, '');
            if (key === 'name') currentNode!.name = val;
            else if (key === 'type') currentNode!.type = val;
            else if (key === 'parent') currentNode!.parent = val;
            else if (key === 'instance') currentNode!.instance = parseInt(val);
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
        const attrs = attrMatch[2];
        const pairs = attrs.match(/(\w+)="([^"]*)"/g);
        if (pairs) {
          for (const pair of pairs) {
            const eq = pair.indexOf('=');
            const key = pair.slice(0, eq);
            const val = pair.slice(eq + 1).replace(/^"|"$/g, '');
            if (key === 'signal') currentConnection!.signal = val;
            else if (key === 'from') currentConnection!.from = val;
            else if (key === 'to') currentConnection!.to = val;
            else if (key === 'method') currentConnection!.method = val;
          }
        }
      }
      continue;
    }

    // Properties / attributes within sections
    if (trimmed.includes('=') && !trimmed.startsWith('[')) {
      const prop = parseTypedValue(trimmed);

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

  // Build node tree
  const nodeMap = new Map<string, ParsedNode>();
  for (const node of result.nodes) {
    node.children = [];
    nodeMap.set(node.name, node);
  }

  for (const node of result.nodes) {
    if (node.parent) {
      const parent = nodeMap.get(node.parent);
      if (parent) {
        parent.children.push(node);
      }
    }
  }

  // Root nodes (no parent) are the top-level
  result.nodeMap = nodeMap;

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
  function printNode(node: ParsedNode, indent: number): void {
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

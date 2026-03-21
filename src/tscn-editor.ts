// src/tscn-editor.ts — Line-based .tscn scene file editor

export interface SceneEditResult {
  success: boolean;
  message: string;
  scene?: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function normalizeLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** Find the line index of a section header matching the predicate. */
function findSectionLine(lines: string[], predicate: (line: string) => boolean): number {
  for (let i = 0; i < lines.length; i++) {
    if (predicate(lines[i])) return i;
  }
  return -1;
}

/** Find the end of a section (next `[...]` line or end of file). Returns index of the next section start. */
function findSectionEnd(lines: string[], startLine: number): number {
  for (let i = startLine + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[')) return i;
  }
  return lines.length;
}

/** Parse a quoted attribute from a bracket header like `[node name="X" type="Y"]` */
function getBracketAttr(header: string, attr: string): string | null {
  const re = new RegExp(`(?:^|\\s)${attr}="([^"]*)"`);
  const m = header.match(re);
  return m ? m[1] : null;
}

/** Get the name part of a nodePath like "Root/Player/Sprite2D" → "Sprite2D" */
function leafName(nodePath: string): string {
  const parts = nodePath.split('/');
  return parts[parts.length - 1];
}

/** Build a parent path prefix from a nodePath. "Root/Player/Sprite2D" → "Root/Player" */
function parentPath(nodePath: string): string {
  const parts = nodePath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

/**
 * For a nodePath like "Root/Player/Sprite2D", we need to find the node whose
 * name is "Sprite2D" AND whose parent attribute matches the path prefix.
 * In .tscn, the parent is stored as NodePath("Root/Player").
 */
function findNodeSectionLine(lines: string[], nodePath: string): number {
  const targetName = leafName(nodePath);
  const targetParent = parentPath(nodePath);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('[node')) continue;

    const name = getBracketAttr(trimmed, 'name');
    if (name !== targetName) continue;

    // If targetParent is empty, this is a root node (no parent attr)
    if (!targetParent) {
      const p = getBracketAttr(trimmed, 'parent');
      if (p === null || p === '') return i;
      continue;
    }

    // Match parent — could be inline or on a property line
    let inlineParent = getBracketAttr(trimmed, 'parent');
    if (inlineParent === targetParent) return i;

    // Check property lines below the header
    const end = findSectionEnd(lines, i);
    for (let j = i + 1; j < end; j++) {
      const propLine = lines[j].trim();
      if (propLine.startsWith('parent = ') || propLine.startsWith('parent=')) {
        const val = propLine.replace(/^parent\s*=\s*/, '').replace(/"/g, '').trim();
        if (val === targetParent) return i;
      }
    }
  }
  return -1;
}

/** Return the last line of the node section (inclusive). */
function nodeSectionEnd(lines: string[], nodeLine: number): number {
  return findSectionEnd(lines, nodeLine) - 1;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Edit a node property in a .tscn scene.
 * If the property already exists its value is replaced; otherwise a new line is appended
 * inside the node section.
 */
export function editNodeProperty(
  tscnContent: string,
  nodePath: string,
  property: string,
  value: string,
): SceneEditResult {
  const lines = normalizeLines(tscnContent);
  const nodeLine = findNodeSectionLine(lines, nodePath);

  if (nodeLine === -1) {
    return { success: false, message: `Node not found: ${nodePath}` };
  }

  const end = nodeSectionEnd(lines, nodeLine);
  const propPrefix = `${property} = `;

  // Try to find existing property line
  for (let i = nodeLine + 1; i <= end; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith(propPrefix)) {
      lines[i] = `${property} = ${value}`;
      return { success: true, message: `Updated ${property} on ${nodePath}`, scene: lines.join('\n') };
    }
    // Also handle property:type = value format
    if (trimmed.startsWith(`${property}:`)) {
      const rest = trimmed.slice(trimmed.indexOf(':') + 1);
      const typeMatch = rest.match(/^(\w+)\s*=/);
      if (typeMatch) {
        lines[i] = `${property}:${typeMatch[1]} = ${value}`;
        return { success: true, message: `Updated ${property} on ${nodePath}`, scene: lines.join('\n') };
      }
    }
  }

  // Property not found — insert after the last property line of the node section
  let insertAt = nodeLine + 1;
  for (let i = nodeLine + 1; i <= end; i++) {
    if (lines[i].trim() !== '' && (lines[i].startsWith('\t') || lines[i].startsWith(' '))) {
      insertAt = i + 1;
    }
  }
  lines.splice(insertAt, 0, `${property} = ${value}`);

  return { success: true, message: `Added ${property} = ${value} to ${nodePath}`, scene: lines.join('\n') };
}

/**
 * Delete a node and all its children from a .tscn scene.
 * Children are identified by having a parent path that starts with the target nodePath.
 */
export function deleteNode(
  tscnContent: string,
  nodePath: string,
): SceneEditResult {
  const lines = normalizeLines(tscnContent);

  const targetLine = findNodeSectionLine(lines, nodePath);
  if (targetLine === -1) {
    return { success: false, message: `Node not found: ${nodePath}` };
  }

  // Find all descendant node sections
  const descendantRanges: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('[node')) continue;

    const name = getBracketAttr(trimmed, 'name');
    let parent = getBracketAttr(trimmed, 'parent');

    // Also check property lines for parent
    if (parent === null) {
      const end = findSectionEnd(lines, i);
      for (let j = i + 1; j < end; j++) {
        const pl = lines[j].trim();
        if (pl.startsWith('parent = ') || pl.startsWith('parent=')) {
          parent = pl.replace(/^parent\s*=\s*/, '').replace(/"/g, '').trim();
          break;
        }
      }
    }

    // Build this node's full path
    let thisPath = name || '';
    if (parent && parent !== '') {
      thisPath = `${parent}/${thisPath}`;
    }

    if (thisPath === nodePath || thisPath.startsWith(nodePath + '/')) {
      const sectionEnd = nodeSectionEnd(lines, i);
      descendantRanges.push([i, sectionEnd]);
    }
  }

  // Sort by start line descending so we can splice from bottom up
  descendantRanges.sort((a, b) => b[0] - a[0]);
  for (const [start, end] of descendantRanges) {
    lines.splice(start, end - start + 1);
  }

  return {
    success: true,
    message: `Deleted node ${nodePath} and ${descendantRanges.length} section(s)`,
    scene: lines.join('\n'),
  };
}

/**
 * Add a signal connection to a .tscn scene.
 * Appends a [connection] section at the end of the file.
 */
export function addConnection(
  tscnContent: string,
  signal: string,
  fromNode: string,
  toNode: string,
  method: string,
): SceneEditResult {
  const lines = normalizeLines(tscnContent);

  const connLine = `[connection signal="${signal}" from="${fromNode}" to="${toNode}" method="${method}"]`;

  // Append before any trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  lines.push('');
  lines.push(connLine);
  lines.push('');

  return {
    success: true,
    message: `Added connection: ${fromNode}.${signal} -> ${toNode}.${method}`,
    scene: lines.join('\n'),
  };
}

/**
 * Remove a signal connection from a .tscn scene.
 * Matches by signal name and from node.
 */
export function removeConnection(
  tscnContent: string,
  signal: string,
  fromNode: string,
): SceneEditResult {
  const lines = normalizeLines(tscnContent);
  let removed = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('[connection')) continue;

    const sig = getBracketAttr(trimmed, 'signal');
    const from = getBracketAttr(trimmed, 'from');

    if (sig === signal && from === fromNode) {
      lines.splice(i, 1);
      removed = true;
      break;
    }
  }

  if (!removed) {
    return { success: false, message: `Connection not found: ${fromNode}.${signal}` };
  }

  return {
    success: true,
    message: `Removed connection: ${fromNode}.${signal}`,
    scene: lines.join('\n'),
  };
}

/**
 * Set (or change) the script attached to a node.
 * This involves:
 * 1. Adding an ext_resource entry for the script (if not already present).
 * 2. Setting the `script` property on the node to ExtResource(id).
 */
export function setNodeScript(
  tscnContent: string,
  nodePath: string,
  scriptPath: string,
): SceneEditResult {
  const lines = normalizeLines(tscnContent);

  const nodeLine = findNodeSectionLine(lines, nodePath);
  if (nodeLine === -1) {
    return { success: false, message: `Node not found: ${nodePath}` };
  }

  // Check if ext_resource for this script already exists
  let extId: number | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[ext_resource')) continue;
    if (trimmed.includes(`path="${scriptPath}"`)) {
      const idMatch = trimmed.match(/id=(\d+)/);
      if (idMatch) {
        extId = parseInt(idMatch[1]);
        break;
      }
    }
  }

  if (extId === null) {
    // Find the next available ext_resource id
    let maxId = 0;
    for (const line of lines) {
      const idMatch = line.match(/\[ext_resource.*\bid=(\d+)/);
      if (idMatch) {
        const id = parseInt(idMatch[1]);
        if (id > maxId) maxId = id;
      }
    }
    extId = maxId + 1;

    // Insert the new ext_resource after the last ext_resource or after the header
    let insertAt = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().startsWith('[ext_resource')) {
        insertAt = i + 1;
        break;
      }
    }
    // If no ext_resource found, insert after header
    if (insertAt === lines.length) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('[') && !lines[i].trim().startsWith('[gd_scene')) {
          insertAt = i;
          break;
        }
      }
    }

    lines.splice(insertAt, 0, `[ext_resource type="Script" path="${scriptPath}" id="${extId}"]`);
  }

  // Re-find node line after potential insertion
  const newNodeLine = findNodeSectionLine(lines, nodePath);
  if (newNodeLine === -1) {
    return { success: false, message: `Node not found after ext_resource insertion: ${nodePath}` };
  }

  const end = nodeSectionEnd(lines, newNodeLine);
  let found = false;
  for (let i = newNodeLine + 1; i <= end; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('script = ') || trimmed.startsWith('script=')) {
      lines[i] = `script = ExtResource("${extId}")`;
      found = true;
      break;
    }
  }

  if (!found) {
    lines.splice(newNodeLine + 1, 0, `script = ExtResource("${extId}")`);
  }

  return {
    success: true,
    message: `Set script on ${nodePath} to ${scriptPath} (ExtResource(${extId}))`,
    scene: lines.join('\n'),
  };
}

/**
 * Change the type of a node in a .tscn scene.
 * Replaces the `type` attribute in the [node] header.
 */
export function changeNodeType(
  tscnContent: string,
  nodePath: string,
  newType: string,
): SceneEditResult {
  const lines = normalizeLines(tscnContent);
  const nodeLine = findNodeSectionLine(lines, nodePath);

  if (nodeLine === -1) {
    return { success: false, message: `Node not found: ${nodePath}` };
  }

  const header = lines[nodeLine];
  const typeMatch = header.match(/type="[^"]*"/);

  if (!typeMatch) {
    return { success: false, message: `Node ${nodePath} has no type attribute` };
  }

  const oldType = typeMatch[0].match(/type="([^"]*)"/)![1];
  lines[nodeLine] = header.replace(/type="[^"]*"/, `type="${newType}"`);

  return {
    success: true,
    message: `Changed ${nodePath} type from ${oldType} to ${newType}`,
    scene: lines.join('\n'),
  };
}
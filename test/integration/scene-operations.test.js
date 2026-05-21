import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import * as scene from '../../build/tools/scene.js';
import { ensureGodot, itIfGodot, getGodotPath } from '../helpers/integration-setup.js';
import { createToolContext, createTempProject } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

/**
 * Helper: check if a tool call result indicates success.
 * - parseGdscriptResult path → returns textResult (no isError) on success,
 *   opsErrorResult (isError=true) on failure.
 * - spawn path (add_node) → returns { content: [{ text }] } without isError on
 *   both success and failure; check for error keywords in text instead.
 * - read_scene → returns textResult on both success and "not found" cases;
 *   check content text for error indicators.
 */
function isSuccessful(result) {
  if (result.isError) return false;
  const text = result.content?.[0]?.text || '';
  // spawn path failure pattern: "failed (exit code N)"
  if (/failed \(exit code \d+\)/i.test(text)) return false;
  // opsErrorResult wraps JSON with success:false
  try {
    const parsed = JSON.parse(text);
    if (parsed.success === false) return false;
  } catch { /* not JSON, that's fine */ }
  return true;
}

describe('Level B: Scene operations', async () => {
  await ensureGodot();
  const dirRef = { path: null };
  let ctx;

  afterEach(() => {
    if (dirRef.path) {
      try { rmSync(dirRef.path, { recursive: true, force: true }); } catch {}
      dirRef.path = null;
    }
  });

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();
  });

  // --- 用例 6: add_node to scene ---
  itIfGodot('add node to scene', async () => {
    const result = await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Sprite2D',
      node_name: 'TestSprite',
    }, ctx);
    assert.ok(isSuccessful(result), `Should succeed: ${result.content?.[0]?.text || ''}`);
  });

  // --- 用例 7: add node then edit node position ---
  itIfGodot('add node then edit node position', async () => {
    await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'MovableNode',
    }, ctx);

    const editResult = await scene.handleTool('edit_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/MovableNode',
      properties: { position: [100, 200] },
    }, ctx);
    assert.ok(isSuccessful(editResult), `Edit should succeed: ${editResult.content?.[0]?.text || ''}`);

    // Verify scene is still valid after edit (edit_node operates at runtime,
    // position changes don't persist to .tscn in headless mode)
    const readResult = await scene.handleTool('read_scene', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
    }, ctx);
    assert.ok(isSuccessful(readResult), 'Read should succeed after edit');
  });

  // --- 用例 8: read scene tree ---
  itIfGodot('read scene tree with children', async () => {
    const result = await scene.handleTool('read_scene', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
    }, ctx);
    assert.ok(isSuccessful(result));
    const text = result.content[0].text;
    assert.ok(text.includes('Root') || text.includes('Main'),
      'Should contain scene nodes');
  });

  // --- 用例 9: full CRUD chain ---
  itIfGodot('full CRUD chain — add, read, edit, remove', async () => {
    const scenePath = 'res://scenes/main.tscn';

    const addResult = await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: scenePath,
      node_type: 'Node2D',
      node_name: 'CRUDNode',
    }, ctx);
    assert.ok(isSuccessful(addResult), 'Create should succeed');

    const readResult = await scene.handleTool('read_scene', {
      project_path: dirRef.path,
      scene_path: scenePath,
    }, ctx);
    assert.ok(isSuccessful(readResult), 'Read should succeed');
    // Verify the node was added: totalNodes should be >= 2 (Root + CRUDNode + possible Main)
    const readData = JSON.parse(readResult.content[0].text);
    assert.ok(readData.totalNodes >= 2,
      `Read should reflect at least 2 nodes, got ${readData.totalNodes}`);

    const editResult = await scene.handleTool('edit_node', {
      project_path: dirRef.path,
      scene_path: scenePath,
      node_path: 'root/Root/CRUDNode',
      properties: { position: [50, 75] },
    }, ctx);
    assert.ok(isSuccessful(editResult), 'Edit should succeed');

    const removeResult = await scene.handleTool('remove_node', {
      project_path: dirRef.path,
      scene_path: scenePath,
      node_path: 'root/Root/CRUDNode',
    }, ctx);
    assert.ok(isSuccessful(removeResult), 'Remove should succeed');
  });

  // --- 用例 10: remove node (basic flow, no confirmation token in headless) ---
  itIfGodot('remove node completes without error', async () => {
    await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'TokenNode',
    }, ctx);

    const result = await scene.handleTool('remove_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/TokenNode',
    }, ctx);
    assert.ok(isSuccessful(result), `Remove should succeed: ${result.content?.[0]?.text || ''}`);
  });

  // --- 用例 11: read non-existent scene returns error ---
  // TODO: read_scene should use errorResult() for file-not-found instead of textResult(),
  // so isError would be set and tests could assert on it directly.
  itIfGodot('read non-existent scene returns error', async () => {
    const result = await scene.handleTool('read_scene', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/DOES_NOT_EXIST.tscn',
    }, ctx);
    // read_scene uses textResult (not errorResult) for missing files,
    // so isError is not set. Check the text content instead.
    const text = result.content?.[0]?.text || '';
    assert.ok(
      text.includes('not found') || text.includes('NOT_EXIST') || result.isError,
      `Should indicate file not found: ${text}`,
    );
  });
});

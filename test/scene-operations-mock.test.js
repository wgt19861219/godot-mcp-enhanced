// Level B 集成测试：场景操作工具（scene.handleTool）
import { expect, it, beforeEach, describe, vi } from 'vitest';

// Mock the executor — hoisted to top by Vitest
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(() => Promise.resolve({
    success: true, compile_success: true, compile_error: '',
    errors: [], run_success: true, run_error: '',
    outputs: [{ key: 'result', value: '{"ok":true}' }],
    raw_output: '', duration_ms: 100,
  })),
  parseMcpMarkers: vi.fn((raw) => ({
    parsed: null,
    logLines: raw.split('\n').map((l) => l.trim()).filter(Boolean),
  })),
}));

import { executeGdscript } from '../src/gdscript-executor.js';
import * as scene from '../src/tools/scene.js';
import { createToolContext, createTempProject, registerCleanup } from './helpers/tool-context.js';
import { MINIMAL_PROJECT } from './helpers/fixtures.js';

/**
 * 辅助函数：判断工具调用结果是否成功。
 * - spawn 路径（add_node）返回 { content: [{ text }] }，成功和失败都不设 isError，
 *   需检查 text 中的错误关键词。
 * - parseGdscriptResult 路径成功时返回 textResult（无 isError），失败时返回
 *   opsErrorResult（isError=true）。
 * - read_scene 成功和"未找到"都返回 textResult，需检查文本内容。
 */
function isSuccessful(result) {
  if (result.isError) return false;
  const text = result.content?.[0]?.text || '';
  if (/failed \(exit code \d+\)/i.test(text)) return false;
  try {
    const parsed = JSON.parse(text);
    if (parsed.success === false) return false;
  } catch { /* 非 JSON，忽略 */ }
  return true;
}

describe('Level B: Scene Operations', () => {
  const dirRef = { path: null };
  let ctx;

  // 注册临时目录自动清理
  registerCleanup(dirRef);

  beforeEach(() => {
    vi.mocked(executeGdscript).mockReset();
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => 'godot';
  });

  // --- 用例 1: add_node — 添加 Sprite2D 到场景 ---
  it('add_node — 添加 Sprite2D 到 main.tscn', async () => {
    const result = await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Sprite2D',
      node_name: 'TestSprite',
    }, ctx);
    expect(isSuccessful(result)).toBeTruthy();
  });

  // --- 用例 2: edit_node — 添加节点后修改位置 ---
  it('edit_node — add_node + edit_node position', async () => {
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
    expect(isSuccessful(editResult)).toBeTruthy();
  });

  // --- 用例 3: query_scene_tree — 查询场景树 ---
  it('query_scene_tree — 查询 main.tscn 场景树', async () => {
    const result = await scene.handleTool('read_scene', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
    }, ctx);
    expect(isSuccessful(result)).toBeTruthy();
    const text = result.content[0].text;
    expect(text.includes('Root')).toBeTruthy();
  });

  // --- 用例 4: full CRUD cycle — 创建 → 编辑 → 删除 ---
  it('full CRUD cycle — create, edit, remove', async () => {
    const scenePath = 'res://scenes/main.tscn';

    // 创建
    const addResult = await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: scenePath,
      node_type: 'Node2D',
      node_name: 'CRUDNode',
    }, ctx);
    expect(isSuccessful(addResult)).toBeTruthy();

    // 编辑
    const editResult = await scene.handleTool('edit_node', {
      project_path: dirRef.path,
      scene_path: scenePath,
      node_path: 'root/Root/CRUDNode',
      properties: { position: [50, 75] },
    }, ctx);
    expect(isSuccessful(editResult)).toBeTruthy();

    // 删除
    const removeResult = await scene.handleTool('remove_node', {
      project_path: dirRef.path,
      scene_path: scenePath,
      node_path: 'root/Root/CRUDNode',
    }, ctx);
    expect(isSuccessful(removeResult)).toBeTruthy();
  });

  // --- 用例 5: remove_node confirmation token 流程 ---
  it('remove_node confirmation token — 无 token 时检查返回值', async () => {
    // 先添加节点
    await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Node2D',
      node_name: 'TokenNode',
    }, ctx);

    // 尝试无 confirmation_token 删除
    const result = await scene.handleTool('remove_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/TokenNode',
    }, ctx);

    const text = result.content?.[0]?.text || '';

    // 如果返回 confirmation_token，使用它完成删除
    if (text.includes('confirmation_token')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.confirmation_token) {
          const confirmResult = await scene.handleTool('remove_node', {
            project_path: dirRef.path,
            scene_path: 'res://scenes/main.tscn',
            node_path: 'root/Root/TokenNode',
            confirmation_token: parsed.confirmation_token,
          }, ctx);
          expect(isSuccessful(confirmResult)).toBeTruthy();
          return;
        }
      } catch { /* 非 JSON 格式，继续 */ }
    }

    // 无 confirmation_token 时，直接删除应成功
    expect(isSuccessful(result)).toBeTruthy();
  });

  // --- 用例 6: nonexistent scene — 读取不存在的场景 ---
  it('nonexistent scene — read_scene 不存在的 .tscn 应返回错误', async () => {
    const result = await scene.handleTool('read_scene', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/DOES_NOT_EXIST.tscn',
    }, ctx);
    const text = result.content?.[0]?.text || '';
    expect(
      text.includes('not found') || text.includes('NOT_EXIST') || result.isError,
    ).toBeTruthy();
  });
});

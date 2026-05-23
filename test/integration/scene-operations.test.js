// Level B 集成测试：场景操作工具（scene.handleTool）
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as scene from '../../build/tools/scene.js';
import { ensureGodot, getGodotPath, itIfGodot } from '../helpers/integration-setup.js';
import { createToolContext, createTempProject, registerCleanup } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

// itIfGodot 和 registerCleanup 通过全局变量引用 it/afterEach
globalThis.it = it;
globalThis.afterEach = afterEach;

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

describe('Level B: Scene Operations', async () => {
  await ensureGodot();
  const dirRef = { path: null };
  let ctx;

  // 注册临时目录自动清理
  registerCleanup(dirRef);

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => getGodotPath();
  });

  // --- 用例 1: add_node — 添加 Sprite2D 到场景 ---
  itIfGodot('add_node — 添加 Sprite2D 到 main.tscn', async () => {
    const result = await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
      node_type: 'Sprite2D',
      node_name: 'TestSprite',
    }, ctx);
    assert.ok(isSuccessful(result), `应成功: ${result.content?.[0]?.text || ''}`);
  });

  // --- 用例 2: edit_node — 添加节点后修改位置 ---
  itIfGodot('edit_node — add_node + edit_node position', async () => {
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
    assert.ok(isSuccessful(editResult), `编辑应成功: ${editResult.content?.[0]?.text || ''}`);
  });

  // --- 用例 3: query_scene_tree — 查询场景树 ---
  itIfGodot('query_scene_tree — 查询 main.tscn 场景树', async () => {
    const result = await scene.handleTool('read_scene', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/main.tscn',
    }, ctx);
    assert.ok(isSuccessful(result), '读取场景树应成功');
    const text = result.content[0].text;
    assert.ok(text.includes('Root'), '场景树应包含 Root 节点');
  });

  // --- 用例 4: full CRUD cycle — 创建 → 编辑 → 删除 ---
  itIfGodot('full CRUD cycle — create, edit, remove', async () => {
    const scenePath = 'res://scenes/main.tscn';

    // 创建
    const addResult = await scene.handleTool('add_node', {
      project_path: dirRef.path,
      scene_path: scenePath,
      node_type: 'Node2D',
      node_name: 'CRUDNode',
    }, ctx);
    assert.ok(isSuccessful(addResult), '创建节点应成功');

    // 编辑
    const editResult = await scene.handleTool('edit_node', {
      project_path: dirRef.path,
      scene_path: scenePath,
      node_path: 'root/Root/CRUDNode',
      properties: { position: [50, 75] },
    }, ctx);
    assert.ok(isSuccessful(editResult), '编辑节点应成功');

    // 删除
    const removeResult = await scene.handleTool('remove_node', {
      project_path: dirRef.path,
      scene_path: scenePath,
      node_path: 'root/Root/CRUDNode',
    }, ctx);
    assert.ok(isSuccessful(removeResult), '删除节点应成功');
  });

  // --- 用例 5: remove_node confirmation token 流程 ---
  itIfGodot('remove_node confirmation token — 无 token 时检查返回值', async () => {
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
          assert.ok(isSuccessful(confirmResult), '使用 confirmation_token 删除应成功');
          return;
        }
      } catch { /* 非 JSON 格式，继续 */ }
    }

    // 无 confirmation_token 时，直接删除应成功
    assert.ok(isSuccessful(result), `删除应成功: ${text}`);
  });

  // --- 用例 6: nonexistent scene — 读取不存在的场景 ---
  itIfGodot('nonexistent scene — read_scene 不存在的 .tscn 应返回错误', async () => {
    const result = await scene.handleTool('read_scene', {
      project_path: dirRef.path,
      scene_path: 'res://scenes/DOES_NOT_EXIST.tscn',
    }, ctx);
    const text = result.content?.[0]?.text || '';
    assert.ok(
      text.includes('not found') || text.includes('NOT_EXIST') || result.isError,
      `应指示文件未找到: ${text}`,
    );
  });
});

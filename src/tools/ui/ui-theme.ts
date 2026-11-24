// UI theme operations: ui_set_theme, theme_create, theme_set_property.

import { gdEscape, escapeForGdLiteral, sanitizeResPath, SCENE_TREE_HEADER } from '../shared.js';

// ─── ui_set_theme ──────────────────────────────────────────────────────────

export function genUiSetThemeScript(
  scenePath: string,
  nodePath: string,
  action: 'set_params' | 'create' | 'save' | 'load',
  themePath?: string,
  params?: Record<string, unknown>,
): string {
  let actionBlock: string;

  switch (action) {
    case 'create':
      actionBlock = `
\tvar theme = Theme.new()
\tnode.theme = theme`;
      break;
    case 'set_params': {
      const paramLines: string[] = [];
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value === null || value === undefined) {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", null)`);
          } else if (typeof value === 'number') {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", ${value})`);
          } else if (typeof value === 'boolean') {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", ${String(value)})`);
          } else if (typeof value === 'string') {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", "${gdEscape(value)}")`);
          } else if (Array.isArray(value) && value.length === 4) {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", Color(${value[0]}, ${value[1]}, ${value[2]}, ${value[3]}))`);
          }
        }
      }
      actionBlock = `
\tvar theme = node.theme
\tif theme == null:
\t\t_mcp_output("error", "Node has no theme assigned")
\t\t_mcp_done()
\t\treturn${paramLines.length > 0 ? '\n' + paramLines.join('\n') : ''}`;
      break;
    }
    case 'save':
      if (!themePath) throw new Error('theme_path is required for save action');
      actionBlock = `
\tvar theme = node.theme
\tif theme == null:
\t\t_mcp_output("error", "Node has no theme to save")
\t\t_mcp_done()
\t\treturn
\tvar dir = "${escapeForGdLiteral(themePath)}".get_base_dir()
\tif not DirAccess.dir_exists_absolute(dir):
\t\tDirAccess.make_dir_recursive_absolute(dir)
\tvar _full := "${escapeForGdLiteral(themePath)}"
\tvar _ext := _full.get_extension()
\tvar _tmp := _full + ".tmp." + _ext
\tif FileAccess.file_exists(_tmp):
\t\tDirAccess.remove_absolute(_tmp)
\tvar err := ResourceSaver.save(theme, _tmp)
\tif err != OK:
\t\tDirAccess.remove_absolute(_tmp)
\t\t_mcp_output("error", "Failed to save theme: " + str(err))
\t\t_mcp_done()
\t\treturn
\tvar _ren := DirAccess.rename_absolute(_tmp, _full)
\tif _ren != OK:
\t\tDirAccess.remove_absolute(_tmp)
\t\t_mcp_output("error", "Failed to rename tmp: " + str(_ren))
\t\t_mcp_done()
\t\treturn`;
      break;
    case 'load':
      if (!themePath) throw new Error('theme_path is required for load action');
      actionBlock = `
\tvar res = load("${escapeForGdLiteral(themePath)}")
\tif res == null:
\t\t_mcp_output("error", "Failed to load theme from: ${escapeForGdLiteral(themePath)}")
\t\t_mcp_done()
\t\treturn
\tnode.theme = res`;
      break;
  }

  const outputKey = action === 'save' ? 'saved' : action === 'load' ? 'loaded' : 'theme_set';
  const outputValue = action === 'save'
    ? '{"resource_path": "' + escapeForGdLiteral(themePath || '') + '"}'
    : action === 'load'
      ? '{"resource_path": "' + escapeForGdLiteral(themePath || '') + '"}'
      : '{"node": "' + escapeForGdLiteral(nodePath) + '", "action": "' + action + '"}';

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${escapeForGdLiteral(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${escapeForGdLiteral(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn${actionBlock}
\t_mcp_output("${outputKey}", ${outputValue})
\t_mcp_done()
`;
}

// ─── theme_create ──────────────────────────────────────────────────────────

/** scenePath 依赖按 action 分支(反馈 2026-11-18):create 只新建空 Theme(可选直接落盘),
 * 不依赖场景——scenePath 为 null 时脚本不加载场景;extract 读节点上的 Theme,场景必填。
 * 场景守卫与 actionBlock 各自自足(守卫带尾换行、actionBlock 无前导换行):守卫缺席时
 * 函数体首行紧贴 `func _initialize():`,不留空行;守卫在场时产物与分支前逐字节相同。 */
export function genThemeCreateScript(
  scenePath: string | null,
  action: 'create' | 'extract',
  sourceNodePath?: string,
  savePath?: string,
): string {
  if (action === 'extract' && scenePath === null) throw new Error('scene_path is required for extract action');
  let actionBlock: string;

  if (action === 'create') {
    actionBlock = `\tvar theme = Theme.new()`;
  } else {
    // extract
    if (!sourceNodePath) throw new Error('source_node_path is required for extract action');
    actionBlock = `\tvar source = _mcp_get_scene_node("${escapeForGdLiteral(sourceNodePath)}")
\tif source == null:
\t\t_mcp_output("error", "Source node not found: ${escapeForGdLiteral(sourceNodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not source is Control:
\t\t_mcp_output("error", "Source node is not a Control: " + source.get_class())
\t\t_mcp_done()
\t\treturn
\tvar theme = source.theme
\tif theme == null:
\t\t_mcp_output("error", "Source node has no theme")
\t\t_mcp_done()
\t\treturn`;
  }

  let saveBlock = '';
  if (savePath) {
    saveBlock = `
\tvar dir = "${escapeForGdLiteral(savePath)}".get_base_dir()
\tif not DirAccess.dir_exists_absolute(dir):
\t\tDirAccess.make_dir_recursive_absolute(dir)
\tvar _full := "${escapeForGdLiteral(savePath)}"
\tvar _ext := _full.get_extension()
\tvar _tmp := _full + ".tmp." + _ext
\tif FileAccess.file_exists(_tmp):
\t\tDirAccess.remove_absolute(_tmp)
\tvar err := ResourceSaver.save(theme, _tmp)
\tif err != OK:
\t\tDirAccess.remove_absolute(_tmp)
\t\t_mcp_output("error", "Failed to save theme: " + str(err))
\t\t_mcp_done()
\t\treturn
\tvar _ren := DirAccess.rename_absolute(_tmp, _full)
\tif _ren != OK:
\t\tDirAccess.remove_absolute(_tmp)
\t\t_mcp_output("error", "Failed to rename tmp: " + str(_ren))
\t\t_mcp_done()
\t\treturn
\t_mcp_output("saved", {"resource_path": "${escapeForGdLiteral(savePath)}"})
\t_mcp_done()
\treturn`;
  }

  const sceneGuard = scenePath === null ? '' :
    `\tif not _mcp_load_scene("${escapeForGdLiteral(scenePath)}"):\n\t\t_mcp_done()\n\t\treturn\n`;

  return `${SCENE_TREE_HEADER}
func _initialize():
${sceneGuard}${actionBlock}${saveBlock}
\t_mcp_output("theme_created", {"action": "${action}"})
\t_mcp_done()
`;
}

// ─── theme_set_property ────────────────────────────────────────────────────

export function genThemeSetPropertyScript(
  projectPath: string,
  themeNodePath: string,
  itemType: 'default_font' | 'color' | 'constant' | 'stylebox',
  name: string,
  value: unknown,
  themeType?: string,
  scenePath?: string,
): string {
  const sceneLine = scenePath
    ? `\tif not _mcp_load_scene("${escapeForGdLiteral(scenePath)}"):\n\t\t_mcp_done()\n\t\treturn\n`
    : '';

  let setLine = '';
  const tt = themeType ? `"${gdEscape(themeType)}"` : '""';
  const safeName = gdEscape(name);

  switch (itemType) {
    case 'default_font': {
      const fontPath = String(value);
      sanitizeResPath(fontPath, 'font_path');
      setLine = `\ttheme.set_default_font(load("${escapeForGdLiteral(fontPath)}"))`;
      break;
    }
    case 'color': {
      let c = value;
      // MCP may serialize arrays as strings — try to parse
      if (typeof c === 'string') { try { c = JSON.parse(c); } catch { /* fall through to error */ } }
      if (!Array.isArray(c) || c.length < 3) throw new Error('Color value must be array [r, g, b] or [r, g, b, a]');
      const a = c.length >= 4 ? c[3] : 1.0;
      // 阶段1b: 元素须为有限数字,否则 GDScript Color(NaN,...) 无效
      const colorNums = [c[0], c[1], c[2], a].map(Number);
      if (colorNums.some(n => !Number.isFinite(n))) throw new Error('Color array elements must be finite numbers');
      setLine = `\ttheme.set_color("${safeName}", ${tt}, Color(${colorNums[0]}, ${colorNums[1]}, ${colorNums[2]}, ${colorNums[3]}))`;
      break;
    }
    case 'constant': {
      // 阶段1b: value 须为有限数字,否则 Number(NaN) 生成无效 GDScript set_constant(..., NaN)
      const constNum = Number(value);
      if (!Number.isFinite(constNum)) throw new Error('constant value must be a finite number');
      setLine = `\ttheme.set_constant("${safeName}", ${tt}, ${constNum})`;
      break;
    }
    case 'stylebox': {
      const sbPath = String(value);
      sanitizeResPath(sbPath, 'stylebox_path');
      setLine = `\ttheme.set_stylebox("${safeName}", ${tt}, load("${escapeForGdLiteral(sbPath)}"))`;
      break;
    }
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
${sceneLine}\tvar node = _mcp_get_scene_node("${escapeForGdLiteral(themeNodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${escapeForGdLiteral(themeNodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar theme = node.theme
\tif theme == null:
\t\t_mcp_output("error", "Node has no theme assigned")
\t\t_mcp_done()
\t\treturn
\tif not theme is Theme:
\t\t_mcp_output("error", "Node.theme is not a Theme")
\t\t_mcp_done()
\t\treturn
${setLine}
\t_mcp_output("property_set", {"node": "${escapeForGdLiteral(themeNodePath)}", "item_type": "${itemType}", "name": "${safeName}"})
\t_mcp_done()
`;
}

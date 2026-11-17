// ui-tokens:批3 DesignTokens token 生成器(GD 脚本层)。
// 与 ui-theme.ts(ui_set_theme/theme_* 生成器)、ui-measure.ts(measure 生成器)分工一致:
// token 相关的 GD 脚本生成独立成文件,不与主题挂载/测量逻辑混居。
// 翻译器纯函数(prototype-import.ts 的 resolveGeometryTokens)保持零 Godot 依赖——
// 本文件是它唯一的数据来源侧(theme 资源 → token map 的 GD 预取通道);
// 批3 Task 4 增文件级读写:genTokenSetScript(原子落盘)/genTokenListScript(审计)。

import { escapeForGdLiteral, SCENE_TREE_HEADER } from '../shared.js';
import { DESIGN_TOKENS_TYPE } from './types.js';

/**
 * 批3 Task 3:theme DesignTokens colors 预取脚本——无场景加载(只 load 资源,
 * 不碰 _mcp_load_scene),headless 单次 spawn(loadAutoloads=false,调用方约定)即出:
 * - `load(themePath)` → null/非 Theme → `_mcp_output("error", "theme_path load failed: <path>")`
 *   (消息不含 "not found",不撞 uiErrorMapper 首位 NODE_NOT_FOUND 分支;由
 *   `includes('theme_path load failed')` 全前缀 → THEME_NOT_FOUND 分流);
 * - `get_color_list(DESIGN_TOKENS_TYPE)` 遍历,**Color 先转 [r,g,b,a] 数组再入 dict**
 *   (裸 Color 经 str() 序列化会退化成 "Color(r, g, b, a)" 字符串,JSON roundtrip 后
 *   无法还原数值——数组是 TS 侧 TokenColorMap 的直接形状);
 * - `_mcp_output("token_map", JSON.stringify({"colors": _colors}))`。
 * theme 无 DesignTokens type(裸 Theme)→ get_color_list 返回空 → 空 dict →
 * TS 侧 resolve 走缺键路径 TOKEN_NOT_FOUND(诚实点名,不静默)。
 * 路径 escapeForGdLiteral(纯字符串字面量内插,同 genThemeMountInit 先例)。
 */
export function genTokenPrefetchScript(themePath: string): string {
  const tp = escapeForGdLiteral(themePath);
  return `${SCENE_TREE_HEADER}
func _initialize():
\tvar _theme = load("${tp}")
\tif _theme == null or not _theme is Theme:
\t\t_mcp_output("error", "theme_path load failed: ${tp}")
\t\t_mcp_done()
\t\treturn
\tvar _colors := {}
\tfor _name in _theme.get_color_list("${DESIGN_TOKENS_TYPE}"):
\t\tvar _c: Color = _theme.get_color(_name, "${DESIGN_TOKENS_TYPE}")
\t\t_colors[str(_name)] = [_c.r, _c.g, _c.b, _c.a]
\t_mcp_output("token_map", JSON.stringify({"colors": _colors}))
\t_mcp_done()
`;
}

// ─── 批3 Task 4:token_set / token_list(文件级读写)──────────────────────────

/** theme 缺失分支的错误输出(两个 generator 同款;文案 brief 逐字)。消息含 'not found',
 * 会被 uiErrorMapper 通用 NODE_NOT_FOUND 首位截胡——Task 4 已在首位之前插入
 * 'theme file not found' → THEME_NOT_FOUND 分支(见 index.ts uiErrorMapper)。 */
function themeFileNotFoundBlock(tp: string): string {
  return `\tif _theme == null or not _theme is Theme:
\t\t_mcp_output("error", "theme file not found: ${tp}(先 theme_create(scene_path+save_path) 或 ui_set_theme create+save 建主题)")
\t\t_mcp_done()
\t\treturn`;
}

/**
 * 批3 Task 4:token_set——向 theme 的 DesignTokens 命名空间写一个 token 并**原子落盘**
 * (make_dir_recursive → tmp → ResourceSaver.save → rename,复制 ui-theme.ts save case 模式,
 * 错误分支同款)。value 为 array → set_color(name, DESIGN_TOKENS_TYPE, Color(...));
 * number → set_constant。无场景加载(只 load 资源,不碰 _mcp_load_scene);执行走 handler
 * 公共执行段(loadAutoloads 随公共参数 load_autoloads,默认 true,可显式关)——仅批3 Task 3
 * 预取通道(genTokenPrefetchScript 消费侧)显式 loadAutoloads=false。theme 缺失/非 Theme → 上述错误分支
 * (THEME_NOT_FOUND 分流)。输出 JSON.stringify(通道与 token_map 一致,str(Variant)
 * roundtrip 后 TS 侧可 JSON.parse)。同名覆盖 = set_color/set_constant 原位重写 + 落盘。
 */
export function genTokenSetScript(themePath: string, name: string, value: number | number[]): string {
  const tp = escapeForGdLiteral(themePath);
  const safeName = escapeForGdLiteral(name);
  const isColor = Array.isArray(value);
  const kind = isColor ? 'color' : 'constant';
  const setLine = isColor
    ? `\t_theme.set_color("${safeName}", "${DESIGN_TOKENS_TYPE}", Color(${(value as number[]).join(', ')}))`
    : `\t_theme.set_constant("${safeName}", "${DESIGN_TOKENS_TYPE}", ${value})`;
  return `${SCENE_TREE_HEADER}
func _initialize():
\tvar _theme = load("${tp}")
${themeFileNotFoundBlock(tp)}
\tvar _dir := "${tp}".get_base_dir()
\tif not DirAccess.dir_exists_absolute(_dir):
\t\tDirAccess.make_dir_recursive_absolute(_dir)
\tvar _full := "${tp}"
\tvar _ext := _full.get_extension()
\tvar _tmp := _full + ".tmp." + _ext
\tif FileAccess.file_exists(_tmp):
\t\tDirAccess.remove_absolute(_tmp)
${setLine}
\tvar _err := ResourceSaver.save(_theme, _tmp)
\tif _err != OK:
\t\tDirAccess.remove_absolute(_tmp)
\t\t_mcp_output("error", "Failed to save theme: " + str(_err))
\t\t_mcp_done()
\t\treturn
\tvar _ren := DirAccess.rename_absolute(_tmp, _full)
\tif _ren != OK:
\t\tDirAccess.remove_absolute(_tmp)
\t\t_mcp_output("error", "Failed to rename tmp: " + str(_ren))
\t\t_mcp_done()
\t\treturn
\t_mcp_output("token_set", JSON.stringify({"name": "${safeName}", "path": "${tp}", "kind": "${kind}"}))
\t_mcp_done()
`;
}

/**
 * 批3 Task 4:token_list——审计 theme 的 DesignTokens 命名空间全量 token(colors +
 * constants 双通道)。Color 先转 [r,g,b,a] 数组再入 dict(同 genTokenPrefetchScript 的
 * JSON roundtrip 通道);constants 经 get_constant 数值直读。裸 Theme(无 DesignTokens
 * type)→ 两通道空 dict,不报错(审计语义,缺失≠错误)。输出
 * `_mcp_output("token_list", JSON.stringify({"colors": ..., "constants": ...}))`。
 */
export function genTokenListScript(themePath: string): string {
  const tp = escapeForGdLiteral(themePath);
  return `${SCENE_TREE_HEADER}
func _initialize():
\tvar _theme = load("${tp}")
${themeFileNotFoundBlock(tp)}
\tvar _colors := {}
\tfor _name in _theme.get_color_list("${DESIGN_TOKENS_TYPE}"):
\t\tvar _c: Color = _theme.get_color(_name, "${DESIGN_TOKENS_TYPE}")
\t\t_colors[str(_name)] = [_c.r, _c.g, _c.b, _c.a]
\tvar _constants := {}
\tfor _name in _theme.get_constant_list("${DESIGN_TOKENS_TYPE}"):
\t\t_constants[str(_name)] = _theme.get_constant(_name, "${DESIGN_TOKENS_TYPE}")
\t_mcp_output("token_list", JSON.stringify({"colors": _colors, "constants": _constants}))
\t_mcp_done()
`;
}

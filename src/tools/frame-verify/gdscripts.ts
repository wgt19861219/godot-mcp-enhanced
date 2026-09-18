// GDScript 代码字符串生成器 —— 返回字符串，不执行。由 workflow.ts 通过 executeGdscript 执行。
// 图像数值计算放 GDScript（Godot Image API，零 npm 依赖）。
// embedding 算法来源：D:\GitHub\godogen\shared\skills\godogen\tools\find_loop_frame.py:34-37

import { escapeForGdLiteral } from '../shared.js';

// 两模板共享的 GDScript 辅助函数段(输出协议 + 32×32 归一化 embed + 余弦点积)。
// 生成的脚本必须自包含,故以常量拼接而非 Godot 侧共享。
const SIM_HELPERS_GD = `var _outputs := []

func _mcp_output(key, value):
	_outputs.append({"key": key, "value": value})

func _mcp_done():
	print(JSON.stringify(_outputs))
	quit()

func _embed(path: String) -> PackedFloat32Array:
	var img := Image.load_from_file(path)
	img.resize(32, 32)
	var raw := img.get_data()
	var v := PackedFloat32Array()
	v.resize(32 * 32 * 3)
	var sum_sq := 0.0
	for i in range(32 * 32):
		var r := raw[i * 4] / 255.0
		var g := raw[i * 4 + 1] / 255.0
		var b := raw[i * 4 + 2] / 255.0
		v[i * 3] = r
		v[i * 3 + 1] = g
		v[i * 3 + 2] = b
		sum_sq += r * r + g * g + b * b
	var norm := sqrt(sum_sq) + 1e-8
	for i in range(v.size()):
		v[i] = v[i] / norm
	return v

func _cos(a: PackedFloat32Array, b: PackedFloat32Array) -> float:
	var s := 0.0
	for i in range(a.size()):
		s += a[i] * b[i]
	return s`;

export function extractFrameMetricsScript(framesDir: string): string {
  // CRITICAL(gdscript-template-injection): 路径参数经转义后插值,防闭串注入。
  // framesDir 来源可为 MCP 工具参数(frames_dir),不可信。与 physics-ops.ts:41 同模式。
  // T2b: 路径转义用 escapeForGdLiteral(纯字面量内插,% 原样——gdEscape 双写 %% 会破坏含 % 的目录名)。
  return `extends SceneTree

var _frames_dir := "${escapeForGdLiteral(framesDir)}"
${SIM_HELPERS_GD}

func _initialize():
	var dir := DirAccess.open(_frames_dir)
	if dir == null:
		_mcp_output("error", "cannot open frames dir")
		_mcp_done()
		return
	var files := PackedStringArray()
	dir.list_dir_begin()
	var fn := dir.get_next()
	while fn != "":
		if fn.begins_with("frame_") and fn.ends_with(".png"):
			files.append(_frames_dir + "/" + fn)
		fn = dir.get_next()
	dir.list_dir_end()
	files.sort()
	if files.size() < 2:
		_mcp_output("frame_count", files.size())
		_mcp_output("error", "need >= 2 frames")
		_mcp_done()
		return
	var embs := []
	for f in files:
		embs.append(_embed(f))
	var consecutive := []
	for i in range(embs.size() - 1):
		consecutive.append(_cos(embs[i], embs[i + 1]))
	var first_sims := []
	for j in range(1, embs.size()):
		first_sims.append(_cos(embs[0], embs[j]))
	_mcp_output("frame_count", files.size())
	_mcp_output("consecutive_sims", JSON.stringify(consecutive))
	_mcp_output("first_frame_sims", JSON.stringify(first_sims))
	_mcp_done()
`;
}

export function referenceSimScript(screenshotPath: string, referencePath: string): string {
  return `extends SceneTree

${SIM_HELPERS_GD}

func _initialize():
	var a := _embed("${escapeForGdLiteral(screenshotPath)}")
	var b := _embed("${escapeForGdLiteral(referencePath)}")
	_mcp_output("reference_sim", _cos(a, b))
	_mcp_done()
`;
}

// test/frame-verify-lock.test.js
// 重构护栏:批4 Task 4.4(SIM_HELPERS_GD 常量收敛)前先固化当前两模板输出。
// 重构后本文件必须全绿且快照零漂移——生成的 GDScript 必须保持自包含且逐字不变。
import { describe, it, expect } from 'vitest';
import { extractFrameMetricsScript, referenceSimScript } from '../src/tools/frame-verify/gdscripts.js';

describe('frame-verify 模板快照锁定(收敛前基线)', () => {
  it('extractFrameMetricsScript', () => {
    expect(extractFrameMetricsScript('/tmp/frames')).toMatchInlineSnapshot(`
      "extends SceneTree

      var _frames_dir := "/tmp/frames"
      var _outputs := []

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
      	return s

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
      "
    `);
  });
  it('referenceSimScript', () => {
    expect(referenceSimScript('/tmp/shot.png', '/tmp/ref.png')).toMatchInlineSnapshot(`
      "extends SceneTree

      var _outputs := []

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
      	return s

      func _initialize():
      	var a := _embed("/tmp/shot.png")
      	var b := _embed("/tmp/ref.png")
      	_mcp_output("reference_sim", _cos(a, b))
      	_mcp_done()
      "
    `);
  });
});

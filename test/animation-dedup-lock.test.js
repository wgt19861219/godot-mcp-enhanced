// test/animation-dedup-lock.test.js
// 重构护栏:批1 收敛前先固化当前生成脚本输出。重构后本文件必须全绿且快照零漂移。
import { describe, it, expect } from 'vitest';
import {
  genRemoveTrack, genRemoveKeyframe, genAddTrack, genAddKeyframe, genUpdateKeyframe,
} from '../src/tools/animation/animation-ops.js';
import {
  genAnimationTrackRemove, genAnimationKeyframeRemove,
  genAnimationKeyframeAdd, genAnimationCurve,
} from '../src/tools/animation/animation-track.js';

const P = '/root/Main/Player';

describe('animation 双工具等价性锁定', () => {
  it('remove_track 两实现输出逐字一致', () => {
    expect(genAnimationTrackRemove(P, 'run', 1)).toBe(genRemoveTrack(P, 'run', 1));
  });
  it('remove_keyframe 两实现输出逐字一致', () => {
    expect(genAnimationKeyframeRemove(P, 'run', 0, 2)).toBe(genRemoveKeyframe(P, 'run', 0, 2));
  });
});

describe('生成脚本快照锁定(重构前基线)', () => {
  it('ops add_track', () => {
    expect(genAddTrack(P, 'run', 'value', 'Sprite2D:position')).toMatchInlineSnapshot(`
      "extends SceneTree

      var _mcp_outputs: Array = []
      # Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)
      var _mcp_root: Node = null
      var _mcp_scene_instance: Node = null

      func _mcp_get_root() -> Node:
      	if _mcp_root != null:
      		return _mcp_root
      	# Godot 4.6+: self.root is required (extends SceneTree — root is native property)
      	if self.root != null:
      		_mcp_root = self.root
      		return _mcp_root
      	return null

      func _mcp_get_node(path: NodePath) -> Node:
      	var _p: String = str(path)
      	if _p.begins_with("/"):
      		_p = _p.substr(1)
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return null
      	# Fallback: root.get_node() may fail in headless _initialize()
      	var _node: Node = _r.get_node_or_null(_p)
      	if _node != null:
      		return _node
      	# Manual traversal for headless compatibility
      	var _parts: PackedStringArray = _p.split("/")
      	_node = _r
      	for _part in _parts:
      		if _part == "":
      			continue
      		var _found: bool = false
      		for _ch in _node.get_children():
      			if _ch.name == _part:
      				_node = _ch
      				_found = true
      				break
      		if not _found:
      			if _part == "root" and _node == _r:
      				continue
      			return null
      	return _node

      func _mcp_load_main_scene() -> void:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return
      	var _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
      	if _sp != null and _sp != "":
      		var _sr = load(_sp)
      		if _sr:
      			_r.add_child(_sr.instantiate())

      func _mcp_load_scene(sp: String) -> bool:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		_mcp_output("error", "Scene root not available")
      		return false
      	if _mcp_scene_instance != null:
      		if _mcp_scene_instance.get_parent() != null:
      			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
      		_mcp_scene_instance.queue_free()
      		_mcp_scene_instance = null
      	var _sr = load(sp)
      	if _sr == null:
      		_mcp_output("error", "Failed to load scene: " + sp)
      		return false
      	_mcp_scene_instance = _sr.instantiate()
      	_r.add_child(_mcp_scene_instance)
      	return true

      func _mcp_get_scene_node(path: String) -> Node:
      	# Search within loaded scene instance (avoids root/SceneName prefix issue)
      	if _mcp_scene_instance != null:
      		var _p: String = path
      		while _p.begins_with("/"):
      			_p = _p.substr(1)
      		# Strip leading "root/" or "root" prefix
      		if _p.begins_with("root/"):
      			_p = _p.substr(5)
      		elif _p == "root":
      			_p = ""
      		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")
      		if _p != "" and _mcp_scene_instance.name.length() > 0:
      			var _scene_name: String = _mcp_scene_instance.name + "/"
      			if _p.begins_with(_scene_name):
      				_p = _p.substr(_scene_name.length())
      			elif _p == _mcp_scene_instance.name:
      				_p = ""
      		if _p == "":
      			return _mcp_scene_instance
      		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)
      		if _node != null:
      			return _node
      	# Fallback to global search
      	return _mcp_get_node(path)

      func _mcp_output(key: String, value: Variant) -> void:
      	_mcp_outputs.append({"key": key, "value": str(value)})

      func _mcp_done() -> void:
      	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
      	if Engine.get_main_loop() == self:
      		quit(0)
      func _initialize():
      	_mcp_load_main_scene()
      	var _ap: AnimationPlayer = _mcp_get_node("/root/Main/Player")
      	if _ap == null or not (_ap is AnimationPlayer):
      		_mcp_output("error", "AnimationPlayer not found")
      		_mcp_done()
      		return
      	if not _ap.has_animation("run"):
      		_mcp_output("error", "Animation not found")
      		_mcp_done()
      		return
      	var _anim: Animation = _ap.get_animation("run")
      	_anim.add_track(0)
      	var _idx: int = _anim.get_track_count() - 1
      	_anim.track_set_path(_idx, NodePath("Sprite2D:position"))
      	_mcp_output("result", {"track_index": _idx, "track_path": "Sprite2D:position", "track_type": "value"})
      	_mcp_done()
      "
    `);
  });
  it('ops add_keyframe(含 method 分支)', () => {
    expect(genAddKeyframe(P, 'run', 0, 1.5, [1, 2, 3], 2.0)).toMatchInlineSnapshot(`
      "extends SceneTree

      var _mcp_outputs: Array = []
      # Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)
      var _mcp_root: Node = null
      var _mcp_scene_instance: Node = null

      func _mcp_get_root() -> Node:
      	if _mcp_root != null:
      		return _mcp_root
      	# Godot 4.6+: self.root is required (extends SceneTree — root is native property)
      	if self.root != null:
      		_mcp_root = self.root
      		return _mcp_root
      	return null

      func _mcp_get_node(path: NodePath) -> Node:
      	var _p: String = str(path)
      	if _p.begins_with("/"):
      		_p = _p.substr(1)
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return null
      	# Fallback: root.get_node() may fail in headless _initialize()
      	var _node: Node = _r.get_node_or_null(_p)
      	if _node != null:
      		return _node
      	# Manual traversal for headless compatibility
      	var _parts: PackedStringArray = _p.split("/")
      	_node = _r
      	for _part in _parts:
      		if _part == "":
      			continue
      		var _found: bool = false
      		for _ch in _node.get_children():
      			if _ch.name == _part:
      				_node = _ch
      				_found = true
      				break
      		if not _found:
      			if _part == "root" and _node == _r:
      				continue
      			return null
      	return _node

      func _mcp_load_main_scene() -> void:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return
      	var _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
      	if _sp != null and _sp != "":
      		var _sr = load(_sp)
      		if _sr:
      			_r.add_child(_sr.instantiate())

      func _mcp_load_scene(sp: String) -> bool:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		_mcp_output("error", "Scene root not available")
      		return false
      	if _mcp_scene_instance != null:
      		if _mcp_scene_instance.get_parent() != null:
      			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
      		_mcp_scene_instance.queue_free()
      		_mcp_scene_instance = null
      	var _sr = load(sp)
      	if _sr == null:
      		_mcp_output("error", "Failed to load scene: " + sp)
      		return false
      	_mcp_scene_instance = _sr.instantiate()
      	_r.add_child(_mcp_scene_instance)
      	return true

      func _mcp_get_scene_node(path: String) -> Node:
      	# Search within loaded scene instance (avoids root/SceneName prefix issue)
      	if _mcp_scene_instance != null:
      		var _p: String = path
      		while _p.begins_with("/"):
      			_p = _p.substr(1)
      		# Strip leading "root/" or "root" prefix
      		if _p.begins_with("root/"):
      			_p = _p.substr(5)
      		elif _p == "root":
      			_p = ""
      		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")
      		if _p != "" and _mcp_scene_instance.name.length() > 0:
      			var _scene_name: String = _mcp_scene_instance.name + "/"
      			if _p.begins_with(_scene_name):
      				_p = _p.substr(_scene_name.length())
      			elif _p == _mcp_scene_instance.name:
      				_p = ""
      		if _p == "":
      			return _mcp_scene_instance
      		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)
      		if _node != null:
      			return _node
      	# Fallback to global search
      	return _mcp_get_node(path)

      func _mcp_output(key: String, value: Variant) -> void:
      	_mcp_outputs.append({"key": key, "value": str(value)})

      func _mcp_done() -> void:
      	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
      	if Engine.get_main_loop() == self:
      		quit(0)
      func _initialize():
      	_mcp_load_main_scene()
      	var _ap: AnimationPlayer = _mcp_get_node("/root/Main/Player")
      	if _ap == null or not (_ap is AnimationPlayer):
      		_mcp_output("error", "AnimationPlayer not found")
      		_mcp_done()
      		return
      	if not _ap.has_animation("run"):
      		_mcp_output("error", "Animation not found")
      		_mcp_done()
      		return
      	var _anim: Animation = _ap.get_animation("run")
      	if 0 < 0 or 0 >= _anim.get_track_count():
      		_mcp_output("error", "Track index out of range")
      		_mcp_done()
      		return
      	var _kf_idx: int = -1
      	if _anim.track_get_type(0) == Animation.TYPE_VALUE or _anim.track_get_type(0) == Animation.TYPE_BEZIER:
      		_kf_idx = _anim.track_insert_key(0, 1.5, Vector3(1, 2, 3), 2)
      	elif _anim.track_get_type(0) == Animation.TYPE_POSITION_3D:
      		_kf_idx = _anim.position_track_insert_key(0, 1.5, Vector3(1, 2, 3))
      	elif _anim.track_get_type(0) == Animation.TYPE_ROTATION_3D:
      		_kf_idx = _anim.rotation_track_insert_key(0, 1.5, Quaternion.from_euler(Vector3(1, 2, 3)))
      	elif _anim.track_get_type(0) == Animation.TYPE_SCALE_3D:
      		_kf_idx = _anim.scale_track_insert_key(0, 1.5, Vector3(1, 2, 3))

      	_mcp_output("result", {"keyframe_index": _kf_idx, "time": 1.5})
      	_mcp_done()
      "
    `);
  });
  it('ops add_keyframe(method 分支)', () => {
    expect(genAddKeyframe(P, 'run', 4, 0.5, null, 1.0, 'play_sound', ['fx'])).toMatchInlineSnapshot(`
      "extends SceneTree

      var _mcp_outputs: Array = []
      # Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)
      var _mcp_root: Node = null
      var _mcp_scene_instance: Node = null

      func _mcp_get_root() -> Node:
      	if _mcp_root != null:
      		return _mcp_root
      	# Godot 4.6+: self.root is required (extends SceneTree — root is native property)
      	if self.root != null:
      		_mcp_root = self.root
      		return _mcp_root
      	return null

      func _mcp_get_node(path: NodePath) -> Node:
      	var _p: String = str(path)
      	if _p.begins_with("/"):
      		_p = _p.substr(1)
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return null
      	# Fallback: root.get_node() may fail in headless _initialize()
      	var _node: Node = _r.get_node_or_null(_p)
      	if _node != null:
      		return _node
      	# Manual traversal for headless compatibility
      	var _parts: PackedStringArray = _p.split("/")
      	_node = _r
      	for _part in _parts:
      		if _part == "":
      			continue
      		var _found: bool = false
      		for _ch in _node.get_children():
      			if _ch.name == _part:
      				_node = _ch
      				_found = true
      				break
      		if not _found:
      			if _part == "root" and _node == _r:
      				continue
      			return null
      	return _node

      func _mcp_load_main_scene() -> void:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return
      	var _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
      	if _sp != null and _sp != "":
      		var _sr = load(_sp)
      		if _sr:
      			_r.add_child(_sr.instantiate())

      func _mcp_load_scene(sp: String) -> bool:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		_mcp_output("error", "Scene root not available")
      		return false
      	if _mcp_scene_instance != null:
      		if _mcp_scene_instance.get_parent() != null:
      			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
      		_mcp_scene_instance.queue_free()
      		_mcp_scene_instance = null
      	var _sr = load(sp)
      	if _sr == null:
      		_mcp_output("error", "Failed to load scene: " + sp)
      		return false
      	_mcp_scene_instance = _sr.instantiate()
      	_r.add_child(_mcp_scene_instance)
      	return true

      func _mcp_get_scene_node(path: String) -> Node:
      	# Search within loaded scene instance (avoids root/SceneName prefix issue)
      	if _mcp_scene_instance != null:
      		var _p: String = path
      		while _p.begins_with("/"):
      			_p = _p.substr(1)
      		# Strip leading "root/" or "root" prefix
      		if _p.begins_with("root/"):
      			_p = _p.substr(5)
      		elif _p == "root":
      			_p = ""
      		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")
      		if _p != "" and _mcp_scene_instance.name.length() > 0:
      			var _scene_name: String = _mcp_scene_instance.name + "/"
      			if _p.begins_with(_scene_name):
      				_p = _p.substr(_scene_name.length())
      			elif _p == _mcp_scene_instance.name:
      				_p = ""
      		if _p == "":
      			return _mcp_scene_instance
      		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)
      		if _node != null:
      			return _node
      	# Fallback to global search
      	return _mcp_get_node(path)

      func _mcp_output(key: String, value: Variant) -> void:
      	_mcp_outputs.append({"key": key, "value": str(value)})

      func _mcp_done() -> void:
      	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
      	if Engine.get_main_loop() == self:
      		quit(0)
      func _initialize():
      	_mcp_load_main_scene()
      	var _ap: AnimationPlayer = _mcp_get_node("/root/Main/Player")
      	if _ap == null or not (_ap is AnimationPlayer):
      		_mcp_output("error", "AnimationPlayer not found")
      		_mcp_done()
      		return
      	if not _ap.has_animation("run"):
      		_mcp_output("error", "Animation not found")
      		_mcp_done()
      		return
      	var _anim: Animation = _ap.get_animation("run")
      	if 4 < 0 or 4 >= _anim.get_track_count():
      		_mcp_output("error", "Track index out of range")
      		_mcp_done()
      		return
      	var _kf_idx: int = -1
      	if _anim.track_get_type(4) == Animation.TYPE_VALUE or _anim.track_get_type(4) == Animation.TYPE_BEZIER:
      		_kf_idx = _anim.track_insert_key(4, 0.5, null, 1)
      	elif _anim.track_get_type(4) == Animation.TYPE_POSITION_3D:
      		_kf_idx = _anim.position_track_insert_key(4, 0.5, null)
      	elif _anim.track_get_type(4) == Animation.TYPE_ROTATION_3D:
      		_kf_idx = _anim.rotation_track_insert_key(4, 0.5, null)
      	elif _anim.track_get_type(4) == Animation.TYPE_SCALE_3D:
      		_kf_idx = _anim.scale_track_insert_key(4, 0.5, null)
      	elif _anim.track_get_type(4) == Animation.TYPE_METHOD:
      		var _md: Dictionary = {"method": "play_sound", "args": ["fx"]}
      		_anim.track_insert_key(4, 0.5, _md, 1)
      	_mcp_output("result", {"keyframe_index": _kf_idx, "time": 0.5})
      	_mcp_done()
      "
    `);
  });
  it('ops update_keyframe', () => {
    expect(genUpdateKeyframe(P, 'run', 0, 1, 2.0, [0, 0, 0], 1.5)).toMatchInlineSnapshot(`
      "extends SceneTree

      var _mcp_outputs: Array = []
      # Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)
      var _mcp_root: Node = null
      var _mcp_scene_instance: Node = null

      func _mcp_get_root() -> Node:
      	if _mcp_root != null:
      		return _mcp_root
      	# Godot 4.6+: self.root is required (extends SceneTree — root is native property)
      	if self.root != null:
      		_mcp_root = self.root
      		return _mcp_root
      	return null

      func _mcp_get_node(path: NodePath) -> Node:
      	var _p: String = str(path)
      	if _p.begins_with("/"):
      		_p = _p.substr(1)
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return null
      	# Fallback: root.get_node() may fail in headless _initialize()
      	var _node: Node = _r.get_node_or_null(_p)
      	if _node != null:
      		return _node
      	# Manual traversal for headless compatibility
      	var _parts: PackedStringArray = _p.split("/")
      	_node = _r
      	for _part in _parts:
      		if _part == "":
      			continue
      		var _found: bool = false
      		for _ch in _node.get_children():
      			if _ch.name == _part:
      				_node = _ch
      				_found = true
      				break
      		if not _found:
      			if _part == "root" and _node == _r:
      				continue
      			return null
      	return _node

      func _mcp_load_main_scene() -> void:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return
      	var _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
      	if _sp != null and _sp != "":
      		var _sr = load(_sp)
      		if _sr:
      			_r.add_child(_sr.instantiate())

      func _mcp_load_scene(sp: String) -> bool:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		_mcp_output("error", "Scene root not available")
      		return false
      	if _mcp_scene_instance != null:
      		if _mcp_scene_instance.get_parent() != null:
      			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
      		_mcp_scene_instance.queue_free()
      		_mcp_scene_instance = null
      	var _sr = load(sp)
      	if _sr == null:
      		_mcp_output("error", "Failed to load scene: " + sp)
      		return false
      	_mcp_scene_instance = _sr.instantiate()
      	_r.add_child(_mcp_scene_instance)
      	return true

      func _mcp_get_scene_node(path: String) -> Node:
      	# Search within loaded scene instance (avoids root/SceneName prefix issue)
      	if _mcp_scene_instance != null:
      		var _p: String = path
      		while _p.begins_with("/"):
      			_p = _p.substr(1)
      		# Strip leading "root/" or "root" prefix
      		if _p.begins_with("root/"):
      			_p = _p.substr(5)
      		elif _p == "root":
      			_p = ""
      		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")
      		if _p != "" and _mcp_scene_instance.name.length() > 0:
      			var _scene_name: String = _mcp_scene_instance.name + "/"
      			if _p.begins_with(_scene_name):
      				_p = _p.substr(_scene_name.length())
      			elif _p == _mcp_scene_instance.name:
      				_p = ""
      		if _p == "":
      			return _mcp_scene_instance
      		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)
      		if _node != null:
      			return _node
      	# Fallback to global search
      	return _mcp_get_node(path)

      func _mcp_output(key: String, value: Variant) -> void:
      	_mcp_outputs.append({"key": key, "value": str(value)})

      func _mcp_done() -> void:
      	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
      	if Engine.get_main_loop() == self:
      		quit(0)
      func _initialize():
      	_mcp_load_main_scene()
      	var _ap: AnimationPlayer = _mcp_get_node("/root/Main/Player")
      	if _ap == null or not (_ap is AnimationPlayer):
      		_mcp_output("error", "AnimationPlayer not found")
      		_mcp_done()
      		return
      	if not _ap.has_animation("run"):
      		_mcp_output("error", "Animation not found")
      		_mcp_done()
      		return
      	var _anim: Animation = _ap.get_animation("run")
      	if 0 < 0 or 0 >= _anim.get_track_count():
      		_mcp_output("error", "Track index out of range")
      		_mcp_done()
      		return
      	if 1 < 0 or 1 >= _anim.track_get_key_count(0):
      		_mcp_output("error", "Keyframe index out of range")
      		_mcp_done()
      		return
      	_anim.track_set_key_time(0, 1, 2)
      	var _tt: int = _anim.track_get_type(0)
      	if _tt == Animation.TYPE_ROTATION_3D:
      		_anim.track_set_key_value(0, 1, Quaternion.from_euler(Vector3(0, 0, 0)))
      	else:
      		_anim.track_set_key_value(0, 1, Vector3(0, 0, 0))
      	_anim.track_set_key_transition(0, 1, 1.5)
      	_mcp_output("result", {"updated_keyframe": 1, "track_index": 0})
      	_mcp_done()
      "
    `);
  });
  it('track add_keyframe', () => {
    expect(genAnimationKeyframeAdd(P, 'run', 0, 1.5, [1, 2, 3], undefined)).toMatchInlineSnapshot(`
      "extends SceneTree

      var _mcp_outputs: Array = []
      # Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)
      var _mcp_root: Node = null
      var _mcp_scene_instance: Node = null

      func _mcp_get_root() -> Node:
      	if _mcp_root != null:
      		return _mcp_root
      	# Godot 4.6+: self.root is required (extends SceneTree — root is native property)
      	if self.root != null:
      		_mcp_root = self.root
      		return _mcp_root
      	return null

      func _mcp_get_node(path: NodePath) -> Node:
      	var _p: String = str(path)
      	if _p.begins_with("/"):
      		_p = _p.substr(1)
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return null
      	# Fallback: root.get_node() may fail in headless _initialize()
      	var _node: Node = _r.get_node_or_null(_p)
      	if _node != null:
      		return _node
      	# Manual traversal for headless compatibility
      	var _parts: PackedStringArray = _p.split("/")
      	_node = _r
      	for _part in _parts:
      		if _part == "":
      			continue
      		var _found: bool = false
      		for _ch in _node.get_children():
      			if _ch.name == _part:
      				_node = _ch
      				_found = true
      				break
      		if not _found:
      			if _part == "root" and _node == _r:
      				continue
      			return null
      	return _node

      func _mcp_load_main_scene() -> void:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return
      	var _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
      	if _sp != null and _sp != "":
      		var _sr = load(_sp)
      		if _sr:
      			_r.add_child(_sr.instantiate())

      func _mcp_load_scene(sp: String) -> bool:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		_mcp_output("error", "Scene root not available")
      		return false
      	if _mcp_scene_instance != null:
      		if _mcp_scene_instance.get_parent() != null:
      			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
      		_mcp_scene_instance.queue_free()
      		_mcp_scene_instance = null
      	var _sr = load(sp)
      	if _sr == null:
      		_mcp_output("error", "Failed to load scene: " + sp)
      		return false
      	_mcp_scene_instance = _sr.instantiate()
      	_r.add_child(_mcp_scene_instance)
      	return true

      func _mcp_get_scene_node(path: String) -> Node:
      	# Search within loaded scene instance (avoids root/SceneName prefix issue)
      	if _mcp_scene_instance != null:
      		var _p: String = path
      		while _p.begins_with("/"):
      			_p = _p.substr(1)
      		# Strip leading "root/" or "root" prefix
      		if _p.begins_with("root/"):
      			_p = _p.substr(5)
      		elif _p == "root":
      			_p = ""
      		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")
      		if _p != "" and _mcp_scene_instance.name.length() > 0:
      			var _scene_name: String = _mcp_scene_instance.name + "/"
      			if _p.begins_with(_scene_name):
      				_p = _p.substr(_scene_name.length())
      			elif _p == _mcp_scene_instance.name:
      				_p = ""
      		if _p == "":
      			return _mcp_scene_instance
      		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)
      		if _node != null:
      			return _node
      	# Fallback to global search
      	return _mcp_get_node(path)

      func _mcp_output(key: String, value: Variant) -> void:
      	_mcp_outputs.append({"key": key, "value": str(value)})

      func _mcp_done() -> void:
      	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
      	if Engine.get_main_loop() == self:
      		quit(0)
      func _initialize():
      	_mcp_load_main_scene()
      	var _ap: AnimationPlayer = _mcp_get_node("/root/Main/Player")
      	if _ap == null or not (_ap is AnimationPlayer):
      		_mcp_output("error", "AnimationPlayer not found")
      		_mcp_done()
      		return
      	if not _ap.has_animation("run"):
      		_mcp_output("error", "Animation not found")
      		_mcp_done()
      		return
      	var _anim: Animation = _ap.get_animation("run")
      	if 0 < 0 or 0 >= _anim.get_track_count():
      		_mcp_output("error", "Track index out of range")
      		_mcp_done()
      		return
      	var _kf_idx: int = -1
      	if _anim.track_get_type(0) == Animation.TYPE_VALUE or _anim.track_get_type(0) == Animation.TYPE_BEZIER:
      		_kf_idx = _anim.track_insert_key(0, 1.5, Vector3(1, 2, 3), 1)
      	elif _anim.track_get_type(0) == Animation.TYPE_POSITION_3D:
      		_kf_idx = _anim.position_track_insert_key(0, 1.5, Vector3(1, 2, 3))
      	elif _anim.track_get_type(0) == Animation.TYPE_ROTATION_3D:
      		_kf_idx = _anim.rotation_track_insert_key(0, 1.5, Quaternion.from_euler(Vector3(1, 2, 3)))
      	elif _anim.track_get_type(0) == Animation.TYPE_SCALE_3D:
      		_kf_idx = _anim.scale_track_insert_key(0, 1.5, Vector3(1, 2, 3))
      	_mcp_output("result", {"keyframe_index": _kf_idx, "time": 1.5, "track_index": 0})
      	_mcp_done()
      "
    `);
  });
  it('track set_curve', () => {
    expect(genAnimationCurve(P, 'run', 0, 1, { x: 0, y: 0 }, { x: 1, y: 1 })).toMatchInlineSnapshot(`
      "extends SceneTree

      var _mcp_outputs: Array = []
      # Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)
      var _mcp_root: Node = null
      var _mcp_scene_instance: Node = null

      func _mcp_get_root() -> Node:
      	if _mcp_root != null:
      		return _mcp_root
      	# Godot 4.6+: self.root is required (extends SceneTree — root is native property)
      	if self.root != null:
      		_mcp_root = self.root
      		return _mcp_root
      	return null

      func _mcp_get_node(path: NodePath) -> Node:
      	var _p: String = str(path)
      	if _p.begins_with("/"):
      		_p = _p.substr(1)
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return null
      	# Fallback: root.get_node() may fail in headless _initialize()
      	var _node: Node = _r.get_node_or_null(_p)
      	if _node != null:
      		return _node
      	# Manual traversal for headless compatibility
      	var _parts: PackedStringArray = _p.split("/")
      	_node = _r
      	for _part in _parts:
      		if _part == "":
      			continue
      		var _found: bool = false
      		for _ch in _node.get_children():
      			if _ch.name == _part:
      				_node = _ch
      				_found = true
      				break
      		if not _found:
      			if _part == "root" and _node == _r:
      				continue
      			return null
      	return _node

      func _mcp_load_main_scene() -> void:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		return
      	var _sp: Variant = ProjectSettings.get_setting("application/run/main_scene")
      	if _sp != null and _sp != "":
      		var _sr = load(_sp)
      		if _sr:
      			_r.add_child(_sr.instantiate())

      func _mcp_load_scene(sp: String) -> bool:
      	var _r: Node = _mcp_get_root()
      	if _r == null:
      		_mcp_output("error", "Scene root not available")
      		return false
      	if _mcp_scene_instance != null:
      		if _mcp_scene_instance.get_parent() != null:
      			_mcp_scene_instance.get_parent().remove_child(_mcp_scene_instance)
      		_mcp_scene_instance.queue_free()
      		_mcp_scene_instance = null
      	var _sr = load(sp)
      	if _sr == null:
      		_mcp_output("error", "Failed to load scene: " + sp)
      		return false
      	_mcp_scene_instance = _sr.instantiate()
      	_r.add_child(_mcp_scene_instance)
      	return true

      func _mcp_get_scene_node(path: String) -> Node:
      	# Search within loaded scene instance (avoids root/SceneName prefix issue)
      	if _mcp_scene_instance != null:
      		var _p: String = path
      		while _p.begins_with("/"):
      			_p = _p.substr(1)
      		# Strip leading "root/" or "root" prefix
      		if _p.begins_with("root/"):
      			_p = _p.substr(5)
      		elif _p == "root":
      			_p = ""
      		# Strip scene root name if present (e.g. "Main/UILayer/..." -> "UILayer/...")
      		if _p != "" and _mcp_scene_instance.name.length() > 0:
      			var _scene_name: String = _mcp_scene_instance.name + "/"
      			if _p.begins_with(_scene_name):
      				_p = _p.substr(_scene_name.length())
      			elif _p == _mcp_scene_instance.name:
      				_p = ""
      		if _p == "":
      			return _mcp_scene_instance
      		var _node: Node = _mcp_scene_instance.get_node_or_null(_p)
      		if _node != null:
      			return _node
      	# Fallback to global search
      	return _mcp_get_node(path)

      func _mcp_output(key: String, value: Variant) -> void:
      	_mcp_outputs.append({"key": key, "value": str(value)})

      func _mcp_done() -> void:
      	print("___MCP_RESULT___" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))
      	if Engine.get_main_loop() == self:
      		quit(0)
      func _initialize():
      	_mcp_load_main_scene()
      	var _ap: AnimationPlayer = _mcp_get_node("/root/Main/Player")
      	if _ap == null or not (_ap is AnimationPlayer):
      		_mcp_output("error", "AnimationPlayer not found")
      		_mcp_done()
      		return
      	if not _ap.has_animation("run"):
      		_mcp_output("error", "Animation not found")
      		_mcp_done()
      		return
      	var _anim: Animation = _ap.get_animation("run")
      	if 0 < 0 or 0 >= _anim.get_track_count():
      		_mcp_output("error", "Track index out of range")
      		_mcp_done()
      		return
      	if 1 < 0 or 1 >= _anim.track_get_key_count(0):
      		_mcp_output("error", "Keyframe index out of range")
      		_mcp_done()
      		return
      	_anim.track_set_key_in_handle(0, 1, Vector2(0, 0))
      	_anim.track_set_key_out_handle(0, 1, Vector2(1, 1))
      	_mcp_output("result", {"track_index": 0, "keyframe_index": 1, "in_handle": Vector2(0, 0), "out_handle": Vector2(1, 1)})
      	_mcp_done()
      "
    `);
  });
});

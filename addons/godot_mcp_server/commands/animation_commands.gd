extends Node

var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

# ─── animation_track ────────────────────────────────────────────────────────

func handle_animation_track(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var player = _find_node(root, node_path)
	if player == null:
		return {"error": {"code": -32002, "message": "AnimationPlayer not found: " + node_path}}
	if not (player is AnimationPlayer):
		return {"error": {"code": -32004, "message": "Node is not an AnimationPlayer: " + node_path}}

	var anim_name: String = params.get("animation_name", "")
	var anim = player.get_animation(anim_name) if anim_name != "" else null
	if anim == null:
		return {"error": {"code": -32004, "message": "Animation not found: " + anim_name}}

	var action: String = params.get("action", "")

	match action:
		"add":
			var track_type: String = params.get("track_type", "value")
			var type_map = {
				"value": Animation.TYPE_VALUE,
				"position_3d": Animation.TYPE_POSITION_3D,
				"rotation_3d": Animation.TYPE_ROTATION_3D,
				"scale_3d": Animation.TYPE_SCALE_3D,
				"blend_shape": Animation.TYPE_BLEND_SHAPE,
				"method": Animation.TYPE_METHOD,
				"bezier": Animation.TYPE_BEZIER,
				"audio": Animation.TYPE_AUDIO,
				"animation": Animation.TYPE_ANIMATION,
			}
			if not type_map.has(track_type):
				return {"error": {"code": -32004, "message": "Invalid track_type: " + track_type}}
			var track_path: String = params.get("track_path", "")
			var idx = anim.add_track(type_map[track_type])
			if track_path != "":
				anim.track_set_path(idx, track_path)
			var insert_at = params.get("insert_at")
			if insert_at != null and int(insert_at) >= 0 and int(insert_at) < anim.get_track_count():
				anim.move_track(idx, int(insert_at))
			return {"result": {"animation": anim_name, "track_index": idx, "type": track_type, "status": "track_added"}}
		"remove":
			var track_index = params.get("track_index")
			if track_index == null:
				return {"error": {"code": -32004, "message": "track_index is required for remove"}}
			var ti = int(track_index)
			if ti < 0 or ti >= anim.get_track_count():
				return {"error": {"code": -32004, "message": "track_index out of range: " + str(ti)}}
			anim.remove_track(ti)
			return {"result": {"animation": anim_name, "track_index": ti, "status": "track_removed"}}
		_:
			return {"error": {"code": -32004, "message": "Invalid action: " + action + ". Must be: add, remove"}}

# ─── animation_keyframe ─────────────────────────────────────────────────────

func handle_animation_keyframe(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var player = _find_node(root, node_path)
	if player == null:
		return {"error": {"code": -32002, "message": "AnimationPlayer not found: " + node_path}}
	if not (player is AnimationPlayer):
		return {"error": {"code": -32004, "message": "Node is not an AnimationPlayer: " + node_path}}

	var anim_name: String = params.get("animation_name", "")
	var anim = player.get_animation(anim_name) if anim_name != "" else null
	if anim == null:
		return {"error": {"code": -32004, "message": "Animation not found: " + anim_name}}

	var track_index = params.get("track_index")
	if track_index == null:
		return {"error": {"code": -32004, "message": "track_index is required"}}
	var ti = int(track_index)
	if ti < 0 or ti >= anim.get_track_count():
		return {"error": {"code": -32004, "message": "track_index out of range: " + str(ti)}}

	var action: String = params.get("action", "")

	match action:
		"add":
			var time = params.get("time")
			if time == null:
				return {"error": {"code": -32004, "message": "time is required for add"}}
			var value = params.get("value")
			var transition = params.get("transition")
			var trans_val = float(transition) if transition != null else 1.0
			var key_idx = anim.track_insert_key(ti, float(time), value, trans_val)
			return {"result": {"animation": anim_name, "track_index": ti, "keyframe_index": key_idx, "time": float(time), "status": "keyframe_added"}}
		"remove":
			var keyframe_index = params.get("keyframe_index")
			if keyframe_index == null:
				return {"error": {"code": -32004, "message": "keyframe_index is required for remove"}}
			var ki = int(keyframe_index)
			anim.track_remove_key(ti, ki)
			return {"result": {"animation": anim_name, "track_index": ti, "keyframe_index": ki, "status": "keyframe_removed"}}
		"update":
			var keyframe_index = params.get("keyframe_index")
			if keyframe_index == null:
				return {"error": {"code": -32004, "message": "keyframe_index is required for update"}}
			var ki = int(keyframe_index)
			var value = params.get("value")
			var transition = params.get("transition")
			if value != null:
				anim.track_set_key_value(ti, ki, value)
			if transition != null:
				anim.track_set_key_transition(ti, ki, float(transition))
			var time = params.get("time")
			if time != null:
				anim.track_set_key_time(ti, ki, float(time))
			return {"result": {"animation": anim_name, "track_index": ti, "keyframe_index": ki, "status": "keyframe_updated"}}
		_:
			return {"error": {"code": -32004, "message": "Invalid action: " + action + ". Must be: add, remove, update"}}

# ─── animation_curve ────────────────────────────────────────────────────────

func handle_animation_curve(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var player = _find_node(root, node_path)
	if player == null:
		return {"error": {"code": -32002, "message": "AnimationPlayer not found: " + node_path}}
	if not (player is AnimationPlayer):
		return {"error": {"code": -32004, "message": "Node is not an AnimationPlayer: " + node_path}}

	var anim_name: String = params.get("animation_name", "")
	var anim = player.get_animation(anim_name) if anim_name != "" else null
	if anim == null:
		return {"error": {"code": -32004, "message": "Animation not found: " + anim_name}}

	var track_index = params.get("track_index")
	var keyframe_index = params.get("keyframe_index")
	if track_index == null or keyframe_index == null:
		return {"error": {"code": -32004, "message": "track_index and keyframe_index are required"}}

	var ti = int(track_index)
	var ki = int(keyframe_index)
	if ti < 0 or ti >= anim.get_track_count():
		return {"error": {"code": -32004, "message": "track_index out of range: " + str(ti)}}
	if anim.track_get_type(ti) != Animation.TYPE_BEZIER:
		return {"error": {"code": -32004, "message": "Track is not a bezier track. Curve handles only apply to bezier tracks."}}

	var updated = []

	var in_handle = params.get("in_handle")
	if in_handle != null and in_handle is Dictionary:
		var in_vec = Vector2(float(in_handle.get("x", 0.0)), float(in_handle.get("y", 0.0)))
		anim.track_set_key_in_handle(ti, ki, in_vec)
		updated.append("in_handle")

	var out_handle = params.get("out_handle")
	if out_handle != null and out_handle is Dictionary:
		var out_vec = Vector2(float(out_handle.get("x", 0.0)), float(out_handle.get("y", 0.0)))
		anim.track_set_key_out_handle(ti, ki, out_vec)
		updated.append("out_handle")

	return {"result": {"animation": anim_name, "track_index": ti, "keyframe_index": ki, "updated": updated, "status": "curve_set"}}

# ─── animation_blend ────────────────────────────────────────────────────────

func handle_animation_blend(params: Dictionary) -> Dictionary:
	var root = _get_edited_scene_root()
	if root == null:
		return {"error": {"code": -32003, "message": "No scene currently open in editor"}}

	var node_path: String = params.get("node_path", "")
	var player = _find_node(root, node_path)
	if player == null:
		return {"error": {"code": -32002, "message": "AnimationPlayer not found: " + node_path}}
	if not (player is AnimationPlayer):
		return {"error": {"code": -32004, "message": "Node is not an AnimationPlayer: " + node_path}}

	var anim_name: String = params.get("animation_name", "")
	if anim_name == "":
		return {"error": {"code": -32004, "message": "animation_name is required"}}

	var blend_time = params.get("blend_time")
	if blend_time == null:
		return {"error": {"code": -32004, "message": "blend_time is required"}}

	var speed = params.get("speed")
	var speed_val = float(speed) if speed != null else 1.0

	var ap: AnimationPlayer = player
	ap.play(anim_name, float(blend_time), speed_val, false)

	return {"result": {"animation": anim_name, "blend_time": float(blend_time), "speed": speed_val, "status": "blending"}}

# ─── Helpers ─────────────────────────────────────────────────────────────────

func _get_edited_scene_root() -> Node:
	if _plugin != null:
		var ei = _plugin.get_editor_interface()
		if ei != null:
			var edited = ei.get_edited_scene_root()
			if edited != null:
				return edited
	var ml = Engine.get_main_loop()
	if ml == null or not (ml is SceneTree):
		return null
	var st = ml as SceneTree
	if st == null or st.root == null:
		return null
	if st.root.get_child_count() > 0:
		return st.root.get_child(0)
	return null

func _find_node(root: Node, path: String) -> Node:
	if path == "" or path == "root":
		return root
	var p = path
	while p.begins_with("/"):
		p = p.substr(1)
	if p.begins_with("root/"):
		p = p.substr(5)
	if p.begins_with(root.name + "/"):
		p = p.substr(root.name.length() + 1)
	elif p == root.name:
		return root
	if p == "":
		return root
	return root.get_node_or_null(p)

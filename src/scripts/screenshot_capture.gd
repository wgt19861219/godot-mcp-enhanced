extends SceneTree

## Screenshot capture for Godot MCP Enhanced.
##
## Usage:
##   godot --path <project> --script screenshot_capture.gd <output_path> [scene_path] [max_frames] [viewport_size]
##
## Parameters (positional, after --script):
##   output_path   — absolute path for PNG output (required)
##   scene_path    — res:// path to scene (optional)
##   max_frames    — frames to wait before capture (default: 10)
##   viewport_size — WxH format, e.g. 1280x720 (default: 1280x720)
##
## Platform notes:
##   - On Windows, headless mode returns null viewport textures.
##     Use windowed mode (omit --headless) for reliable screenshots.
##   - On Linux/macOS, --headless --rendering-driver opengl3 may work.

var _output_path := ""
var _scene_path := ""
var _max_frames := 10
var _frames_left := 0


func _init() -> void:
	_parse_args()
	_frames_left = _max_frames

	if _output_path == "":
		push_error("[SCREENSHOT] Error: output_path is required")
		printerr("[SCREENSHOT] Usage: godot --path <project> --script screenshot_capture.gd <output_path> [scene] [frames] [WxH]")
		quit(1)
		return

	print("[SCREENSHOT] Output: %s" % _output_path)
	print("[SCREENSHOT] Scene: %s" % (_scene_path if _scene_path else "(default)"))
	print("[SCREENSHOT] Frames: %d" % _max_frames)

	# Use process_frame signal (reliable for SceneTree scripts)
	# Must use call_deferred for scene loading after autoloads initialize
	process_frame.connect(_on_process_frame)
	call_deferred("_deferred_load_scene")


func _parse_args() -> void:
	var args := OS.get_cmdline_args()
	var script_idx := args.find("--script")
	if script_idx == -1:
		script_idx = args.find("-s")

	if script_idx < 0:
		return

	var param_idx := script_idx + 2  # skip --script and script path

	if param_idx < args.size():
		_output_path = args[param_idx]
	if param_idx + 1 < args.size() and not args[param_idx + 1].is_valid_int():
		_scene_path = args[param_idx + 1]
		param_idx += 1
	if param_idx + 1 < args.size():
		_max_frames = int(args[param_idx + 1])
	if param_idx + 2 < args.size():
		var size_str: String = args[param_idx + 2]
		if "x" in size_str:
			var parts := size_str.split("x")
			if parts.size() == 2:
				var w := int(parts[0])
				var h := int(parts[1])
				if w > 0 and h > 0:
					DisplayServer.window_set_size(Vector2i(w, h))
					print("[SCREENSHOT] Viewport: %dx%d" % [w, h])


func _deferred_load_scene() -> void:
	if _scene_path == "":
		print("[SCREENSHOT] No scene specified, capturing default")
		return

	if not ResourceLoader.exists(_scene_path):
		push_error("[SCREENSHOT] Scene not found: %s" % _scene_path)
		quit(1)
		return

	var res = load(_scene_path)
	if res == null:
		push_error("[SCREENSHOT] Failed to load: %s" % _scene_path)
		quit(1)
		return

	var inst = res.instantiate()
	if inst == null:
		push_error("[SCREENSHOT] Failed to instantiate: %s" % _scene_path)
		quit(1)
		return

	get_root().add_child(inst)
	print("[SCREENSHOT] Scene loaded, waiting %d frames..." % _max_frames)


func _on_process_frame() -> void:
	if _frames_left <= 0:
		return
	_frames_left -= 1
	if _frames_left > 0:
		return

	# Capture screenshot
	var vp := get_root().get_viewport()
	var tex := vp.get_texture()
	var img := tex.get_image()

	if img == null:
		push_error("[SCREENSHOT] Image is null - rendering not available")
		printerr("[SCREENSHOT] Image is null. Headless mode may not support rendering on this platform.")
		printerr("[SCREENSHOT] Try running without --headless flag.")
		quit(1)
		return

	# Ensure output directory exists
	var dir := _output_path.get_base_dir()
	if dir != "" and not DirAccess.dir_exists_absolute(dir):
		DirAccess.make_dir_recursive_absolute(dir)

	var err := img.save_png(_output_path)
	if err == OK:
		var global_path := ProjectSettings.globalize_path(_output_path)
		print("[SCREENSHOT] SAVED: %s (%dx%d)" % [global_path, img.get_width(), img.get_height()])
	else:
		push_error("[SCREENSHOT] Save failed: error %d" % err)
		printerr("[SCREENSHOT] Could not save to: %s (error %d)" % [_output_path, err])

	quit(0)

extends SceneTree

## Screenshot capture for Godot MCP Enhanced.
## Usage: godot --path <project> --script screenshot_capture.gd <output_path> [scene_path] [max_frames]

var _frames := 0
var _max_frames := 10
var _output_path := ""
var _scene_path := ""

func _initialize() -> void:
	var args := OS.get_cmdline_args()
	# Find --script index, then params after it
	var script_idx := args.find("--script")
	if script_idx == -1:
		script_idx = args.find("-s")
	
	# Params are: godot ... --script <script_path> <output> [scene] [max_frames]
	if script_idx >= 0:
		var param_idx := script_idx + 2  # skip --script and script path
		if param_idx < args.size():
			_output_path = args[param_idx]
		if param_idx + 1 < args.size():
			_scene_path = args[param_idx + 1]
		if param_idx + 2 < args.size():
			_max_frames = int(args[param_idx + 2])
	
	if _output_path == "":
		printerr("[SCREENSHOT] Usage: godot --path <project> --script screenshot_capture.gd <output_path> [scene] [max_frames]")
		quit(1)
		return
	
	print("[SCREENSHOT] Output: " + _output_path)
	print("[SCREENSHOT] Scene: " + _scene_path)
	print("[SCREENSHOT] Frames: " + str(_max_frames))
	
	# Load target scene
	if _scene_path != "" and ResourceLoader.exists(_scene_path):
		var scene_res = load(_scene_path) as PackedScene
		if scene_res:
			var inst = scene_res.instantiate()
			if inst:
				get_root().add_child(inst)
				print("[SCREENSHOT] Loaded scene")
	
	print("[SCREENSHOT] Waiting " + str(_max_frames) + " frames...")

func _process(_delta: float) -> bool:
	_frames += 1
	if _frames >= _max_frames:
		var image := get_root().get_viewport().get_texture().get_image()
		if image != null:
			var err := image.save_png(_output_path)
			if err == OK:
				print("[SCREENSHOT] Saved: " + _output_path + " (" + str(image.get_width()) + "x" + str(image.get_height()) + ")")
			else:
				printerr("[SCREENSHOT] Save failed: " + str(err))
		else:
			printerr("[SCREENSHOT] Image is null - rendering may not be available")
		quit()
		return true
	return false
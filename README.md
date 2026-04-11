# Godot MCP Enhanced

Enhanced MCP server for Godot game engine — designed for **closed-loop AI-assisted development**.

Fork of [godot-mcp](https://github.com/Coding-Solo/godot-mcp) with critical gaps filled: scene reading, script R/W, screenshots, testing, **dynamic GDScript execution**, and more.

**[中文文档](README.zh.md)**

## What's New vs Original godot-mcp

| Feature | godot-mcp | godot-mcp-enhanced |
|---------|:---------:|:------------------:|
| Launch editor | Yes | Yes |
| Run project | Yes | Yes (+ auto timeout) |
| Get debug output | Yes (raw) | Yes (structured: errors/warnings/prints) |
| Stop project | Yes | Yes (+ summary) |
| Get version | Yes | Yes |
| List projects | Yes | Yes |
| Project info | Yes | Yes (+ file stats by extension) |
| Create scene | Yes | Yes |
| Add node | Yes | Yes |
| Load sprite | Yes | Yes |
| Save scene | Yes | Yes |
| **Read scene (parse .tscn)** | **No** | **Yes** |
| **Read script (.gd)** | **No** | **Yes** |
| **Write script (.gd)** | **No** | **Yes** |
| **List files (with filters)** | **No** | **Yes** |
| **Read project config** | **No** | **Yes** |
| **Capture screenshot** | **No** | **Yes** |
| **Run unit tests (GUT)** | **No** | **Yes** |
| **Execute arbitrary GDScript** | **No** | **Yes** |
| **Query scene tree (runtime)** | **No** | **Yes** |
| **Deep inspect node** | **No** | **Yes** |
| **Batch add nodes** | **No** | **Yes** |
| **Validate project** | **No** | **Yes** |
| **Import resources** | **No** | **Yes** |
| **Run & verify + scene tree** | **No** | **Yes** |
| **Edit script (line range)** | **No** | **Yes** |
| **Autoload context execution** | **No** | **Yes** |
| **Structured error analysis** | **No** | **Yes** |

## The Closed-Loop Problem

Original godot-mcp only covers the middle of the AI dev loop:

```
[AI writes code] -> ??? -> [run project] -> [see errors]
        |                                       |
        +-- can't read scene/script <-----------+
           can't see visuals
```

godot-mcp-enhanced closes the loop:

```
read_scene/read_script -> understand structure -> write_script -> run_project
-> get_debug_output/capture_screenshot -> analyze -> fix -> verify
```

And now with `execute_gdscript`, the AI can perform **any operation** that GDScript supports — from manipulating nodes to querying engine state — all through a single flexible tool.

## Installation

```bash
git clone https://github.com/wgt19861219/godot-mcp-enhanced.git
cd godot-mcp-enhanced
npm install
```

## Configuration

### Cursor

Create `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["D:/GitHub/godot-mcp-enhanced/build/index.js"],
      "env": {
        "GODOT_PATH": "C:/path/to/godot.exe",
        "DEBUG": "true"
      }
    }
  }
}
```

### Cline / Claude Code

Add to your MCP settings:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["D:/GitHub/godot-mcp-enhanced/build/index.js"],
      "env": {
        "GODOT_PATH": "C:/path/to/godot.exe",
        "DEBUG": "true"
      },
      "autoApprove": [
        "launch_editor", "run_project", "stop_project",
        "get_debug_output", "capture_screenshot", "run_tests",
        "get_godot_version", "list_projects", "get_project_info",
        "list_files", "read_project_config",
        "read_scene", "create_scene", "add_node", "save_scene", "load_sprite",
        "read_script", "write_script",
        "execute_gdscript", "query_scene_tree", "inspect_node",
        "batch_add_nodes", "validate_project", "import_resources",
        "run_and_verify", "analyze_error", "edit_script"
      ]
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GODOT_PATH` | Path to Godot executable | Auto-detected |
| `DEBUG` | Enable verbose logging | `false` |

## Tools (34 total)

### Execution

| Tool | Description |
|------|-------------|
| `launch_editor` | Open Godot editor GUI for a project |
| `run_project` | Run project in debug mode with auto-timeout |
| `stop_project` | Stop running project, return structured output |
| `get_debug_output` | Get classified debug output (errors/warnings/prints) |
| `capture_screenshot` | Capture game screenshot (headless mode) |
| `run_tests` | Run GUT unit tests and parse results |
| `get_godot_version` | Get installed Godot version |

### Verification

| Tool | Description |
|------|-------------|
| `run_and_verify` | One-click headless run with structured error/warning analysis. Supports `capture_tree` option to include scene tree snapshot. |
| `analyze_error` | Re-analyze Godot output text with fix suggestions |

### Dynamic Execution

| Tool | Description |
|------|-------------|
| `execute_gdscript` | Execute arbitrary GDScript code in headless mode. Supports snippet mode (auto-wrapped) and full class mode. Returns structured key-value results. Set `load_autoloads=true` to run with full autoload context (DataRegistry, PlayerData, etc.). |
| `query_scene_tree` | Load a scene and query its runtime node tree with resolved property values (not just static .tscn file data). |
| `inspect_node` | Deep-inspect a node: all properties, signal connections, children with recursive depth control. |

### Project

| Tool | Description |
|------|-------------|
| `list_projects` | Find Godot projects in a directory |
| `get_project_info` | Project metadata + file statistics |
| `list_files` | List files with extension/subdirectory filters |
| `read_project_config` | Parse project.godot into structured JSON |
| `validate_project` | Check for missing resources, broken script references, orphaned .import files |
| `import_resources` | Scan directories and generate .import stubs for images, audio, fonts, and 3D models |

### Scene

| Tool | Description |
|------|-------------|
| `read_scene` | Parse .tscn into node tree JSON |
| `create_scene` | Create new scene with root node |
| `add_node` | Add node to existing scene |
| `batch_add_nodes` | Add multiple nodes to a scene in one call (much faster than repeated `add_node`) |
| `save_scene` | Save scene changes |
| `load_sprite` | Load texture into sprite node |

### Script

| Tool | Description |
|------|-------------|
| `read_script` | Read .gd file with metadata |
| `write_script` | Write/overwrite .gd file |
| `edit_script` | Edit .gd file by replacing a line range. Auto-detects tab indentation and CRLF line endings. |

### API Documentation

| Tool | Description |
|------|-------------|
| `get_class_info` | Get class methods, properties, signals, constants |
| `search_classes` | Search for classes by name/description |
| `find_method` | Find method details with inheritance lookup |
| `get_inheritance` | Get full inheritance chain |

## `execute_gdscript` Details

### Snippet Mode (default)

When your code doesn't contain `extends`, it's automatically wrapped:

```gdscript
# Your input:
var scene = load("res://scenes/main.tscn")
var root = scene.instantiate()
_mcp_output("node_count", str(root.get_child_count()))
_mcp_output("root_type", root.get_class())
```

This gets wrapped into a full `extends SceneTree` script with helper functions. Use `_mcp_output(key, value)` to return structured results.

**Tips for snippet mode:**
- Use `Variant` type for variables that hold `load().new()` results to avoid "Cannot infer type" errors
- Autoloads are NOT available in snippet mode by default — use `load_autoloads=true` to enable them

### Full Class Mode

When your code contains `extends`, it's used as-is with helper injection:

```gdscript
extends SceneTree

func _initialize():
    var project = ProjectSettings.globalize_path("res://")
    _mcp_output("project_path", project)
    var screen = DisplayServer.screen_get_size(0)
    _mcp_output("screen_size", str(screen))
    quit()
```

### Autoload Context Mode

Set `load_autoloads=true` to run code with full project autoload context. This loads the project through a scene instead of a raw script, making all registered autoloads (DataRegistry, PlayerData, etc.) available:

```json
{
  "project_path": "/path/to/project",
  "code": "var data = DataRegistry.get_table(\"hero\")\n_mcp_output(\"hero_count\", str(data.size()))",
  "load_autoloads": true
}
```

**Note:** Autoload mode is slower (requires full scene initialization) but necessary when your code depends on autoload singletons.

### Response Format

```json
{
  "success": true,
  "compile_success": true,
  "compile_error": "",
  "errors": [
    {
      "type": "script_error",
      "file": "res://scripts/player.gd",
      "line": 42,
      "message": "Invalid access to property or key...",
      "suggestion": "Check if the node exists before accessing..."
    }
  ],
  "run_success": true,
  "run_error": "",
  "outputs": [
    { "key": "node_count", "value": "5" },
    { "key": "root_type", "value": "Node2D" }
  ],
  "raw_output": "",
  "duration_ms": 1250
}
```

The `errors` array contains structured error objects with type, file, line, message, and fix suggestions — parsed from Godot's output by the error analyzer.

## New Tools in v0.3.0

### `edit_script`

Edit an existing GDScript file by replacing a line range. Automatically detects and preserves the original tab indentation and CRLF/LF line endings:

```json
{
  "script_path": "scripts/player.gd",
  "start_line": 10,
  "end_line": 12,
  "new_content": "func get_health() -> int:\n\treturn hp"
}
```

This is safer than `write_script` for incremental edits — only the specified lines are changed, preserving the rest of the file.

### `batch_add_nodes`

Add multiple nodes in one headless Godot invocation, avoiding per-node startup overhead:

```json
{
  "project_path": "/path/to/project",
  "scene_path": "scenes/main.tscn",
  "nodes": [
    { "node_type": "Label", "node_name": "Title", "properties": { "text": "Hello" } },
    { "node_type": "Button", "node_name": "StartBtn", "parent_node_path": "root/UI" },
    { "node_type": "Sprite2D", "node_name": "PlayerIcon" }
  ]
}
```

### `validate_project`

Static analysis of your Godot project for common issues:

- Missing `ext_resource` file references in `.tscn` files
- Broken `preload()` and `load()` paths in `.gd` scripts
- Orphaned `.import` files (source asset deleted)

Returns structured report with severity levels: `critical`, `error`, `warning`, `info`.

### `import_resources`

Bulk-register assets with the Godot project by generating `.import` stub files:

```json
{
  "project_path": "/path/to/project",
  "directory": "assets/ui",
  "extensions": [".png", ".jpg", ".mp3"],
  "recursive": true
}
```

Supports: `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`, `.mp3`, `.ogg`, `.wav`, `.ttf`, `.otf`, `.glb`, `.gltf`.

## Closed-Loop Workflow Example

```
1. AI: read_scene("scenes/player.tscn")
   -> Gets full node tree, understands structure

2. AI: read_script("scripts/player_controller.gd")
   -> Reads current code, identifies what to change

3. AI: write_script("scripts/player_controller.gd", updated_code)
   -> Writes the fix

4. AI: run_and_verify(project, capture_tree=true)
   -> Headless run with error analysis + scene tree snapshot

5. AI: validate_project(project)
   -> Check for missing resources, broken references

6. AI: batch_add_nodes(project, scene, nodes=[...])
   -> Add multiple UI elements in one call

7. AI: import_resources(project, directory="assets/ui")
   -> Register new assets with the project

8. If errors remain -> go back to step 2
```

## Requirements

- Godot Engine 4.x (tested with 4.5+)
- Node.js >= 18
- GUT addon (for `run_tests` tool)

## License

MIT

# Godot MCP Enhanced

Enhanced MCP server for Godot game engine — designed for **closed-loop AI-assisted development**.

Fork of [godot-mcp](https://github.com/Coding-Solo/godot-mcp) with critical gaps filled: scene reading, script R/W, screenshots, testing, and structured output.

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

### Cline

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
        "read_script", "write_script"
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

## Tools (18 total)

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

### Project

| Tool | Description |
|------|-------------|
| `list_projects` | Find Godot projects in a directory |
| `get_project_info` | Project metadata + file statistics |
| `list_files` | List files with extension/subdirectory filters |
| `read_project_config` | Parse project.godot into structured JSON |

### Scene

| Tool | Description |
|------|-------------|
| `read_scene` | Parse .tscn into node tree JSON |
| `create_scene` | Create new scene with root node |
| `add_node` | Add node to existing scene |
| `save_scene` | Save scene changes |
| `load_sprite` | Load texture into sprite node |

### Script

| Tool | Description |
|------|-------------|
| `read_script` | Read .gd file with metadata |
| `write_script` | Write/overwrite .gd file |

## Closed-Loop Workflow Example

```
1. AI: read_scene("scenes/player.tscn")
   -> Gets full node tree, understands structure

2. AI: read_script("scripts/player_controller.gd")
   -> Reads current code, identifies what to change

3. AI: write_script("scripts/player_controller.gd", updated_code)
   -> Writes the fix

4. AI: run_project(project, timeout=10)
   -> Launches game

5. AI: get_debug_output()
   -> Checks for errors

6. AI: capture_screenshot(project, scene="scenes/level1.tscn")
   -> Verifies visuals (headless)

7. AI: stop_project()
   -> Gets full summary, checks if issues resolved

8. If errors remain -> go back to step 2
```

## Requirements

- Godot Engine 4.x (tested with 4.5)
- Node.js >= 18
- GUT addon (for `run_tests` tool)

## License

MIT

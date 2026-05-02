import { isAbsolute, resolve, join, extname } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { captureScreenshot } from '../screenshot.js';
import { validatePath, resolveWithinRoot, normalizeUserProjectPath, allowOutsideProjectPaths } from '../helpers.js';

const TOOL_NAMES = ['capture_screenshot', 'analyze_screenshot'] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'capture_screenshot',
      description: 'Capture a screenshot of a Godot project scene (experimental). Uses headless mode with opengl3 driver. Falls back gracefully if rendering is not available.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scene: { type: 'string', description: 'Scene file path relative to project (res://scenes/main.tscn). If omitted, captures the default scene or an empty viewport.' },
          output_path: { type: 'string', description: 'Output PNG path (absolute). Defaults to <project_path>/screenshot.png' },
          frame_delay: { type: 'number', description: 'Frames to wait before capture (default: 15)', default: 15 },
          viewport_width: { type: 'number', description: 'Viewport width in pixels (default: 1280)', default: 1280 },
          viewport_height: { type: 'number', description: 'Viewport height in pixels (default: 720)', default: 720 },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'analyze_screenshot',
      description: 'Return a screenshot as a base64 image for AI visual analysis. The AI can then describe what it sees, identify UI elements, spot bugs, etc. Works with any image file (PNG, JPG).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          image_path: { type: 'string', description: 'Absolute path to the image file (PNG or JPG)' },
          project_path: { type: 'string', description: 'Project path - if provided, image_path is resolved relative to the project directory' },
          question: { type: 'string', description: 'Question for the AI to answer about the image. Default: "Describe what you see in this game screenshot."', default: 'Describe what you see in this game screenshot. Focus on: UI elements, character positions, any visual issues or bugs.' },
        },
        required: [],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  switch (name) {
    case 'capture_screenshot': {
      const projectPath = validatePath(args.project_path as string);
      const scene = args.scene as string | undefined;
      const outputPathRaw = args.output_path as string | undefined;
      const outputPath = outputPathRaw
        ? (allowOutsideProjectPaths()
            ? validatePath(outputPathRaw)
            : resolveWithinRoot(projectPath, normalizeUserProjectPath(outputPathRaw)))
        : join(projectPath, 'screenshot.png');
      const frameDelay = (args.frame_delay as number) || 15;
      const viewportW = (args.viewport_width as number) || 1280;
      const viewportH = (args.viewport_height as number) || 720;
      const godot = await ctx.findGodot();

      const result = await captureScreenshot({
        godotPath: godot,
        projectPath,
        scene,
        outputPath,
        frameDelay,
        viewportSize: { width: viewportW, height: viewportH },
        timeout: 30,
      });

      if (result.success) {
        return textResult(
          `Screenshot saved to: ${result.imagePath}\n` +
          `File size: ${result.fileSize} bytes\n` +
          `Viewport: ${viewportW}x${viewportH}\n` +
          `Frames waited: ${frameDelay}\n\n` +
          'Use analyze_screenshot to have the AI examine this image.'
        );
      } else {
        return textResult(
          `Screenshot failed: ${result.error}\n\n` +
          (result.godotOutput ? `Godot output:\n${result.godotOutput}\n\n` : '') +
          'Note: Screenshot capture is experimental. Headless rendering may not be available on all systems.'
        );
      }
    }

    case 'analyze_screenshot': {
      let imagePath = args.image_path as string | undefined;
      const projectPathRaw = args.project_path as string | undefined;
      const projectPath = projectPathRaw ? validatePath(projectPathRaw) : undefined;
      const question = (args.question as string) ||
        'Describe what you see in this game screenshot. Focus on: UI elements, character positions, any visual issues or bugs.';

      if (imagePath) {
        if (allowOutsideProjectPaths()) {
          if (!isAbsolute(imagePath) && projectPath) {
            imagePath = resolve(projectPath, normalizeUserProjectPath(imagePath));
          }
          imagePath = validatePath(imagePath);
        } else {
          if (!projectPath) {
            return textResult('Error: project_path is required when ALLOW_OUTSIDE_PROJECT_PATHS is not set.');
          }
          imagePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(imagePath));
        }
      } else if (projectPath) {
        imagePath = join(projectPath, 'screenshot.png');
      } else {
        return textResult('Error: either image_path or project_path is required.');
      }

      if (!existsSync(imagePath)) {
        return textResult(`Image not found: ${imagePath}`);
      }

      const imageBuffer = readFileSync(imagePath);
      const base64 = imageBuffer.toString('base64');
      const ext = extname(imagePath).toLowerCase();
      const mimeType = (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';

      return {
        content: [
          {
            type: 'image' as const,
            data: base64,
            mimeType,
          },
          {
            type: 'text' as const,
            text: question,
          },
        ],
      };
    }

    default:
      return null;
  }
}

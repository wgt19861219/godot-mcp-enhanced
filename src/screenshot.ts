/**
 * Screenshot capture module for Godot MCP Enhanced.
 *
 * Strategy: Run Godot with --headless --rendering-driver opengl3 so that
 * the engine renders to an offscreen buffer and we can grab the viewport
 * texture.  If opengl3 is unavailable in headless mode the screenshot will
 * be empty – the tool reports this gracefully and marks the result as
 * experimental.
 */

import { spawn } from 'child_process';
import { existsSync, statSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface ScreenshotResult {
  success: boolean;
  imagePath?: string;
  fileSize?: number;
  error?: string;
  godotOutput?: string;
}

export interface ScreenshotOptions {
  godotPath: string;
  projectPath: string;
  scene?: string;          // res://scenes/main.tscn
  outputPath: string;      // absolute path for PNG
  frameDelay?: number;     // frames to wait (default 10)
  viewportSize?: { width: number; height: number }; // default 1280x720
  timeout?: number;        // seconds (default 30)
}

/** Path to the bundled GDScript that captures screenshots. */
function getScriptPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    'scripts',
    'screenshot_capture.gd'
  );
}

/**
 * Capture a screenshot of a Godot project scene.
 *
 * Runs a non-interactive Godot instance with the screenshot_capture.gd
 * script.  The script loads the target scene (if provided), waits for
 * the requested number of frames, then grabs the viewport texture and
 * saves it as PNG.
 */
export async function captureScreenshot(
  options: ScreenshotOptions
): Promise<ScreenshotResult> {
  const {
    godotPath,
    projectPath,
    scene = '',
    outputPath,
    frameDelay = 10,
    viewportSize = { width: 1280, height: 720 },
    timeout = 30,
  } = options;

  // Ensure output directory exists
  if (!existsSync(dirname(outputPath))) {
    mkdirSync(dirname(outputPath), { recursive: true });
  }

  const scriptPath = getScriptPath();
  if (!existsSync(scriptPath)) {
    return {
      success: false,
      error: `Screenshot script not found at ${scriptPath}`,
    };
  }

  // Build Godot arguments
  const args: string[] = [
    '--headless',
    '--rendering-driver', 'opengl3',
    '--path', projectPath,
    '--script', scriptPath,
  ];

  // Pass parameters as positional args after script path
  args.push(outputPath);
  if (scene) args.push(scene);
  args.push(String(frameDelay));


  return new Promise<ScreenshotResult>((resolve) => {
    let out = '';
    const proc = spawn(godotPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

    const timer = setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        resolve({
          success: false,
          error: `Screenshot timed out after ${timeout}s`,
          godotOutput: out,
        });
      }
    }, timeout * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        resolve({
          success: false,
          error: `Godot exited with code ${code}`,
          godotOutput: out,
        });
        return;
      }

      if (existsSync(outputPath)) {
        const stat = statSync(outputPath);
        resolve({
          success: true,
          imagePath: outputPath,
          fileSize: stat.size,
          godotOutput: out,
        });
      } else {
        resolve({
          success: false,
          error: 'Screenshot command completed but output file not found. '
            + 'This may indicate headless rendering is not supported on this system. '
            + 'The feature is experimental – try running without --headless.',
          godotOutput: out,
        });
      }
    });
  });
}

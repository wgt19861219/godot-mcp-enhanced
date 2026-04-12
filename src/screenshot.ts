/**
 * Screenshot capture module for Godot MCP Enhanced.
 *
 * Strategy: Run Godot in windowed mode so that the engine renders with a real
 * GPU context and we can grab the viewport texture.  On Windows, headless mode
 * uses a dummy rendering server that returns null textures, so windowed mode
 * is the only reliable option.
 *
 * Platform logic:
 *   - Windows: always windowed (headless rendering is not supported)
 *   - Linux/macOS: try headless first (opengl3), fall back to windowed
 *
 * The bundled GDScript (screenshot_capture.gd) uses the process_frame signal
 * and call_deferred() to reliably load scenes and capture frames.
 */

import { spawn } from 'child_process';
import { existsSync, statSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as os from 'os';

export interface ScreenshotResult {
  success: boolean;
  imagePath?: string;
  fileSize?: number;
  width?: number;
  height?: number;
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
  headless?: boolean;      // force headless mode (default: auto-detect)
}

/** Path to the bundled GDScript that captures screenshots. */
function getScriptPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    'scripts',
    'screenshot_capture.gd'
  );
}

/** Check if headless rendering is likely to work on this platform. */
function shouldUseHeadless(forceHeadless?: boolean): boolean {
  if (forceHeadless !== undefined) return forceHeadless;
  // On Windows, headless mode uses a dummy renderer that returns null textures.
  // On Linux/macOS, headless + opengl3 may work depending on GPU drivers.
  return process.platform !== 'win32';
}

/**
 * Run Godot with the screenshot script and capture output.
 */
function runScreenshot(
  godotPath: string,
  args: string[],
  timeout: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
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
        resolve({ code: -1, output: out + `\n[TIMEOUT] Killed after ${timeout}s` });
      }
    }, timeout * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out });
    });
  });
}

/**
 * Parse image dimensions from Godot output log.
 */
function parseDimensions(output: string): { width: number; height: number } | null {
  const match = output.match(/\((\d+)x(\d+)\)/);
  if (match) {
    return { width: parseInt(match[1]), height: parseInt(match[2]) };
  }
  return null;
}

/**
 * Capture a screenshot of a Godot project scene.
 *
 * Runs a Godot instance with the screenshot_capture.gd script.  The script
 * loads the target scene (if provided), waits for the requested number of
 * frames, then grabs the viewport texture and saves it as PNG.
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

  const useHeadless = shouldUseHeadless(options.headless);

  // Build Godot arguments
  const args: string[] = [
    '--path', projectPath,
    '--script', scriptPath,
  ];

  // Headless mode: add rendering flags
  if (useHeadless) {
    args.unshift('--headless', '--rendering-driver', 'opengl3');
  }

  // Pass parameters as positional args after script path
  args.push(outputPath);
  if (scene) args.push(scene);
  args.push(String(frameDelay));
  args.push(`${viewportSize.width}x${viewportSize.height}`);

  // --- Attempt 1: primary mode (windowed or headless based on platform) ---
  const result1 = await runScreenshot(godotPath, args, timeout);

  // Check if screenshot was created
  if (existsSync(outputPath)) {
    const stat = statSync(outputPath);
    const dims = parseDimensions(result1.output);
    return {
      success: true,
      imagePath: outputPath,
      fileSize: stat.size,
      width: dims?.width,
      height: dims?.height,
      godotOutput: result1.output,
    };
  }

  // --- Attempt 2: if headless failed, try windowed (and vice versa) ---
  if (useHeadless && !options.headless) {
    // Headless failed — try windowed
    const windowedArgs = args.filter(a =>
      a !== '--headless' && a !== '--rendering-driver' && a !== 'opengl3'
    );
    const result2 = await runScreenshot(godotPath, windowedArgs, timeout);

    if (existsSync(outputPath)) {
      const stat = statSync(outputPath);
      const dims = parseDimensions(result2.output);
      return {
        success: true,
        imagePath: outputPath,
        fileSize: stat.size,
        width: dims?.width,
        height: dims?.height,
        godotOutput: result2.output,
      };
    }
  }

  // Both attempts failed
  const mode = useHeadless ? 'headless' : 'windowed';
  const imageNullHint = result1.output.includes('null')
    ? '\nHint: viewport texture returned null — headless rendering is not supported on this system.'
    : '';

  return {
    success: false,
    error: `Screenshot failed (${mode} mode). Godot exited with code ${result1.code}.${imageNullHint}`,
    godotOutput: result1.output,
  };
}

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
 * P4 SubViewport verdict (2026-06-06): SubViewport does NOT work in headless
 * mode. The dummy renderer's texture_storage returns null textures. Verified on
 * Godot 4.6.3 Windows headless. Fallback: improved BLANK_DETECTED hints.
 *
 * The bundled GDScript (screenshot_capture.gd) uses the process_frame signal
 * and call_deferred() to reliably load scenes and capture frames.
 */

import { spawn } from 'child_process';
import { existsSync, statSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { forceKillTree } from './core/process-state.js';
import { buildSafeEnv } from './core/godot-finder.js';

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
  waitNode?: string;       // 等待该节点(名或 /root/... 路径)出现在场景树再截图
  waitText?: string;       // 等待任一 Label/RichTextLabel 文本包含该子串再截图
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
    // H-05: Use Buffer[] to avoid O(n²) string concatenation
    const chunks: Buffer[] = [];
    const proc = spawn(godotPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeEnv(),
    });

    proc.stdout?.on('data', (d: Buffer) => { chunks.push(d); });
    proc.stderr?.on('data', (d: Buffer) => { chunks.push(d); });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled && !proc.killed) {
        settled = true;
        forceKillTree(proc);
        const out = Buffer.concat(chunks).toString('utf-8');
        resolve({ code: -1, output: out + `\n[TIMEOUT] Killed after ${timeout}s` });
      }
    }, timeout * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, output: Buffer.concat(chunks).toString('utf-8') });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code: -1, output: `Spawn error: ${err.message}` });
    });
  });
}

/**
 * Parse image dimensions from Godot output log.
 */
function parseDimensions(output: string): { width: number; height: number } | null {
  const match = output.match(/\((\d+)x(\d+)\)/);
  if (match) {
    return { width: parseInt(match[1]!), height: parseInt(match[2]!) };
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
    frameDelay = 15,
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
  // I-09: 记录 frame delay 的精确索引，不依赖 args.length - 2 硬编码
  const frameDelayIdx = args.length;
  args.push(String(frameDelay));
  args.push(`${viewportSize.width}x${viewportSize.height}`);
  // 条件等待(命名参数,置于位置参数之后,不影响 GDScript 位置解析)
  if (options.waitNode) args.push('--wait-node', options.waitNode);
  if (options.waitText) args.push('--wait-text', options.waitText);

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

  // --- Retry: if primary mode failed but process succeeded, retry with doubled frame delay ---
  if (!existsSync(outputPath) && result1.code === 0) {
    const retryArgs = [...args];
    // I-09: 使用构建时记录的精确索引，替代脆弱的 args.length - 2
    if (frameDelayIdx < retryArgs.length) {
      retryArgs[frameDelayIdx] = String(frameDelay * 2);
    }
    const retryResult = await runScreenshot(godotPath, retryArgs, timeout);
    if (existsSync(outputPath)) {
      const stat = statSync(outputPath);
      const dims = parseDimensions(retryResult.output);
      return {
        success: true,
        imagePath: outputPath,
        fileSize: stat.size,
        width: dims?.width,
        height: dims?.height,
        godotOutput: retryResult.output,
      };
    }
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

/**
 * Check if a screenshot result contains a BLANK_DETECTED warning.
 * Returns the hint text if blank detected, empty string otherwise.
 */
export function getBlankHint(godotOutput: string): string {
  if (!godotOutput.includes('BLANK_DETECTED')) return '';
  return '2D CanvasItem content cannot render in headless mode. '
    + 'Alternatives: (1) Game Bridge take_screenshot with running game, '
    + '(2) Editor mode screenshot, '
    + '(3) Provide a screenshot and use screenshot analyze.';
}

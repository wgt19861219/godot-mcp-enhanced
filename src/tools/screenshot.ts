import { isAbsolute, resolve, join, extname, basename } from 'path';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { PNG } from 'pngjs';
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { textResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import { captureScreenshot } from '../screenshot.js';
import { parseDetailLevel, downsampleToThumbnail, downsampleToAscii, diffPngBuffers } from './screenshot-detail.js';
import { validatePath, requireProjectPath, resolveWithinRoot, normalizeUserProjectPath, allowOutsideProjectPaths, isPathInAllowedRoots, describeAllowedRoots } from '../helpers.js';
import { PathError } from '../core/tool-errors.js';
import { routeImage } from '../core/vision-router.js';

/** 反馈 2026-08-19 (CardGame2): 白名单外路径曾 throw 原生 Error → classifyError 兜底成
 *  笼统 'Internal error'(INTERNAL),无任何白名单提示,误导排查方向(误判工具坏了转投外部视觉模型,
 *  绕过成本 >10min)。修:改抛 PathError(结构化 PATH_NOT_ALLOWED,safeMessage 外传)+
 *  附允许根列表与修复指引。回显 basename 对齐 P2-17(不回显 resolve 后绝对路径)先例。 */
function throwPathNotAllowed(kind: string, p: string): never {
  // 审查 NIT-2→I-E: roots 提示必须与 isPathInAllowedRoots 判定同源——NIT-2 曾在本地复刻
  // 分支逻辑,残余漂移(realpath 失败条目判定侧跳过/提示侧列出)。改调 path-utils 的
  // describeAllowedRoots()(与判定同一归一化链),彻底消除两处再漂移的结构性可能。
  throw new PathError(
    `${kind} is outside allowed project roots: ${basename(p)}. Allowed roots: ${describeAllowedRoots()}. ` +
    'Fix: move the file under an allowed root, or extend ALLOWED_PROJECT_PATHS (semicolon-separated).');
}

const TOOL_NAMES = ['screenshot'] as const;

export { TOOL_NAMES };

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'screenshot',
      description: '截图与分析中转。capture: headless 截取场景截图(实验性)。analyze: 把图片以 MCP image 内容(base64)返回给客户端视觉能力查验——返回图像数据,非文字描述。diff: 像素级双图对比。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）' },
          action: {
            type: 'string',
            enum: ['capture', 'analyze', 'diff'],
            description: '操作类型。capture=截图, analyze=AI 视觉分析, diff=像素级双图对比',
          },
          // capture params
          scene: { type: 'string', description: 'capture: 场景文件路径(相对项目,如 res://scenes/main.tscn)。省略时截取默认场景或空视口。' },
          output_path: { type: 'string', description: 'capture: 输出 PNG 绝对路径,默认 <project_path>/screenshot.png' },
          frame_delay: { type: 'number', description: 'capture: 截图前等待帧数(默认 15)', default: 15 },
          viewport_width: { type: 'number', description: 'capture: 视口宽度像素(默认 1280)', default: 1280 },
          viewport_height: { type: 'number', description: 'capture: 视口高度像素(默认 720)', default: 720 },
          wait_node: { type: 'string', description: 'capture: 等待该节点(名或 /root/... 路径)出现在场景树再截图。对分帧构建/异步初始化场景,优先于 frame_delay 生效;超时(固定 300 帧≈5s@60fps,独立于 max_frames)后放弃等待直接截图' },
          wait_text: { type: 'string', description: 'capture: 等待任一 Label/RichTextLabel 的 text 包含该子串再截图;超时同 wait_node(固定 300 帧≈5s@60fps,独立于 max_frames)' },
          // analyze params
          image_path: { type: 'string', description: 'analyze: 图片文件绝对路径(PNG/JPG)' },
          question: { type: 'string', description: 'analyze: 要求视觉模型回答的问题。default 为英文提问(聚焦 UI 元素/角色位置/视觉问题),可自定义中文。', default: 'Describe what you see in this game screenshot. Focus on: UI elements, character positions, any visual issues or bugs.' },
          // Phase 2: Vision Routing(纯文本模型用,调视觉模型把图片翻译成文字描述)
          vision_route: {
            type: 'boolean',
            description: 'Phase 2 Vision Routing:开启时调视觉模型(groq)把图片翻译成文字描述,返回纯文本(不含 image block),让纯文本模型(DeepSeek 等)也能"看懂"截图。失败时 fallback 到 detail 分层 + 追加 note。需 GODOT_MCP_VISION_KEY 环境变量。',
            default: false,
          },
          vision_question: {
            type: 'string',
            description: 'vision_route=true 时传给视觉模型的上下文(可选,如"我在调试 Player 走路动画")。',
          },
          // P1-5 视觉成本层级:full(完整 base64)/ thumbnail(缩略图)/ ascii(ASCII art 文本)
          detail: {
            type: 'string',
            enum: ['full', 'thumbnail', 'ascii'],
            description: 'P1-5 视觉成本层级:full(完整 base64 图像,高 token) / thumbnail(缩放至 thumbnail_width 的 PNG,中 token) / ascii(ASCII art 文本,低 token)。默认 full。',
            default: 'full',
          },
          thumbnail_width: { type: 'number', description: 'detail=thumbnail: 目标宽度像素(默认 256,保持纵横比)', default: 256 },
          ascii_cols: { type: 'number', description: 'detail=ascii: 字符列数(默认 80)', default: 80 },
          ascii_rows: { type: 'number', description: 'detail=ascii: 字符行数(默认 40)', default: 40 },
          // Task 4: diff params(像素级双图对比,零 Godot 依赖,纯 TS)
          image_a: { type: 'string', description: 'diff: 基准图(a 图)路径。相对路径需 project_path;两图尺寸必须一致。' },
          image_b: { type: 'string', description: 'diff: 对比图(b 图)路径。路径策略同 analyze 的 image_path(白名单校验)。' },
          threshold: {
            type: 'number',
            description: 'diff: per-pixel 归一化欧氏距离阈值 sqrt(Δr²+Δg²+Δb²)/(√3×255),0-1,默认 0.12。恰好等于阈值不计差(严格大于才计)。忽略 alpha 只比 RGB。',
            default: 0.12,
          },
          diff_path: { type: 'string', description: 'diff: 可选,差异图输出路径。差异像素染纯红 (255,0,0),其余保留 a 图原色。不提供则不写文件。' },
          godot_path: { type: 'string', description: '覆盖 Godot 二进制路径（可选，优先于项目配置和环境变量）' },
        },
        required: ['action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'screenshot') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', '"action" is required (capture, analyze or diff).');

  switch (action) {
    case 'capture': {
      const projectPath = requireProjectPath(args);
      const scene = args.scene as string | undefined;
      const outputPathRaw = args.output_path as string | undefined;
      const normalizedOutput = normalizeUserProjectPath(outputPathRaw ?? '');
      const outputPath = outputPathRaw?.trim()
        ? (allowOutsideProjectPaths()
            ? (() => {
                const p = validatePath(outputPathRaw);
                if (!isPathInAllowedRoots(p)) {
                  throwPathNotAllowed('Output path', p);
                }
                return p;
              })()
            : resolveWithinRoot(projectPath, normalizedOutput))
        : join(projectPath, 'screenshot.png');
      const frameDelay = (args.frame_delay as number) || 15;
      const viewportW = (args.viewport_width as number) || 1280;
      const viewportH = (args.viewport_height as number) || 720;
      const waitNode = (args.wait_node as string | undefined)?.trim() || undefined;
      const waitText = (args.wait_text as string | undefined)?.trim() || undefined;
      const godot = await ctx.findGodot();

      const result = await captureScreenshot({
        godotPath: godot,
        projectPath,
        scene,
        outputPath,
        frameDelay,
        viewportSize: { width: viewportW, height: viewportH },
        timeout: 30,
        waitNode,
        waitText,
      });

      if (result.success) {
        // 双层空白检测：GDScript BLANK_DETECTED + TS 侧 fileSize 阈值
        let blankWarning = '';

        if (result.godotOutput?.includes('BLANK_DETECTED')) {
          blankWarning = '\n⚠ Screenshot may be blank (headless RendererDummy 无 GPU 渲染，2D/3D 均空白).\n' +
            '替代：① Bridge take_screenshot（游戏运行时 GPU viewport，2D/3D 均可）② editor/GUI 模式截图 ③ 手动 F5 运行后截图 ④ screenshot(action=analyze) 分析本地文件';
        } else if ((result.fileSize ?? 0) < 2048) {
          // 小文件（< 2KB）疑似空白，补充警告
          blankWarning = `\n⚠ Screenshot file is unusually small (${result.fileSize} bytes), possibly blank (headless RendererDummy 无 GPU 渲染，2D/3D 均空白).\n` +
            '替代：① Bridge take_screenshot（游戏运行时 GPU viewport，2D/3D 均可）② editor/GUI 模式截图 ③ 手动 F5 运行后截图 ④ screenshot(action=analyze) 分析本地文件';
        }

        return {
          ...textResult(
            `Screenshot saved to: ${result.imagePath}\n` +
            `File size: ${result.fileSize} bytes\n` +
            `Viewport: ${viewportW}x${viewportH}\n` +
            `Frames waited: ${frameDelay}` +
            blankWarning +
            '\n\nUse screenshot with action=analyze to have the AI examine this image.'
          ),
          // Tier1-1: 成功路径补 structuredContent,让 AI 无需正则解析文本即可拿元信息
          structuredContent: {
            action: 'screenshot_capture',
            image_path: result.imagePath,
            file_size: result.fileSize,
            viewport_width: viewportW,
            viewport_height: viewportH,
            frames_waited: frameDelay,
            ...(blankWarning !== '' && { blank_warning: true }),
          },
        };
      } else {
        return textResult(
          `Screenshot failed: ${result.error}\n\n` +
          (result.godotOutput ? `Godot output:\n${result.godotOutput}\n\n` : '') +
          'Note: Screenshot capture is experimental. Headless rendering may not be available on all systems.'
        );
      }
    }

    case 'analyze': {
      let imagePath = args.image_path as string | undefined;
      const projectPathRaw = typeof args.project_path === 'string' ? args.project_path : undefined;
      const projectPath = projectPathRaw?.trim() ? validatePath(projectPathRaw) : undefined;
      // #1 path-leak: projectPath 提供时校验 isPathInAllowedRoots（对齐 capture :60 requireProjectPath）。
      // analyze projectPath 可选（仅 image_path 时缺），不能直接换 requireProjectPath（强制必填）。
      if (projectPath && !isPathInAllowedRoots(projectPath)) {
        throwPathNotAllowed('project_path', projectPath);
      }
      const questionRaw = (args.question as string) ||
        'Describe what you see in this game screenshot. Focus on: UI elements, character positions, any visual issues or bugs.';

      if (imagePath) {
        if (allowOutsideProjectPaths()) {
          if (!isAbsolute(imagePath) && projectPath) {
            imagePath = resolve(projectPath, normalizeUserProjectPath(imagePath));
          }
          imagePath = validatePath(imagePath);
          // #2 path-leak: allowOutside 分支补 isPathInAllowedRoots（对齐 capture :68 守卫）。
          // validatePath 只 resolve 不校验 root，allowOutside 模式可读 ALLOWED_PROJECT_PATHS 外任意绝对路径。
          if (!isPathInAllowedRoots(imagePath)) {
            throwPathNotAllowed('Image path', imagePath);
          }
        } else {
          if (!projectPath) {
            return opsErrorResult('INVALID_PARAMS', 'project_path is required to resolve image_path (or set GODOT_MCP_UNRESTRICTED=true / ALLOWED_PROJECT_PATHS to allow arbitrary paths).');
          }
          imagePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(imagePath));
        }
      } else if (projectPath) {
        imagePath = join(projectPath, 'screenshot.png');
      } else {
        return opsErrorResult('INVALID_PARAMS', 'either image_path or project_path is required.');
      }

      if (!existsSync(imagePath)) {
        // P2-17(2026-08-21 七维度审核): 不回显 resolve 后的绝对路径
        return textResult(`Image not found: ${basename(imagePath)}`);
      }

      // I-02: Prevent OOM from reading huge image files (10 MB limit)
      const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
      const fileSize = statSync(imagePath).size;
      if (fileSize > MAX_IMAGE_SIZE) {
        return textResult(
          `Image file too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB. ` +
          `Maximum allowed: 10 MB.`,
        );
      }

      const imageBuffer = readFileSync(imagePath);
      const ext = extname(imagePath).toLowerCase();
      const isPng = ext !== '.jpg' && ext !== '.jpeg';

      // ── Phase 2: Vision Routing(显式开启时调视觉模型翻译图片→文字)─────────
      // 纯文本模型(DeepSeek 等)无法处理 image content,vision_route=true 时
      // 在 TS 侧调 groq 视觉模型把图片翻译成文字描述,返回纯 TextContent(丢弃 image block 省 token)。
      // 失败时 fallback 到下方现有 detail 分层 + 追加 note,工具链不破。
      // 对标 godot-ai vision_routing.gd,但因架构不同(TS 侧读文件 vs GD addon 实时截图)
      // 本实现不需要 worker 线程/deferred/加密存储,更简单。
      if (args.vision_route === true) {
        const visionKey = process.env.GODOT_MCP_VISION_KEY;
        if (!visionKey) {
          // 无 key → fallback 到 detail 分层 + note(不阻断)
          const fallbackNote = '⚠ Vision routing unavailable: set GODOT_MCP_VISION_KEY environment variable. Falling back to detail=' + (args.detail ?? 'full') + '.';
          // 继续走 detail 分层,在结果末尾追加 note(下方 detail 分层后的 return 会处理)
          // 用标记字段让下方 detail 分层知道要追加 note
          (args as Record<string, unknown>)._visionFallbackNote = fallbackNote;
        } else {
          // 图片预处理:缩放到最长边 1024px(减少 API 成本,对标 godot-ai _downscale_image_if_needed)
          let routeBase64: string | undefined;
          let routeMime: 'image/png' | 'image/jpeg' = 'image/png';
          if (isPng) {
            const thumb = downsampleToThumbnail(imageBuffer, 1024);
            routeBase64 = thumb.base64;
            routeMime = thumb.mimeType as 'image/png' | 'image/jpeg';
          } else {
            // F-4: JPEG 无法用 downsampleToThumbnail(仅支持 PNG 解码)。原实现直发全量 base64,
            // 大 JPEG(~10MB→~13MB base64)可能触发 API 413 且与"减少 API 成本"目标矛盾。
            // 加大小阈值:超 1MB 的 JPEG fallback 到 detail 分层(而非发超大请求)。
            const VISION_MAX_JPEG_BYTES = 1024 * 1024; // 1MB
            if (imageBuffer.length > VISION_MAX_JPEG_BYTES) {
              (args as Record<string, unknown>)._visionFallbackNote =
                `⚠ Vision routing skipped: JPEG image (${(imageBuffer.length / 1024).toFixed(0)}KB) exceeds ${VISION_MAX_JPEG_BYTES / 1024}KB downsampling threshold (JPEG decode not supported). Falling back to detail=${args.detail ?? 'full'}.`;
            } else {
              routeBase64 = imageBuffer.toString('base64');
              routeMime = 'image/jpeg';
            }
          }

          // 仅在拿到有效 base64 时调用 routeImage(JPEG 超限 fallback 时 routeBase64 为 undefined)
          if (routeBase64 !== undefined) {
            const vr = await routeImage(routeBase64, routeMime, {
              apiKey: visionKey,
              model: process.env.GODOT_MCP_VISION_MODEL,
              question: typeof args.vision_question === 'string' ? args.vision_question : undefined,
              timeoutMs: process.env.GODOT_MCP_VISION_TIMEOUT_MS ? parseInt(process.env.GODOT_MCP_VISION_TIMEOUT_MS, 10) : undefined,
              baseUrl: process.env.GODOT_MCP_VISION_BASE_URL,
            });

            if (vr.success && vr.description) {
            // 成功:只返回 TextContent(描述 + routed_via),丢弃 image block(省 token)
            return {
              ...textResult(JSON.stringify({
                action: 'screenshot_analyze_vision',
                vision_description: vr.description,
                routed_via: vr.routedVia,
                image_path: imagePath,
              })),
              structuredContent: {
                action: 'screenshot_analyze_vision',
                vision_description: vr.description,
                routed_via: vr.routedVia,
                image_path: imagePath,
              },
            };
          }
          // 失败:fallback 到 detail 分层 + 追加 note
          (args as Record<string, unknown>)._visionFallbackNote = `⚠ Vision routing failed: ${vr.error}. Falling back to detail=${args.detail ?? 'full'}.`;
          }
        }
      }

      // P1-5 视觉成本层级:按 detail 参数选择返回精度
      const visionNote = (args as Record<string, unknown>)._visionFallbackNote as string | undefined;
      // Phase 2: vision_route 失败时 fallback 追加 note 到 question(3 个 detail 分支共用)
      const question = visionNote ? `${questionRaw}\n\n${visionNote}` : questionRaw;
      let detail: 'full' | 'thumbnail' | 'ascii';
      try {
        detail = parseDetailLevel(args.detail);
      } catch (e) {
        return opsErrorResult('INVALID_PARAMS', (e as Error).message);
      }

      // detail=ascii:返回 ASCII art 文本(最低 token 成本)
      if (detail === 'ascii') {
        if (!isPng) {
          return opsErrorResult('INVALID_PARAMS', 'detail=ascii 仅支持 PNG 图像(当前: ' + ext + ')。');
        }
        // review Nit 3: 正数校验,0/负数 clamp 到默认
        const cols = Math.max(1, (args.ascii_cols as number) ?? 80);
        const rows = Math.max(1, (args.ascii_rows as number) ?? 40);
        const asciiArt = downsampleToAscii(imageBuffer, cols, rows);
        // review Nit 1: 用实测维度标注(可能被 clamp/纵向二次采样截断,与入参不等)
        const actualLines = asciiArt.split('\n');
        const actualCols = actualLines[0]?.length ?? 0;
        return {
          content: [
            { type: 'text' as const, text: `ASCII art (${actualCols}×${actualLines.length}, brightness mapped, requested ${cols}×${rows}):\n\`\`\`\n${asciiArt}\n\`\`\`` },
            { type: 'text' as const, text: question },
          ],
          // Tier1-1: 成功路径补 structuredContent
          structuredContent: {
            action: 'screenshot_analyze',
            image_path: imagePath,
            format: 'png',
            detail: 'ascii',
            ascii_cols: actualCols,
            ascii_rows: actualLines.length,
          },
        };
      }

      // detail=thumbnail:返回降采样 PNG base64(中等 token 成本)
      if (detail === 'thumbnail') {
        if (!isPng) {
          // 反馈 2026-08-19: 补修复指引(仅 PNG 解码是零依赖取舍,非 bug)
          return opsErrorResult('INVALID_PARAMS', 'detail=thumbnail 仅支持 PNG 图像(当前: ' + ext + ')。改传 PNG,或改用 detail=full(JPEG 不受限)。');
        }
        // review Nit 3: 正数校验
        const targetWidth = Math.max(1, (args.thumbnail_width as number) ?? 256);
        const thumb = downsampleToThumbnail(imageBuffer, targetWidth);
        return {
          content: [
            { type: 'image' as const, data: thumb.base64, mimeType: thumb.mimeType },
            { type: 'text' as const, text: `Thumbnail ${thumb.width}×${thumb.height}px (resized to width ${targetWidth}). ${question}` },
          ],
          // Tier1-1: 成功路径补 structuredContent
          structuredContent: {
            action: 'screenshot_analyze',
            image_path: imagePath,
            format: 'png',
            detail: 'thumbnail',
            width: thumb.width,
            height: thumb.height,
          },
        };
      }

      // detail=full(默认):完整 base64 图像(当前行为,最高 token 成本)
      const base64 = imageBuffer.toString('base64');
      const mimeType = isPng ? 'image/png' : 'image/jpeg';

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
        // Tier1-1: 成功路径补 structuredContent
        structuredContent: {
          action: 'screenshot_analyze',
          image_path: imagePath,
          format: isPng ? 'png' : 'jpeg',
          detail: 'full',
        },
      };
    }

    // ─── Task 4: 像素级双图对比(纯 TS,零 Godot 依赖)────────────────────────
    case 'diff': {
      // threshold 校验:默认 0.12;须为 [0,1] 内有限数(== null 覆盖 undefined 与显式 null——
      // 显式 null 若走 Number() 会得 0,把阈值静默变成 0 导致全像素计差)
      const thresholdRaw = args.threshold as number | null | undefined;
      const threshold = thresholdRaw == null ? 0.12 : Number(thresholdRaw);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        return opsErrorResult('INVALID_PARAMS', `"threshold" must be a finite number in [0, 1], got: ${String(args.threshold)}.`);
      }

      // project_path 可选(相对路径解析用);提供时校验白名单(对齐 analyze #1 先例)
      const projectPathRaw = typeof args.project_path === 'string' ? args.project_path : undefined;
      const projectPath = projectPathRaw?.trim() ? validatePath(projectPathRaw) : undefined;
      if (projectPath && !isPathInAllowedRoots(projectPath)) {
        throwPathNotAllowed('project_path', projectPath);
      }

      // image_a/image_b 必填
      const imageARaw = args.image_a as string | undefined;
      const imageBRaw = args.image_b as string | undefined;
      if (!imageARaw?.trim() || !imageBRaw?.trim()) {
        return opsErrorResult('INVALID_PARAMS', '"image_a" and "image_b" are both required for action=diff.');
      }

      // 非 allowOutside 模式必须提供 project_path(相对路径解析锚点,对齐 analyze 先例)
      if (!allowOutsideProjectPaths() && !projectPath) {
        return opsErrorResult('INVALID_PARAMS', 'project_path is required to resolve relative image paths (or set GODOT_MCP_UNRESTRICTED=true / ALLOWED_PROJECT_PATHS to allow arbitrary paths).');
      }

      // 读入路径解析:沿用 analyze 的 image_path 链(allowOutside 双分支,白名单校验)
      const resolveDiffImage = (raw: string): string => {
        let p = raw;
        if (allowOutsideProjectPaths()) {
          if (!isAbsolute(p) && projectPath) {
            p = resolve(projectPath, normalizeUserProjectPath(p));
          }
          p = validatePath(p);
          if (!isPathInAllowedRoots(p)) {
            throwPathNotAllowed('Image path', p);
          }
        } else {
          p = resolveWithinRoot(projectPath!, normalizeUserProjectPath(p));
        }
        return p;
      };
      const pathA = resolveDiffImage(imageARaw);
      const pathB = resolveDiffImage(imageBRaw);

      // 读入前校验:not found / 超限 → INVALID_PARAMS(10MB 上限沿用 analyze 的 MAX_IMAGE_SIZE)
      const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
      for (const p of [pathA, pathB]) {
        if (!existsSync(p)) {
          // P2-17: 不回显 resolve 后的绝对路径
          return opsErrorResult('INVALID_PARAMS', `Image not found: ${basename(p)}`);
        }
        const size = statSync(p).size;
        if (size > MAX_IMAGE_SIZE) {
          return opsErrorResult('INVALID_PARAMS', `Image file too large: ${(size / 1024 / 1024).toFixed(1)} MB. Maximum allowed: 10 MB.`);
        }
      }
      const bufferA = readFileSync(pathA);
      const bufferB = readFileSync(pathB);

      // 逐像素比对(尺寸不一致/非 PNG → INVALID_PARAMS)
      let diff;
      try {
        diff = diffPngBuffers(bufferA, bufferB, threshold);
      } catch (e) {
        return opsErrorResult('INVALID_PARAMS', `Pixel diff failed: ${(e as Error).message}`);
      }

      // 可选 diff_path 写出(沿用 capture 的 output_path 链)
      const diffPathRaw = args.diff_path as string | undefined;
      let diffOutPath: string | undefined;
      if (diffPathRaw?.trim()) {
        const normalizedOut = normalizeUserProjectPath(diffPathRaw);
        diffOutPath = allowOutsideProjectPaths()
          ? (() => {
              const p = validatePath(diffPathRaw);
              if (!isPathInAllowedRoots(p)) {
                throwPathNotAllowed('Output path', p);
              }
              return p;
            })()
          : resolveWithinRoot(projectPath!, normalizedOut);
        const outPng = new PNG({ width: diff.width, height: diff.height });
        outPng.data = diff.diffImageData;
        writeFileSync(diffOutPath, PNG.sync.write(outPng));
      }

      return {
        ...textResult(
          `Pixel diff (${diff.width}x${diff.height}, threshold=${threshold}):\n` +
          `- diff_pixels: ${diff.diffPixels}\n` +
          `- diff_ratio: ${diff.diffRatio}\n` +
          `- bbox: ${diff.bbox === null ? 'null (no differences)' : JSON.stringify(diff.bbox)}` +
          (diffOutPath ? `\n- diff image (red overlay on image_a) saved to: ${diffOutPath}` : ''),
        ),
        structuredContent: {
          action: 'screenshot_diff',
          image_a: pathA,
          image_b: pathB,
          width: diff.width,
          height: diff.height,
          diff_pixels: diff.diffPixels,
          diff_ratio: diff.diffRatio,
          bbox: diff.bbox,
          threshold,
          ...(diffOutPath && { diff_path: diffOutPath }),
        },
      };
    }

    default:
      return textResult(`Unknown action: ${action}. Use "capture", "analyze", or "diff".`);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks: Record<string, RiskLevel> }> = {
  screenshot: {
    readonly: true,
    long_running: false,
    actionRisks: {
      capture: 'read',  // 截图写入文件，但本质是只读操作
      analyze: 'read',  // 仅读取图片文件分析
      diff: 'read',     // Task 4: 像素级双图比对(diff_path 写出是显式参数)
    },
  },
};

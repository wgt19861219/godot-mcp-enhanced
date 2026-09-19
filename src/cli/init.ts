/** init 命令 — 创建 Godot 项目骨架 */
import { join, dirname } from 'path';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { opt } from './args.js';

// export 供 test/cli-args.test.ts 集成测试(空格形式不再静默落空骨架的 F-1 主张)
export function parseInitArgs(args: string[]): { name: string; template: string } {
  const name = args[0] || 'my-game';
  // P2-7(七维度审核): --template 双形式(此前只认等号,空格形式静默落 empty 空骨架)
  return { name, template: opt(args, 'template') ?? 'empty' };
}

/** 项目名称合法性校验：只允许字母、数字、连字符、下划线 */
const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

export async function runInit(args: string[]): Promise<void> {
  const { name, template } = parseInitArgs(args);
  // 易用性批3 (2026-09-19):无参默认名 my-game——TTY 下确认一次防误跑污染 cwd;
  // 非 TTY(脚本/CI/测试)仅打印提示继续(confirm.ts 非 TTY 恒 false,不可当取消)。
  if (!args[0]) {
    if (process.stdin.isTTY) {
      const { confirmYesNo } = await import('./confirm.js');
      if (!(await confirmYesNo(`未指定项目名,使用默认名 "${name}"?`))) {
        console.error('已取消。用法: godot-mcp-enhanced init <name> [--template=<模板>]');
        process.exit(1);
      }
    } else {
      console.log(`(未指定项目名,使用默认名 "${name}";非交互环境不询问)`);
    }
  }
  if (!VALID_NAME.test(name)) {
    console.error(`Invalid project name: "${name}". Use only letters, numbers, hyphens, and underscores.`);
    process.exit(1);
  }
  const projectDir = join(process.cwd(), name);

  if (existsSync(projectDir)) {
    console.error(`Directory already exists: ${projectDir}`);
    process.exit(1);
  }

  console.log(`Creating project "${name}" (template: ${template})...`);

  // 批 3:游戏模板 → 四件套落地(可玩 demo + GDD + qa 套件 + 调参表)
  const { GAME_TEMPLATES, readGameTemplateFiles } = await import('./game-templates.js');
  // B-1(审查):未知模板显式报错列出可用项——小白拼错模板名不能静默降级成空骨架
  if (template !== 'empty' && !GAME_TEMPLATES[template]) {
    console.error(`Unknown template "${template}".`);
    console.error(`Available game templates: ${Object.keys(GAME_TEMPLATES).join(', ')} (or "empty" for a bare skeleton)`);
    process.exit(1);
  }

  // 创建项目目录
  mkdirSync(projectDir, { recursive: true });

  if (GAME_TEMPLATES[template]) {
    writeFileSync(join(projectDir, 'project.godot'), [
      '; Engine configuration file.',
      "; It's best edited using the editor UI and not directly.",
      '',
      '[application]',
      '',
      `config/name="${name}"`,
      'config/features=PackedStringArray("4.2", "GL Compatibility")',
      'run/main_scene="res://main.tscn"',
      '',
      '[display]',
      '',
      'window/size/viewport_width=1280',
      'window/size/viewport_height=720',
      '',
      // P0-2 (2026-09-11): 双 key 关文件日志,防并发实例共享 user://logs 的 rotate race。
      // .pc feature-tag 桌面默认 true 且启动时获胜,只关 base 是 no-op。init 建的项目引导
      // qa run 自动化(多实例场景),无需文件日志。
      '[debug]',
      '',
      'file_logging/enable_file_logging=false',
      'file_logging/enable_file_logging.pc=false',
      '',
    ].join('\n'), 'utf-8');
    for (const f of readGameTemplateFiles(template)) {
      const dest = join(projectDir, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content, 'utf-8');
    }
    console.log(`\n✓ Game project created at ${projectDir}`);
    console.log(`  模板: ${GAME_TEMPLATES[template]!.title} — ${GAME_TEMPLATES[template]!.summary}`);
    console.log('\n试玩与验证(qa 确定性套件,seed 锁随机):');
    console.log(`  cd ${name} && npx godot-mcp-enhanced qa run qa/${template}.qa.md --project .`);
    console.log('调参:编辑 tuning-src/' + template + '.csv → csv_to_resources 重导 .tres → 重启生效(见 design/gdd)');
    return;
  }

  // I-07: 写入 Godot 4.x 兼容的 project.godot，包含 config/features 声明
  writeFileSync(join(projectDir, 'project.godot'), [
    '; Engine configuration file.',
    "; It's best edited using the editor UI and not directly.",
    '',
    '[application]',
    '',
    `config/name="${name}"`,
    'config/features=PackedStringArray("4.2", "GL Compatibility")',
    '',
    '[display]',
    '',
    'window/size/viewport_width=1280',
    'window/size/viewport_height=720',
    '',
    // P0-2 (2026-09-11): 双 key 关文件日志(同 game 模板分支,init 引导 qa run 自动化场景)
    '[debug]',
    '',
    'file_logging/enable_file_logging=false',
    'file_logging/enable_file_logging.pc=false',
    '',
  ].join('\n'), 'utf-8');

  // 写入 scenes 目录
  mkdirSync(join(projectDir, 'scenes'), { recursive: true });

  // 提示运行 setup_project_rules
  console.log(`\n✓ Project created at ${projectDir}`);
  console.log('\nNext steps:');
  console.log(`  1. cd ${name}`);
  console.log('  2. Open in AI editor (Claude Code / Cursor)');
  console.log('  3. Run setup_project_rules to generate CLAUDE.md and hooks');
}

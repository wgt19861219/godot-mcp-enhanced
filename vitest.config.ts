/// <reference types="vitest/globals" />
import { defineConfig } from 'vitest/config';

// M-7(2026-10-22 审查): 真 Godot 集成测试共享可变 fixture(test/fixtures/real-project、
// 固定输出路径如 res://resources/_csv_test_out/),全量并行时 worker 互相清理/覆盖 →
// 超时假红 + READBACK_LOAD_NULL(实测:npm test 2 failed、覆盖率跑 4 failed,隔离重跑全过,
// 系测试隔离缺陷而非机器慢)。Vitest 4 已移除 vitest.workspace.ts(2/3 机制),等价机制是
// 根 config 的 test.projects:unit 保持并行,godot-integration 文件级串行。
const COMMON = {
  globals: true,
  // 填充 gdscript-check fixture(被 gitignore 的运行时拷贝产物)——CI vitest 跑在
  // check:gdscript 之前,不填充则 GD 类测试 load null 挂死超时(见 test/global-setup.ts)
  globalSetup: ['test/global-setup.ts'],
  setupFiles: ['test/setup.js'],
  testTimeout: 10_000,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...COMMON,
          name: 'unit',
          include: ['test/**/*.test.{js,ts}'],
          exclude: [
            'test/integration/**',
            'test/tools/*integration*.test.ts',
            'test/e2e-full-tool-verification.test.ts',
          ],
        },
      },
      {
        test: {
          ...COMMON,
          name: 'godot-integration',
          // 真 Godot + 共享可变 fixture:必须文件级串行(M-7)
          fileParallelism: false,
          include: [
            'test/integration/**',
            'test/tools/*integration*.test.ts',
            // 依赖真 Godot(describe.skipIf(!hasGodot)),自 unit 挪入串行池(计划第 4 点分支:
            // 依真 Godot 且不稳 → 移入 godot-integration,以两轮全量跑全绿为准)
            'test/e2e-full-tool-verification.test.ts',
          ],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/scripts/*.gd', 'src/tools/game-bridge.ts'], // game-bridge.ts:Linux CI 跑不了其测试(vitest mock 平台 bug,见 issue #15),覆盖率退本地(Windows game-bridge.test.ts 23/23 覆盖),
      // W10 批4 豁免留痕:src/dashboard/ui.ts 的 renderDashboard 段(TTY/alternate screen/resize 依赖)不单测——
      // 其纯函数段(visibleLen/truncW/padRight)已 @internal 导出由 test/dashboard/ui.test.ts 测真身(批4审查 Nit-3)。
      // C-06: Thresholds set with ~4% margin below actual coverage to prevent flaky CI.
      // Review: when coverage consistently exceeds thresholds by >4%, raise them.
      // P2-15(2026-08-21 七维度审核): 实测 lines 80.5%/functions 83.4%(2026-08-21 全量
      // exit-0 跑),原阈值滞后 ~20% 违反上方自定"超 4% 应上调"——上调并留 margin;
      // branches 实测值未取,保守不动(下轮 coverage 数据齐后补调)。
      // W11(2026-09-20 可维护性批1): 补调兑现——实测 statements 80.07%/branches 71.81%/
      // functions 84.82%/lines 81.88%(2026-09-20 全量 exit-0 跑,6850 passed)。
      // 按"阈值 ≤ 实测-4%"规则:branches 51→67(原滞后 20.81%),functions 79→80;
      // statements 80.07-4=76.07→76、lines 81.88-4=77.88→77,向下取整(floor)后维持不变
      // (批1审查 Nit-1:77.88 四舍五入为 78,实操口径是 floor——措辞与实现必须一致)。
      thresholds: {
        statements: 76,
        branches: 67,
        functions: 80,
        lines: 77,
      },
    },
  },
});

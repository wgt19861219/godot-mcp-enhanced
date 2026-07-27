// Issue report formatting utilities.
// 提供 severity 分组的人类可读文本格式化 + 文本/JSON 双轨输出。
// 风格蓝本：gdscript-lint.ts:formatLintResults（severity 分组 + 缩进 + → suggestion）+
//           validation.ts:import_resources（"... and N more" 截断提示）。

/** 归一化的 issue 形态（三种结构统一映射到此） */
export interface NormalizedIssue {
  /** 'critical' | 'error' | 'warning' | 'info'；未知 severity 归入 'info' */
  severity: string;
  /** 文件路径或 location 字符串；无则空串 */
  location: string;
  message: string;
  suggestion?: string;
}

/** severity 显示顺序（未知 severity 排末尾归 info） */
const SEVERITY_ORDER = ['critical', 'error', 'warning', 'info'] as const;
const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  error: 'Errors',
  warning: 'Warnings',
  info: 'Info',
};

/**
 * 把 issue 列表格式化为人类可读的 severity 分组文本。
 * 风格对齐 formatLintResults：分组标题 + 缩进列表 + → suggestion。
 *
 * @param issues 归一化的 issue 列表
 * @param opts.truncate 每组最多显示条数（超出加 "... and N more" 提示），默认不截断
 */
export function formatIssues(
  issues: NormalizedIssue[],
  opts?: { truncate?: number },
): string {
  if (issues.length === 0) return 'No issues found.';

  // 按 severity 分组（未知 severity 归 info）
  const groups: Record<string, NormalizedIssue[]> = {};
  for (const issue of issues) {
    const sev = SEVERITY_ORDER.includes(issue.severity as never) ? issue.severity : 'info';
    if (!groups[sev]) groups[sev] = [];
    groups[sev].push(issue);
  }

  const truncate = opts?.truncate;
  const parts: string[] = [];

  for (const sev of SEVERITY_ORDER) {
    const group = groups[sev];
    if (!group || group.length === 0) continue;

    parts.push(`${SEVERITY_LABEL[sev]} (${group.length}):`);

    const shown = truncate !== undefined ? group.slice(0, truncate) : group;
    for (const issue of shown) {
      const loc = issue.location ? `${issue.location}: ` : '';
      parts.push(`  ${loc}${issue.message}`);
      if (issue.suggestion) parts.push(`    → ${issue.suggestion.split('\n')[0]}`);
    }

    if (truncate !== undefined && group.length > truncate) {
      parts.push(`  ... and ${group.length - truncate} more not shown`);
    }
  }

  return parts.join('\n');
}

/**
 * 把人类可读文本 + 原始数据拼成双轨输出。
 * 格式：`<humanText>\n\n---JSON---\n<紧凑 JSON>`
 * 程序/测试从 ---JSON--- 分隔符后解析（紧凑 JSON 比 pretty-JSON 省 ~30% 体积）。
 */
export function dualTrackOutput(humanText: string, data: unknown): string {
  return `${humanText}\n\n---JSON---\n${JSON.stringify(data)}`;
}

/**
 * 从双轨输出文本中解析尾部 JSON。
 * 容错：若无 ---JSON--- 分隔符（旧格式或错误输出），回退直接 parse 整个文本。
 */
export function parseDualTrack(text: string): unknown {
  const marker = '---JSON---\n';
  const idx = text.lastIndexOf(marker);
  if (idx >= 0) {
    return JSON.parse(text.slice(idx + marker.length));
  }
  return JSON.parse(text);
}

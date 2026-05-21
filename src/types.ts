import type { ChildProcess } from 'child_process';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ─── Shared type definitions for tool handlers ─────────────────────────────

export type ToolResult = CallToolResult;

export interface ToolContext {
  opsScript: string;
  findGodot: () => Promise<string>;
  runningProcess: ChildProcess | null;
  setRunningProcess: (proc: ChildProcess | null) => void;
  outputBuffer: string[];
  setOutputBuffer: (buf: string[]) => void;
  processStartTime: number;
  setProcessStartTime: (t: number) => void;
  projectDir: string;
  setProjectDir: (d: string) => void;
  parseGodotConfig: (content: string) => Record<string, unknown>;
}

// Helper to create a text result
export function textResult(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] };
}

// Helper to create an error result (signals failure to MCP clients)
export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

import type { Tool } from "@modelcontextprotocol/server";
import { opsErrorResult } from './shared.js';
import type { ToolContext, ToolResult } from '../types.js';
import type { RiskLevel } from '../core/tool-registry.js';
import { textResult } from '../types.js';
import {
  getClassInfo,
  searchClasses,
  findMethod as findMethodInfo,
  getInheritanceChain,
} from '../godot-docs.js';
import { DEPRECATED_PROPERTIES } from './deprecated-properties.js';

const TOOL_NAMES = ['docs'] as const;

// ─── API Version hints (static, lightweight) ──────────────────────────────────

const NEW_IN_47 = new Set([
  'DrawableTexture2D',  // 4.7 新:shader 实时更新纹理(GPU 内存,类 blit_rect 但 GPU 加速)
  'AreaLight3D',      // 4.7 新:矩形光源节点
  'VirtualJoystick',  // 4.7 新:虚拟摇杆节点(触摸控制)
  'RichTextLabel',    // 4.7 image API 显著变更(ImageUpdateMask.UPDATE_WIDTH_IN_PERCENT→UPDATE_WIDTH_UNIT、add_image/update_image 参数类型重命名)
]);

const NEW_IN_46 = new Set([
  'AnimatedSprite2D',  // 已有但 API 有变化
  'TileMapLayer',       // 替代 TileMap (4.6 正式)
]);

const NEW_IN_45 = new Set([
  'JavaClass',
  'JavaObject',
  'JNISingleton',
  'JNIMethodBind',
]);

const NEW_IN_44 = new Set([
  'OpenXRHand',
  'OpenXRIPBinding',
  'OpenXRInteractionProfile',
  'OpenXRInteractionProfileMetadata',
  'OpenXRAction',
  'OpenXRActionSet',
  'OpenXRActionMap',
  'XRController3D',
  'XRNode3D',
  'XRPose',
  'XRTracker',
  'XRBodyTracker',
  'XRFaceTracker',
  'XRHandTracker',
]);

function getVersionNote(className: string): string {
  if (NEW_IN_47.has(className)) return 'New or significantly changed in Godot 4.7';
  if (NEW_IN_46.has(className)) return 'New or significantly changed in Godot 4.6';
  if (NEW_IN_45.has(className)) return 'New in Godot 4.5';
  if (NEW_IN_44.has(className)) return 'New in Godot 4.4';
  return 'Available since Godot 4.0+. Check documentation for version-specific changes.';
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'docs',
      description: '查询 Godot 类文档(ClassDB)。get_class_info=类详情, search_classes=搜类, find_method=找方法, get_inheritance=继承链。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['get_class_info', 'search_classes', 'find_method', 'get_inheritance'],
            description: '操作类型。get_class_info=类详情, search_classes=搜索类, find_method=找方法定义, get_inheritance=类继承链',
          },
          class_name: { type: 'string', description: 'Godot 类名(get_class_info/find_method/get_inheritance 必填)' },
          method_name: { type: 'string', description: 'find_method 必填:要找的方法名' },
          query: { type: 'string', description: 'search_classes 必填:搜索关键词' },
          limit: { type: 'number', description: 'search_classes 结果上限(默认 20)' },
          include_inherited: { type: 'boolean', description: '是否含继承成员(默认 true)' },
        },
        required: ['action'],
      },
    },
  ];
}



// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  const action = args.action as string;
  if (!action) return textResult('action is required');

  switch (action) {
    case 'get_class_info': {
          const className = args.class_name as string;
          const includeInherited = args.include_inherited !== false;
          const info = getClassInfo(className, includeInherited);
          if (!info) {
            return textResult(`Class not found: ${className}`);
          }
          const classDeprecated = DEPRECATED_PROPERTIES[className];
          const deprecated_warnings = classDeprecated
            ? Object.entries(classDeprecated).map(([name, info]) => ({
                property: name,
                removed: info.removed,
                replacement: info.replacement ?? null,
              }))
            : [];
    
          const result = {
            name: info.name,
            inherits: info.inherits,
            version_note: getVersionNote(info.name),
            brief_description: info.brief_description,
            description: info.description,
            methods_count: info.methods.length,
            methods: info.methods.map(m => ({
              name: m.name,
              signature: `${m.return_type} ${m.name}(${m.arguments.map(a => a.type + ' ' + a.name).join(', ')})`,
              description: m.description,
            })),
            properties_count: info.properties.length,
            properties: info.properties.map(p => {
              const deprecated = DEPRECATED_PROPERTIES[className]?.[p.name];
              return {
                name: p.name,
                type: p.type,
                description: p.description,
                deprecated_notes: deprecated
                  ? (deprecated.removed
                    ? `已移除 (Godot 4.6)${deprecated.replacement ? '，替代: ' + deprecated.replacement : ''}`
                    : `已重命名 (Godot 4.6): 使用 ${deprecated.replacement}`)
                  : null,
              };
            }),
            deprecated_warnings,
            signals_count: info.signals.length,
            signals: info.signals.map(s => ({
              name: s.name,
              description: s.description,
            })),
            constants_count: info.constants.length,
            constants: info.constants.slice(0, 50),
            enums_count: info.enums.length,
          };
          return textResult(JSON.stringify(result, null, 2));
        }
    case 'search_classes': {
          const query = args.query as string;
          const limit = (args.limit as number) || 20;
          const results = searchClasses(query, limit);
          if (results.length === 0) {
            return textResult(`No classes found matching "${query}"`);
          }
          return textResult(JSON.stringify({ count: results.length, classes: results }, null, 2));
        }
    case 'find_method': {
          const className = args.class_name as string;
          const methodName = args.method_name as string;
          const method = findMethodInfo(className, methodName);
          if (!method) {
            return textResult(`Method "${methodName}" not found on ${className} or its parent classes.`);
          }
          const result = {
            class: className,
            version_note: getVersionNote(className),
            name: method.name,
            return_type: method.return_type,
            arguments: method.arguments.map(a => ({
              name: a.name,
              type: a.type,
              default: a.default_value,
            })),
            signature: `${method.return_type} ${method.name}(${method.arguments.map(a => a.type + ' ' + a.name + (a.default_value ? ' = ' + a.default_value : '')).join(', ')})`,
            description: method.description,
          };
          return textResult(JSON.stringify(result, null, 2));
        }
    case 'get_inheritance': {
          const className = args.class_name as string;
          const chain = getInheritanceChain(className);
          if (chain.length === 0) {
            return textResult(`Class not found: ${className}`);
          }
          return textResult(JSON.stringify({ class: className, inheritance_chain: chain }, null, 2));
        }
    default:
      return opsErrorResult('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean; actionRisks: Record<string, RiskLevel> }> = {
  docs: {
    readonly: true,
    long_running: false,
    actionRisks: {
      get_class_info: 'read',
      search_classes: 'read',
      find_method: 'read',
      get_inheritance: 'read',
    },
  },
};

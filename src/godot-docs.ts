// Godot API Documentation Query Module
// Loads extension_api.json and provides fast lookup functions

import { readFileSync } from 'fs';

export interface MethodInfo {
  name: string;
  arguments: Array<{ name: string; type: string; default_value?: string }>;
  return_type: string;
  description: string;
}

export interface PropertyInfo {
  name: string;
  type: string;
  description: string;
  setter?: string;
  getter?: string;
}

export interface SignalInfo {
  name: string;
  description: string;
  arguments: Array<{ name: string; type: string }>;
}

export interface ConstantInfo {
  name: string;
  value: string;
  description: string;
}

export interface ClassInfo {
  name: string;
  inherits: string;
  brief_description: string;
  description: string;
  methods: MethodInfo[];
  properties: PropertyInfo[];
  signals: SignalInfo[];
  constants: ConstantInfo[];
  enums: Array<{ name: string; values: Array<{ name: string; value: string }> }>;
}

interface RawClass {
  name: string;
  inherits?: string;
  brief_description?: string;
  description?: string;
  methods?: Array<{
    name: string;
    arguments?: Array<{ name: string; type: string; default_value?: string }>;
    return_type?: string;
    description?: string;
  }>;
  properties?: Array<{
    name: string;
    type: string;
    setter?: string;
    getter?: string;
    description?: string;
  }>;
  signals?: Array<{
    name: string;
    description?: string;
    arguments?: Array<{ name: string; type: string }>;
  }>;
  constants?: Array<{
    name: string;
    value: string;
    description?: string;
  }>;
  enums?: Array<{
    name: string;
    values: Array<{ name: string; value: string }>;
  }>;
}

interface ApiData {
  classes: RawClass[];
  singletons?: string[];
  native_structures?: unknown[];
}

let classMap: Map<string, RawClass> = new Map();
let initialized = false;

const COMMON_CLASSES: string[] = [
  'Object', 'RefCounted', 'Resource', 'Node',
  'Node2D', 'CanvasItem', 'CanvasLayer',
  'Sprite2D', 'Sprite3D', 'AnimatedSprite2D', 'AnimatedSprite3D',
  'CharacterBody2D', 'CharacterBody3D',
  'RigidBody2D', 'RigidBody3D',
  'StaticBody2D', 'StaticBody3D',
  'AnimatableBody2D', 'AnimatableBody3D',
  'Area2D', 'Area3D',
  'CollisionShape2D', 'CollisionShape3D',
  'CollisionPolygon2D', 'CollisionPolygon3D',
  'Camera2D', 'Camera3D',
  'AudioListener2D', 'AudioListener3D',
  'NavigationAgent2D', 'NavigationAgent3D',
  'NavigationRegion2D', 'NavigationRegion3D',
  'Path2D', 'Path3D', 'PathFollow2D', 'PathFollow3D',
  'RayCast2D', 'RayCast3D',
  'VisibleOnScreenNotifier2D', 'VisibleOnScreenNotifier3D',
  'Marker2D', 'Marker3D',
  'Node3D', 'MeshInstance3D',
  'CSGBox3D', 'CSGSphere3D', 'CSGCylinder3D',
  'DirectionalLight3D', 'PointLight3D', 'SpotLight3D',
  'WorldEnvironment', 'Environment',
  'MeshLibrary', 'GridMap',
  'BoneAttachment3D', 'Skeleton3D',
  'Control', 'Label', 'Button', 'LinkButton',
  'TextureButton', 'TextureRect', 'TextureProgressBar',
  'Panel', 'PanelContainer', 'VBoxContainer', 'HBoxContainer',
  'GridContainer', 'MarginContainer', 'CenterContainer',
  'ScrollContainer', 'TabContainer', 'Window',
  'RichTextLabel', 'LineEdit', 'TextEdit',
  'ProgressBar', 'OptionButton', 'CheckButton', 'CheckBox',
  'SpinBox', 'HSlider', 'VSlider',
  'FileDialog', 'ColorPickerButton',
  'ItemList', 'Tree', 'TabBar',
  'MenuButton', 'PopupMenu',
  'PackedScene', 'ResourceLoader', 'ResourceSaver',
  'Texture2D', 'Texture', 'Image', 'ImageTexture',
  'Material', 'StandardMaterial3D', 'ShaderMaterial', 'Shader',
  'Mesh', 'ArrayMesh', 'PrimitiveMesh', 'BoxMesh', 'SphereMesh', 'PlaneMesh',
  'AudioStream', 'AudioStreamPlayer', 'AudioStreamPlayer2D', 'AudioStreamPlayer3D',
  'AudioStreamOggVorbis', 'AudioStreamWAV', 'AudioStreamMP3',
  'Font', 'FontFile', 'Theme',
  'Curve', 'Gradient', 'GradientTexture2D',
  'Animation', 'AnimationPlayer', 'AnimationTree',
  'TileSet', 'TileMap', 'TileMapLayer',
  'InputEvent', 'InputEventAction', 'InputEventKey', 'InputEventMouseButton',
  'InputEventMouseMotion', 'InputEventJoypadButton', 'InputEventJoypadMotion',
  'InputMap',
  'Timer', 'SceneTree', 'Viewport', 'SubViewport',
  'Time', 'OS',
  'PhysicsMaterial2D', 'PhysicsMaterial3D',
  'Shape2D', 'RectangleShape2D', 'CircleShape2D', 'CapsuleShape2D',
  'Shape3D', 'BoxShape3D', 'SphereShape3D', 'CapsuleShape3D',
  'Vector2', 'Vector3', 'Vector4', 'Vector2i', 'Vector3i',
  'Color', 'Rect2', 'Rect2i', 'Transform2D', 'Transform3D',
  'Basis', 'Quaternion', 'Projection', 'AABB',
  'Plane', 'RID',
  'Array', 'Dictionary', 'PackedByteArray', 'PackedInt32Array',
  'PackedInt64Array', 'PackedFloat32Array', 'PackedFloat64Array',
  'PackedStringArray', 'PackedVector2Array', 'PackedVector3Array',
  'PackedColorArray',
  'Input', 'InputEvent',
  'AudioServer', 'AudioBusLayout',
  'ProjectSettings', 'Performance',
  'Engine', 'ClassDB',
  'DisplayServer', 'RenderingServer',
  'PhysicsServer2D', 'PhysicsServer3D',
  'NavigationServer2D', 'NavigationServer3D',
  'TranslationServer',
  'DebugDraw', 'DebugDraw2D', 'DebugDraw3D',
  'JSON', 'HTTPRequest',
  'StreamPeerTCP', 'PacketPeer',
  'Thread', 'Mutex', 'Semaphore',
  'Callable', 'Signal', 'RefCounted',
  'StringName', 'NodePath',
  'Variant',
];

export function initDocs(docsPath: string): void {
  if (initialized) return;

  const raw = readFileSync(docsPath, 'utf-8');
  const data: ApiData = JSON.parse(raw);

  classMap.clear();
  for (const cls of data.classes) {
    classMap.set(cls.name, cls);
  }

  initialized = true;
  console.error(`[godot-docs] Loaded ${classMap.size} classes from ${docsPath}`);
}

function ensureInit(): void {
  if (!initialized) {
    throw new Error('Godot docs not initialized. Call initDocs() first.');
  }
}

function getRawClass(name: string): RawClass | undefined {
  return classMap.get(name);
}

function normalizeReturn(t?: string): string {
  if (!t || t === '') return 'void';
  return t;
}

function toMethodInfo(raw: { name: string; arguments?: Array<{ name: string; type: string; default_value?: string }>; return_type?: string; description?: string }): MethodInfo {
  return {
    name: raw.name,
    arguments: raw.arguments || [],
    return_type: normalizeReturn(raw.return_type),
    description: raw.description || '',
  };
}

function toPropertyInfo(raw: { name: string; type: string; setter?: string; getter?: string; description?: string }): PropertyInfo {
  return {
    name: raw.name,
    type: raw.type,
    description: raw.description || '',
    setter: raw.setter,
    getter: raw.getter,
  };
}

function toSignalInfo(raw: { name: string; description?: string; arguments?: Array<{ name: string; type: string }> }): SignalInfo {
  return {
    name: raw.name,
    description: raw.description || '',
    arguments: raw.arguments || [],
  };
}

function toConstantInfo(raw: { name: string; value: string; description?: string }): ConstantInfo {
  return {
    name: raw.name,
    value: raw.value,
    description: raw.description || '',
  };
}

export function getInheritanceChain(className: string): string[] {
  ensureInit();
  const chain: string[] = [];
  let current = className;
  while (current) {
    const cls = getRawClass(current);
    if (!cls) break;
    chain.push(current);
    current = cls.inherits || '';
  }
  return chain;
}

export function getClassInfo(
  className: string,
  includeInherited: boolean = true
): ClassInfo | null {
  ensureInit();
  const cls = getRawClass(className);
  if (!cls) return null;

  if (!includeInherited) {
    return {
      name: cls.name,
      inherits: cls.inherits || '',
      brief_description: cls.brief_description || '',
      description: cls.description || '',
      methods: (cls.methods || []).map(toMethodInfo),
      properties: (cls.properties || []).map(toPropertyInfo),
      signals: (cls.signals || []).map(toSignalInfo),
      constants: (cls.constants || []).map(toConstantInfo),
      enums: (cls.enums || []).map(e => ({
        name: e.name,
        values: e.values.map(v => ({ name: v.name, value: v.value })),
      })),
    };
  }

  const chain = getInheritanceChain(className);
  const seenMethods = new Set<string>();
  const seenProps = new Set<string>();
  const seenSignals = new Set<string>();
  const seenConstants = new Set<string>();

  const methods: MethodInfo[] = [];
  const properties: PropertyInfo[] = [];
  const signals: SignalInfo[] = [];
  const constants: ConstantInfo[] = [];
  const enums: ClassInfo['enums'] = [];

  for (const cname of chain) {
    const c = getRawClass(cname)!;

    for (const m of c.methods || []) {
      if (!seenMethods.has(m.name)) {
        seenMethods.add(m.name);
        methods.push(toMethodInfo(m));
      }
    }
    for (const p of c.properties || []) {
      if (!seenProps.has(p.name)) {
        seenProps.add(p.name);
        properties.push(toPropertyInfo(p));
      }
    }
    for (const s of c.signals || []) {
      if (!seenSignals.has(s.name)) {
        seenSignals.add(s.name);
        signals.push(toSignalInfo(s));
      }
    }
    for (const k of c.constants || []) {
      if (!seenConstants.has(k.name)) {
        seenConstants.add(k.name);
        constants.push(toConstantInfo(k));
      }
    }
    for (const e of c.enums || []) {
      enums.push({
        name: e.name,
        values: e.values.map(v => ({ name: v.name, value: v.value })),
      });
    }
  }

  return {
    name: cls.name,
    inherits: cls.inherits || '',
    brief_description: cls.brief_description || '',
    description: cls.description || '',
    methods,
    properties,
    signals,
    constants,
    enums,
  };
}

export function searchClasses(query: string, limit: number = 20): Array<{ name: string; inherits: string; description: string }> {
  ensureInit();
  const q = query.toLowerCase();
  const results: Array<{ name: string; inherits: string; description: string }> = [];

  for (const [, cls] of classMap) {
    if (cls.name.toLowerCase().includes(q) || (cls.brief_description || '').toLowerCase().includes(q)) {
      results.push({
        name: cls.name,
        inherits: cls.inherits || '',
        description: cls.brief_description || '',
      });
      if (results.length >= limit) break;
    }
  }

  return results;
}

export function findMethod(className: string, methodName: string): MethodInfo | null {
  ensureInit();
  const chain = getInheritanceChain(className);

  for (const cname of chain) {
    const cls = getRawClass(cname);
    if (!cls) continue;
    for (const m of cls.methods || []) {
      if (m.name === methodName) {
        return toMethodInfo(m);
      }
    }
  }

  return null;
}

export function findProperty(className: string, propertyName: string): PropertyInfo | null {
  ensureInit();
  const chain = getInheritanceChain(className);

  for (const cname of chain) {
    const cls = getRawClass(cname);
    if (!cls) continue;
    for (const p of cls.properties || []) {
      if (p.name === propertyName) {
        return toPropertyInfo(p);
      }
    }
  }

  return null;
}

export function getCommonClasses(): string[] {
  return [...COMMON_CLASSES];
}
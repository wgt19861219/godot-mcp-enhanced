// src/tscn-editor.ts — Barrel re-export (I-04: Split from monolith)
// Consumers can keep importing from '../../tscn-editor.js'
export type { SceneEditResult } from './tscn-editor-shared.js';
export { addNode, addNodes, canSerializeProperty, formatPropertyValue, verifySceneTree } from './tscn-editor-add.js';
export type { AddNodeParams, AddNodeResult } from './tscn-editor-add.js';
export { findInstanceNode, detachInstance, nodePathToNameAndParent } from './tscn-editor-detach.js';
export type { InstanceNodeInfo } from './tscn-editor-detach.js';

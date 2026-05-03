import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNodePath, gdEscape, validateVector3,
  TYPE_WHITELIST, ERROR_CODES,
  genSignalConnectScript, genSignalDisconnectScript, genSignalEmitScript, genSignalListScript,
  genRaycastScript, genBodyInfoScript, genCreate3DScript, genNavQueryScript,
  genAudioPlayScript, genAudioStopScript, genAudioSetParamScript, genAudioQueryScript
} from '../build/tools/godot-ops.js';

describe('normalizeNodePath', () => {
  it('prepends / if missing', () => {
    assert.strictEqual(normalizeNodePath('root/Player'), '/root/Player');
  });
  it('keeps /root/... unchanged', () => {
    assert.strictEqual(normalizeNodePath('/root/Player'), '/root/Player');
  });
  it('rejects empty string', () => {
    assert.throws(() => normalizeNodePath(''), { message: /empty/ });
  });
  it('rejects whitespace-only', () => {
    assert.throws(() => normalizeNodePath('   '), { message: /empty/ });
  });
  it('rejects res:// paths', () => {
    assert.throws(() => normalizeNodePath('res://scenes/main.tscn'), { message: /scene tree path/ });
  });
  it('trims whitespace', () => {
    assert.strictEqual(normalizeNodePath('  /root/Player  '), '/root/Player');
  });
});

describe('gdEscape', () => {
  it('escapes double quotes', () => {
    assert.strictEqual(gdEscape('say "hello"'), 'say \\"hello\\"');
  });
  it('escapes backslashes', () => {
    assert.strictEqual(gdEscape('path\\to\\file'), 'path\\\\to\\\\file');
  });
  it('escapes newlines', () => {
    assert.strictEqual(gdEscape('line1\nline2'), 'line1\\nline2');
  });
  it('escapes CRLF', () => {
    assert.strictEqual(gdEscape('a\r\nb'), 'a\\nb');
  });
  it('removes null bytes', () => {
    assert.strictEqual(gdEscape('a\0b'), 'ab');
  });
  it('preserves unicode', () => {
    assert.strictEqual(gdEscape('你好世界'), '你好世界');
  });
  it('handles empty string', () => {
    assert.strictEqual(gdEscape(''), '');
  });
});

describe('validateVector3', () => {
  it('accepts valid {x,y,z}', () => {
    assert.deepStrictEqual(validateVector3({ x: 1, y: 2, z: 3 }), { x: 1, y: 2, z: 3 });
  });
  it('accepts zero values', () => {
    assert.deepStrictEqual(validateVector3({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
  });
  it('accepts negative values', () => {
    assert.deepStrictEqual(validateVector3({ x: -1, y: -2.5, z: -3 }), { x: -1, y: -2.5, z: -3 });
  });
  it('rejects missing field', () => {
    assert.throws(() => validateVector3({ x: 1, y: 2 }), { message: /finite number/ });
  });
  it('rejects non-number value', () => {
    assert.throws(() => validateVector3({ x: '1', y: 2, z: 3 }), { message: /finite number/ });
  });
  it('rejects null', () => {
    assert.throws(() => validateVector3(null), { message: /object/ });
  });
  it('rejects NaN', () => {
    assert.throws(() => validateVector3({ x: NaN, y: 0, z: 0 }), { message: /finite number/ });
  });
  it('rejects Infinity', () => {
    assert.throws(() => validateVector3({ x: 0, y: Infinity, z: 0 }), { message: /finite number/ });
  });
});

describe('TYPE_WHITELIST', () => {
  it('contains Node3D', () => { assert.ok(TYPE_WHITELIST.includes('Node3D')); });
  it('contains MeshInstance3D', () => { assert.ok(TYPE_WHITELIST.includes('MeshInstance3D')); });
  it('contains Camera3D', () => { assert.ok(TYPE_WHITELIST.includes('Camera3D')); });
  it('contains RigidBody3D', () => { assert.ok(TYPE_WHITELIST.includes('RigidBody3D')); });
  it('does NOT contain Node', () => { assert.ok(!TYPE_WHITELIST.includes('Node')); });
});

describe('ERROR_CODES', () => {
  it('has INVALID_PATH', () => { assert.ok('INVALID_PATH' in ERROR_CODES); });
  it('has NODE_NOT_FOUND', () => { assert.ok('NODE_NOT_FOUND' in ERROR_CODES); });
  it('has INVALID_VECTOR', () => { assert.ok('INVALID_VECTOR' in ERROR_CODES); });
  it('has INVALID_TYPE', () => { assert.ok('INVALID_TYPE' in ERROR_CODES); });
  it('has INVALID_SIGNAL', () => { assert.ok('INVALID_SIGNAL' in ERROR_CODES); });
  it('has SCRIPT_EXEC_FAILED', () => { assert.ok('SCRIPT_EXEC_FAILED' in ERROR_CODES); });
});

describe('genSignalConnectScript', () => {
  it('contains get_node and connect', () => {
    const script = genSignalConnectScript('/root/Player', 'health_changed', '/root/UI', 'on_health_changed');
    assert.ok(script.includes('get_node("/root/Player")'));
    assert.ok(script.includes('connect("health_changed"'));
    assert.ok(script.includes('Callable'));
    assert.ok(script.includes('get_node("/root/UI")'));
    assert.ok(script.includes('"on_health_changed"'));
  });
});

describe('genSignalDisconnectScript', () => {
  it('contains disconnect call', () => {
    const script = genSignalDisconnectScript('/root/Player', 'health_changed', '/root/UI', 'on_health_changed');
    assert.ok(script.includes('disconnect("health_changed"'));
    assert.ok(script.includes('Callable'));
  });
});

describe('genSignalEmitScript', () => {
  it('contains emit_signal without args', () => {
    const script = genSignalEmitScript('/root/Player', 'died');
    assert.ok(script.includes('emit_signal("died")'));
  });
  it('serializes number args', () => {
    const script = genSignalEmitScript('/root/Player', 'health_changed', [100, 50]);
    assert.ok(script.includes('emit_signal("health_changed", 100, 50)'));
  });
  it('serializes string args with quotes', () => {
    const script = genSignalEmitScript('/root/Player', 'msg', ['hello']);
    assert.ok(script.includes('"hello"'));
  });
  it('rejects object args', () => {
    assert.throws(() => genSignalEmitScript('/root/Player', 'msg', [{ foo: 1 }]), { message: /basic types/ });
  });
  it('includes _mcp_done for output marker', () => {
    const script = genSignalEmitScript('/root/Player', 'died');
    assert.ok(script.includes('_mcp_done'));
    assert.ok(script.includes('___MCP_RESULT___'));
  });
});

describe('genSignalListScript', () => {
  it('contains get_signal_list', () => {
    const script = genSignalListScript('/root/Player');
    assert.ok(script.includes('get_signal_list()'));
    assert.ok(script.includes('_mcp_output'));
  });
});

describe('genRaycastScript', () => {
  it('contains PhysicsRayQueryParameters3D.create', () => {
    const script = genRaycastScript({x:0,y:0,z:0}, {x:10,y:0,z:0});
    assert.ok(script.includes('PhysicsRayQueryParameters3D.create'));
    assert.ok(script.includes('Vector3(0, 0, 0)'));
    assert.ok(script.includes('Vector3(10, 0, 0)'));
    assert.ok(script.includes('get_root().get_viewport()'));
  });
  it('includes collision_mask when provided', () => {
    const script = genRaycastScript({x:0,y:0,z:0}, {x:10,y:0,z:0}, 0b111);
    assert.ok(script.includes('collision_mask = 7'));
  });
  it('includes exclude logic when paths provided', () => {
    const script = genRaycastScript({x:0,y:0,z:0}, {x:10,y:0,z:0}, undefined, ['/root/Wall', '/root/Floor']);
    assert.ok(script.includes('exclude'));
    assert.ok(script.includes('/root/Wall'));
    assert.ok(script.includes('/root/Floor'));
  });
});

describe('genBodyInfoScript', () => {
  it('contains CollisionShape3D scan', () => {
    const script = genBodyInfoScript('/root/Player');
    assert.ok(script.includes('CollisionShape3D'));
    assert.ok(script.includes('get_node("/root/Player")'));
    assert.ok(script.includes('has_collision'));
  });
  it('contains collision_layer and collision_mask', () => {
    const script = genBodyInfoScript('/root/Player');
    assert.ok(script.includes('collision_layer'));
    assert.ok(script.includes('collision_mask'));
  });
});

describe('genCreate3DScript', () => {
  it('creates node with position', () => {
    const script = genCreate3DScript('MeshInstance3D', 'MyMesh', '/root/Scene', {x:1,y:2,z:3});
    assert.ok(script.includes('MeshInstance3D.new()'));
    assert.ok(script.includes('MyMesh'));
    assert.ok(script.includes('position = Vector3(1, 2, 3)'));
  });
  it('creates node with scale', () => {
    const script = genCreate3DScript('Camera3D', 'MainCam', '/root/Scene', undefined, undefined, {x:2,y:2,z:2});
    assert.ok(script.includes('Camera3D.new()'));
    assert.ok(script.includes('scale = Vector3(2, 2, 2)'));
    assert.ok(!script.includes('position ='));
  });
  it('sets custom properties', () => {
    const script = genCreate3DScript('OmniLight3D', 'Light1', '/root/Scene', undefined, undefined, undefined, { light_energy: 2.5, light_color: '"red"' });
    assert.ok(script.includes('light_energy'));
    assert.ok(script.includes('2.5'));
  });
  it('rejects invalid property names', () => {
    assert.throws(() => genCreate3DScript('Node3D', 'X', '/root', undefined, undefined, undefined, { 'a;b': 1 }), { message: /Invalid property name/ });
    assert.throws(() => genCreate3DScript('Node3D', 'X', '/root', undefined, undefined, undefined, { '1bad': 1 }), { message: /Invalid property name/ });
  });
  it('accepts valid property names', () => {
    const script = genCreate3DScript('Node3D', 'X', '/root', undefined, undefined, undefined, { _private: 1, camelCase: 2 });
    assert.ok(script.includes('_private'));
    assert.ok(script.includes('camelCase'));
  });
});

describe('genNavQueryScript', () => {
  it('contains NavigationServer3D.map_get_path', () => {
    const script = genNavQueryScript({x:0,y:0,z:0}, {x:10,y:0,z:10});
    assert.ok(script.includes('NavigationServer3D.map_get_path'));
    assert.ok(script.includes('Vector3(0, 0, 0)'));
    assert.ok(script.includes('Vector3(10, 0, 10)'));
  });
  it('includes region lookup when provided', () => {
    const script = genNavQueryScript({x:0,y:0,z:0}, {x:10,y:0,z:10}, '/root/NavRegion');
    assert.ok(script.includes('NavigationRegion3D'));
    assert.ok(script.includes('/root/NavRegion'));
  });
  it('includes fallback maps logic', () => {
    const script = genNavQueryScript({x:0,y:0,z:0}, {x:10,y:0,z:10});
    assert.ok(script.includes('get_maps'));
    assert.ok(script.includes('warning'));
  });
});

describe('genAudioPlayScript', () => {
  it('generates play script with stream_path', () => {
    const script = genAudioPlayScript('/root/BGMPlayer', 'res://audio/bgm.ogg', -10, 1.0, 'Master');
    assert.ok(script.includes('get_node("/root/BGMPlayer")'));
    assert.ok(script.includes('res://audio/bgm.ogg'));
    assert.ok(script.includes('volume_db = -10'));
    assert.ok(script.includes('pitch_scale = 1.0'));
    assert.ok(script.includes('AudioStreamPlayer'));
    assert.ok(script.includes('.play()'));
  });
  it('generates play script without stream_path', () => {
    const script = genAudioPlayScript('/root/SFX');
    assert.ok(script.includes('.play()'));
    assert.ok(!script.includes('node.stream ='));
  });
  it('generates play script with from_position', () => {
    const script = genAudioPlayScript('/root/BGM', undefined, undefined, undefined, undefined, 5.0);
    assert.ok(script.includes('.play(5.0)'));
  });
});

describe('genAudioStopScript', () => {
  it('generates stop script', () => {
    const script = genAudioStopScript('/root/BGMPlayer');
    assert.ok(script.includes('get_node("/root/BGMPlayer")'));
    assert.ok(script.includes('.stop()'));
  });
});

describe('genAudioSetParamScript', () => {
  it('generates volume_db param script', () => {
    const script = genAudioSetParamScript('/root/BGM', 'volume_db', -5);
    assert.ok(script.includes('volume_db = -5'));
  });
  it('generates pitch_scale param script', () => {
    const script = genAudioSetParamScript('/root/BGM', 'pitch_scale', 1.5);
    assert.ok(script.includes('pitch_scale = 1.5'));
  });
  it('generates bus param script', () => {
    const script = genAudioSetParamScript('/root/BGM', 'bus', 'SFX');
    assert.ok(script.includes('bus = "SFX"'));
  });
});

describe('genAudioQueryScript', () => {
  it('generates query script', () => {
    const script = genAudioQueryScript('/root/BGM');
    assert.ok(script.includes('get_node("/root/BGM")'));
    assert.ok(script.includes('playing'));
    assert.ok(script.includes('volume_db'));
    assert.ok(script.includes('pitch_scale'));
    assert.ok(script.includes('bus'));
    assert.ok(script.includes('get_playback_position'));
  });
});

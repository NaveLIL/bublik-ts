import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { isPathWithin, isValidModuleName, normalizeError } from '../src/core/Safety';
import { getEventGuildId, isInteractionAllowed, isModuleEventAllowed } from '../src/core/Whitelist';

test('module names cannot contain path traversal', () => {
  assert.equal(isValidModuleName('regbattle'), true);
  assert.equal(isValidModuleName('team_tools-2'), true);
  assert.equal(isValidModuleName('../economy'), false);
  assert.equal(isValidModuleName('teams/../../core'), false);
  assert.equal(isValidModuleName(''), false);
});

test('path containment does not confuse sibling prefixes', () => {
  const parent = path.resolve('tmp', 'modules', 'team');
  assert.equal(isPathWithin(parent, path.join(parent, 'index.js')), true);
  assert.equal(isPathWithin(parent, path.resolve('tmp', 'modules', 'teams', 'index.js')), false);
});

test('unknown and circular thrown values become useful Errors', () => {
  const original = new Error('original');
  assert.equal(normalizeError(original), original);

  const circular: Record<string, unknown> = { reason: 'failed' };
  circular.self = circular;
  const normalized = normalizeError(circular);
  assert.match(normalized.message, /failed/);
  assert.match(normalized.message, /Circular/);
});

test('guild id is extracted from interaction, voice/member and Guild payloads', () => {
  assert.equal(getEventGuildId([{ guildId: 'interaction-guild' }]), 'interaction-guild');
  assert.equal(getEventGuildId([{ guild: { id: 'voice-guild' } }]), 'voice-guild');
  assert.equal(
    getEventGuildId([{ id: 'guild-object', members: {}, channels: {} }]),
    'guild-object',
  );
  assert.equal(getEventGuildId([{ id: 'user-id' }]), null);
});

test('module whitelist guard passes real DM interactions but denies malformed payloads', () => {
  const dmInteraction = { guildId: null };
  assert.equal(isInteractionAllowed(dmInteraction), true);
  assert.equal(isModuleEventAllowed('interactionCreate', [dmInteraction]), true);
  assert.equal(isInteractionAllowed({}), false);
  assert.equal(isModuleEventAllowed('interactionCreate', [{}]), false);
});

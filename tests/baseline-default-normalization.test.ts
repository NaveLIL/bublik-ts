import assert from 'node:assert/strict';
import test from 'node:test';

const {
  normalizeDefault,
  targetSchema,
} = require('../scripts/verify-baseline-target');

test('default normalization changes only unquoted PostgreSQL syntax', () => {
  assert.equal(normalizeDefault(' CURRENT_TIMESTAMP '), 'current_timestamp');
  assert.equal(normalizeDefault("'pending'::TEXT"), "'pending'");
  assert.equal(normalizeDefault("'-1'::integer"), '-1');
  assert.equal(normalizeDefault('ARRAY[]::TEXT[]'), 'array[]::text[]');
});

test('default normalization preserves case, whitespace and casts inside literals', () => {
  assert.notEqual(normalizeDefault("'pending'::text"), normalizeDefault("'PENDING'::text"));
  assert.notEqual(normalizeDefault("'a b'::text"), normalizeDefault("'a  b'::text"));
  assert.notEqual(normalizeDefault("'pending'::text"), normalizeDefault("'pending::text'::text"));
  assert.notEqual(normalizeDefault("'{\"state\":\"ok\"}'::jsonb"), normalizeDefault("'{\"state\":\"OK\"}'::jsonb"));
  assert.equal(normalizeDefault("'a  ''B::text'::text"), "'a  ''B::text'");
  assert.equal(normalizeDefault('$$A  ::text$$::text'), '$$A  ::text$$');
  assert.equal(
    normalizeDefault('$\u0442\u0435\u0433$A  ::text$\u0442\u0435\u0433$::text'),
    '$\u0442\u0435\u0433$A  ::text$\u0442\u0435\u0433$',
  );
  assert.equal(
    normalizeDefault('$\u{10400}$A  ::text$\u{10400}$::text'),
    '$\u{10400}$A  ::text$\u{10400}$',
  );
  assert.equal(normalizeDefault('"Case Sensitive"'), '"Case Sensitive"');
});

test('scalar cast normalization never consumes array or typemod suffixes', () => {
  assert.equal(normalizeDefault("'{}'::text[]"), "'{}'::text[]");
  assert.equal(normalizeDefault("'x'::character varying(10)"), "'x'::character varying(10)");
  assert.equal(normalizeDefault("'1'::integer[]"), "'1'::integer[]");
  assert.equal(normalizeDefault("'x'::text$foo"), "'x'::text$foo");
  assert.equal(normalizeDefault("'x'::text.foo"), "'x'::text.foo");
  assert.equal(normalizeDefault("'x'::text\u0442"), "'x'::text\u0442");
  assert.notEqual(normalizeDefault('\u{10400}()'), normalizeDefault('\u{10428}()'));
});

test('malformed quoted defaults and ambiguous schema targets fail closed', () => {
  assert.throws(() => normalizeDefault("'unterminated"), /Unterminated quoted literal/);
  assert.throws(
    () => targetSchema('postgresql://db.invalid/bublik?schema=public&schema=shadow'),
    /more than one schema parameter/,
  );
});

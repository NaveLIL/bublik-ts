import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import JavaScriptObfuscator from 'javascript-obfuscator';

// The build script is CommonJS and intentionally side-effect free when required.
const { OBFUSCATOR_SEED, obfuscatorConfig } = require('../scripts/obfuscate.js') as {
  OBFUSCATOR_SEED: number;
  obfuscatorConfig: Record<string, unknown> & { seed: number };
};

const EXPECTED_OBFUSCATOR_SEED = 0x4255424c;
const EXPECTED_NODE_BASE_DIGEST = 'sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd';
const EXPECTED_NODE_BASE = `node:24-alpine@${EXPECTED_NODE_BASE_DIGEST}`;
const EXPECTED_OPENSSL_PACKAGE = 'openssl=3.5.7-r0';

test('protected runtime uses a stable non-zero obfuscator seed', () => {
  assert.equal(OBFUSCATOR_SEED, EXPECTED_OBFUSCATOR_SEED);
  assert.equal(obfuscatorConfig.seed, EXPECTED_OBFUSCATOR_SEED);
  assert.notEqual(OBFUSCATOR_SEED, 0);

  const source = 'function releaseProbe(value) { return value * 2; } releaseProbe(21);';
  const first = JavaScriptObfuscator.obfuscate(source, obfuscatorConfig).getObfuscatedCode();
  const second = JavaScriptObfuscator.obfuscate(source, obfuscatorConfig).getObfuscatedCode();
  assert.equal(first, second);
});

test('Docker release metadata has safe defaults and audited labels', () => {
  const dockerfile = readFileSync(path.resolve(__dirname, '..', 'Dockerfile'), 'utf8');
  const attributes = readFileSync(path.resolve(__dirname, '..', '.gitattributes'), 'utf8');
  const runbook = readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8');
  assert.deepEqual(
    dockerfile.match(/^FROM .+$/gm),
    [`FROM ${EXPECTED_NODE_BASE} AS builder`, `FROM ${EXPECTED_NODE_BASE} AS runtime`],
  );
  assert.equal(
    dockerfile.match(new RegExp(`RUN apk add --no-cache ${EXPECTED_OPENSSL_PACKAGE}`, 'g'))?.length,
    2,
  );
  assert.equal(dockerfile.match(/rm -f \/var\/log\/apk\.log/g)?.length, 2);
  assert.equal(
    dockerfile.match(/rm -rf \/root\/\.npm \/root\/\.cache \/tmp\/node-compile-cache/g)?.length,
    5,
  );
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(runbook, /git ls-files --eol \| grep -Eq 'w\/\(crlf\|mixed\)'/);
  assert.match(runbook, /^\s+--no-cache \\$/m);
  assert.match(runbook, /^\s+--provenance=false \\$/m);
  assert.match(runbook, /^\s+--sbom=false \\$/m);
  assert.match(runbook, /--output "type=docker,dest=\$output,rewrite-timestamp=true"/);
  assert.match(runbook, /--build-arg SOURCE_DATE_EPOCH="\$source_epoch"/);
  assert.match(runbook, /cmp -- "\$release_image_tar" "\$repro_image_tar"/);
  assert.doesNotMatch(runbook, /docker save --output "\$release_dir\/bublik-image\.tar"/);
  assert.match(runbook, /bublik-redis-validation\.\$release_id\.XXXXXX/);
  assert.match(
    runbook,
    /-v "\$redis_validation:\/backup"[\s\\\r\n]+"\$old_redis_image_id" \/backup\/appendonlydir\/appendonly\.aof\.manifest/,
  );
  assert.doesNotMatch(
    runbook,
    /-v "\$CHECKPOINT_DIR\/redis-data:\/backup"[\s\\\r\n]+"\$old_redis_image_id" \/backup\/appendonlydir\/appendonly\.aof\.manifest/,
  );
  for (const name of [
    'BUBLIK_RELEASE_REVISION',
    'BUBLIK_RELEASE_CREATED',
    'BUBLIK_RELEASE_VERSION',
    'BUBLIK_RELEASE_SOURCE',
    'BUBLIK_RELEASE_SOURCE_TREE',
    'BUBLIK_RELEASE_BASE_COMMIT',
  ]) {
    assert.ok(dockerfile.includes(`ARG ${name}=""`), `${name} must default to an empty value`);
  }

  for (const label of [
    'org.opencontainers.image.revision',
    'org.opencontainers.image.created',
    'org.opencontainers.image.version',
    'org.opencontainers.image.source',
    'org.opencontainers.image.base.name="docker.io/library/node:24-alpine"',
    `org.opencontainers.image.base.digest="${EXPECTED_NODE_BASE_DIGEST}"`,
    'io.bublik.release.source-tree',
    'io.bublik.release.base-commit',
    `io.bublik.build.obfuscator-seed="${EXPECTED_OBFUSCATOR_SEED}"`,
  ]) {
    assert.ok(dockerfile.includes(label), `Dockerfile is missing release label ${label}`);
  }
});

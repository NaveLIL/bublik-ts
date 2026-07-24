import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getRotationDisplayBr,
  getRotationSnapshot,
  parseRotationJson,
  type RotationPeriod,
} from '../src/modules/br/rotation';

const periods: RotationPeriod[] = [
  { start: '2026-07-20', end: '2026-07-26', rating: '6.0' },
  { start: '2026-08-01', end: '2026-08-07', rating: '6.5' },
];

test('rotation JSON rejects impossible calendar dates', () => {
  assert.throws(
    () => parseRotationJson('[{"start":"2026-02-30","end":"2026-03-01","rating":6}]'),
    /Invalid calendar date/,
  );
});

test('rotation parser rejects overlapping periods', () => {
  assert.throws(
    () =>
      parseRotationJson(
        '[{"start":"2026-07-20","end":"2026-07-26","rating":6},' +
          '{"start":"2026-07-26","end":"2026-08-01","rating":6.5}]',
      ),
    /overlap/,
  );
});

test('display uses the next upcoming BR before and between periods', () => {
  const before = getRotationSnapshot(periods, new Date('2026-07-18T12:00:00.000Z'));
  const between = getRotationSnapshot(periods, new Date('2026-07-28T12:00:00.000Z'));

  assert.equal(getRotationDisplayBr(before, periods), '6.0');
  assert.equal(getRotationDisplayBr(between, periods), '6.5');
});

test('display retains the final BR only after the schedule ends', () => {
  const after = getRotationSnapshot(periods, new Date('2026-08-10T12:00:00.000Z'));
  assert.equal(getRotationDisplayBr(after, periods), '6.5');
});

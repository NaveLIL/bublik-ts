import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPbPingerMessage } from '../../src/modules/regbattle/pingerMessages';
import type { PbMassRoleMentionPlan } from '../../src/modules/regbattle/pingEligibility';

const embed = { title: 'Join the reserve squad' };
const mention: PbMassRoleMentionPlan = {
  content: '<@&ping-role>',
  allowedMentions: {
    parse: [],
    roles: ['ping-role'],
    users: [],
    repliedUser: false,
  },
};

test('PB reserve announcement carries the safe ping role as top-level content', () => {
  assert.deepEqual(buildPbPingerMessage(embed, mention), {
    content: '<@&ping-role>',
    embeds: [embed],
    allowedMentions: {
      parse: [],
      roles: ['ping-role'],
      users: [],
      repliedUser: false,
    },
  });
});

test('PB announcement denies every mention when no safe role plan exists', () => {
  assert.deepEqual(buildPbPingerMessage(embed, null), {
    embeds: [embed],
    allowedMentions: {
      parse: [],
      roles: [],
      users: [],
      repliedUser: false,
    },
  });
});

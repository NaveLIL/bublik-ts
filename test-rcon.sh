#!/bin/bash
node -e "
const { Rcon } = require('rcon-client');
async function test() {
  const r = await Rcon.connect({ host: '100.74.108.43', port: 25575, password: '43ee011b247d568a1a623769e2120f0fda70a1fd733a6650', timeout: 5000 });
  const cmd = 'tellraw @a [\"\",{\"text\":\"TEST FROM BOT\",\"color\":\"green\"}]';
  console.log('Sending:', cmd);
  const res = await r.send(cmd);
  await r.end();
  console.log('RESULT:', JSON.stringify(res));
}
test().catch(e => console.error('ERROR:', e.message));
"

const { keccak256 } = require('ethers');

function keccakBytes(buf) {
  if (buf instanceof Uint8Array) {
    const hex = '0x' + Buffer.from(buf).toString('hex');
    return Buffer.from(keccak256(hex).replace(/^0x/i, ''), 'hex');
  }
  const hex = '0x' + Buffer.from(String(buf)).toString('hex');
  return Buffer.from(keccak256(hex).replace(/^0x/i, ''), 'hex');
}

function addToBloom(bloom, value) {
  const h = keccakBytes(value);
  for (let i = 0; i < 3; i++) {
    const m = ((h[2 * i] << 8) | h[2 * i + 1]) & 2047;
    bloom[255 - (m >> 3)] |= (1 << (m & 7));
  }
}

function logsToBloom(logs) {
  const bloom = Buffer.alloc(256, 0);
  for (const lg of logs || []) {
    const addr = lg.address && !/^0x/.test(lg.address) ? '0x' + lg.address : lg.address;
    addToBloom(bloom, Buffer.from(String(addr).replace(/^0x/i, ''), 'hex'));
    for (const topic of lg.topics || []) {
      addToBloom(bloom, Buffer.from(String(topic).replace(/^0x/i, ''), 'hex'));
    }
  }
  return '0x' + bloom.toString('hex');
}

function receiptsRoot(receiptStrings) {
  if (!receiptStrings || !receiptStrings.length) return '0x' + '0'.repeat(64);
  let level = receiptStrings.map(s => keccakBytes(s));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] || a;
      next.push(keccakBytes(Buffer.concat([a, b])));
    }
    level = next;
  }
  return '0x' + level[0].toString('hex');
}

module.exports = { logsToBloom, receiptsRoot, keccakBytes };

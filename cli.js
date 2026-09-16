#!/usr/bin/env node
'use strict';

/**
 * ChocoCoin CLI
 *
 * Structure:
 *   1. Colors / formatting helpers
 *   2. Command registry (single source of truth for --help + dispatch)
 *   3. Arg parsing
 *   4. RPC client
 *   5. Wallet helpers
 *   6. Command handlers, grouped by category
 *   7. Entry point
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const CHOCOHUB = require('./chocohub.js');
const { loadConfig } = CHOCOHUB;

const VERSION = '3.6.0';
const DEFAULT_RPC_URL = 'http://localhost:3001';

// ---------------------------------------------------------------------------
// 1. Colors
// ---------------------------------------------------------------------------

const useColor = !!(process.stdout.isTTY && !process.env.NO_COLOR && process.env.FORCE_COLOR !== '0');
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = {
  grn: paint(32),
  red: paint(31),
  ylw: paint(33),
  cyn: paint(36),
  dim: paint(2),
  bold: paint(1),
};

// ---------------------------------------------------------------------------
// 2. Command registry
// ---------------------------------------------------------------------------

const GROUPS = {
  node: { label: 'NODE', desc: 'Node lifecycle & status' },
  wallet: { label: 'WALLET', desc: 'Key management & transactions' },
  chain: { label: 'CHAIN', desc: 'Blockchain queries' },
  config: { label: 'CONFIG', desc: 'Configuration management' },
  utils: { label: 'UTILS', desc: 'Cryptographic utilities' },
};

// Each entry wires its own handler, so COMMANDS is the single place that
// defines what a command is, what it needs, and what runs it.
const COMMANDS = [
  {
    cmd: 'node:start', group: 'node', desc: 'Start a full node', handler: cmdNodeStart,
    args: [
      { name: '--port', desc: 'HTTP port (default: 3001)' },
      { name: '--storage-dirs', desc: 'Plot directories' },
    ],
  },
  {
    cmd: 'node:status', group: 'node', desc: 'Show node status from RPC', handler: cmdNodeStatus,
    args: [{ name: '--rpc', desc: 'RPC endpoint URL' }],
  },
  {
    cmd: 'wallet:create', group: 'wallet', desc: 'Generate a new wallet keypair', handler: cmdWalletCreate,
    args: [{ name: '--hd', desc: 'Also generate a BIP39 seed' }],
  },
  {
    cmd: 'wallet:import', group: 'wallet', desc: 'Import wallet from seed or private key', handler: cmdWalletImport,
    args: [
      { name: '--seed', desc: 'BIP39 seed (hex)' },
      { name: '--private-key', desc: 'Ed25519 private key (hex)' },
    ],
  },
  {
    cmd: 'wallet:list', group: 'wallet', desc: 'List wallets known to the node', handler: cmdWalletList,
    args: [{ name: '--rpc', desc: 'RPC endpoint URL' }],
  },
  {
    cmd: 'wallet:balance', group: 'wallet', desc: 'Check wallet balance', handler: cmdWalletBalance,
    args: [
      { name: '--address', desc: 'Wallet address (0x...)' },
      { name: '--rpc', desc: 'RPC endpoint URL' },
    ],
  },
  {
    cmd: 'wallet:send', group: 'wallet', desc: 'Send CC tokens', handler: cmdWalletSend,
    args: [
      { name: '--from', desc: 'Sender address' },
      { name: '--to', desc: 'Recipient address' },
      { name: '--value', desc: 'Amount in wei (1 CC = 1e18)' },
      { name: '--private-key', desc: 'Sender private key (hex)' },
      { name: '--fee', desc: 'Transaction fee (optional)' },
      { name: '--rpc', desc: 'RPC endpoint URL' },
    ],
  },
  {
    cmd: 'chain:height', group: 'chain', desc: 'Current blockchain height', handler: cmdChainHeight,
    args: [{ name: '--rpc', desc: 'RPC endpoint URL' }],
  },
  {
    cmd: 'chain:block', group: 'chain', desc: 'Get block by height or hash', handler: cmdChainBlock,
    args: [
      { name: '--height', desc: 'Block height' },
      { name: '--hash', desc: 'Block hash' },
      { name: '--rpc', desc: 'RPC endpoint URL' },
    ],
  },
  {
    cmd: 'chain:peers', group: 'chain', desc: 'List connected peers', handler: cmdChainPeers,
    args: [{ name: '--rpc', desc: 'RPC endpoint URL' }],
  },
  {
    cmd: 'chain:sync', group: 'chain', desc: 'Trigger chain sync', handler: cmdChainSync,
    args: [{ name: '--rpc', desc: 'RPC endpoint URL' }],
  },
  {
    cmd: 'chain:stats', group: 'chain', desc: 'Full chain statistics', handler: cmdChainStats,
    args: [{ name: '--rpc', desc: 'RPC endpoint URL' }],
  },
  {
    cmd: 'config:show', group: 'config', desc: 'Show effective node config', handler: cmdConfigShow, args: [],
  },
  {
    cmd: 'keygen', group: 'utils', desc: 'Generate Ed25519 keypair', handler: cmdKeygen,
    args: [{ name: '--hd', desc: 'Also generate a BIP39 seed' }],
  },
  {
    cmd: 'address', group: 'utils', desc: 'Derive address from public key', handler: cmdAddress,
    args: [{ name: '--pubkey', desc: 'Base64 public key' }],
  },
  {
    cmd: 'sign', group: 'utils', desc: 'Sign a message', handler: cmdSign,
    args: [
      { name: '--message', desc: 'Message to sign' },
      { name: '--private-key', desc: 'Private key (hex)' },
    ],
  },
  {
    cmd: 'verify', group: 'utils', desc: 'Verify a signature', handler: cmdVerify,
    args: [
      { name: '--message', desc: 'Original message' },
      { name: '--signature', desc: 'Signature (hex)' },
      { name: '--pubkey', desc: 'Public key (base64)' },
    ],
  },
];

const HANDLERS = Object.fromEntries(COMMANDS.map((c) => [c.cmd, c.handler]));

function printUsage() {
  const banner = `
${C.cyn(` ██████╗ ██████╗██████╗  ██████╗  ██████╗    ███╗   ██╗ ██████╗ ██████╗ ███████╗
██║     ██║     ██████╔╝██║   ██║██║         ██╔██╗ ██║██║   ██║██║  ██║██╔════╝
██║     ██║     ██╔═══╝ ██║   ██║██║         ██║╚██╗██║██║   ██║██║  ██║█████╗  
██║     ██║     ██║     ██║   ██║██║         ██║ ╚████║██║   ██║██║  ██║██╔══╝  
╚██████╗╚██████╗██║     ╚██████╔╝╚██████╗    ██║  ╚███║╚██████╔╝██████╔╝███████╗
 ╚═════╝ ╚═════╝╚═╝      ╚═════╝  ╚═════╝    ╚═╝   ╚══╝ ╚═════╝ ╚═════╝ ╚══════╝`)}

  ${C.bold('ChocoCoin CLI ' + VERSION)}
  ${C.dim('Usage: node cli.js <category>:<command> [options]')}
`;
  console.log(banner);

  let prevGroup = null;
  for (const entry of COMMANDS) {
    if (entry.group !== prevGroup) {
      const g = GROUPS[entry.group];
      console.log(`  ${C.ylw(C.bold(g.label))} - ${C.dim(g.desc)}`);
      prevGroup = entry.group;
    }
    console.log(`    ${C.grn(entry.cmd.padEnd(22))} ${entry.desc}`);
    for (const a of entry.args) {
      console.log(`      ${C.dim(a.name.padEnd(24))} ${a.desc}`);
    }
  }

  console.log('');
  console.log(`  ${C.bold('GLOBAL OPTIONS')}`);
  console.log(`    ${C.dim('--rpc <url>'.padEnd(24))} RPC endpoint (default: ${DEFAULT_RPC_URL})`);
  console.log(`    ${C.dim('--help, -h'.padEnd(24))} Show this help`);
  console.log('');
}

// ---------------------------------------------------------------------------
// 3. Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const isFlag = arg.startsWith('--') || (arg.startsWith('-') && arg !== '-h');
    if (!isFlag) { args._.push(arg); continue; }

    const key = arg.replace(/^--?/, '');
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith('-');
    if (hasValue) { args[key] = next; i++; } else { args[key] = true; }
  }
  return args;
}

// ---------------------------------------------------------------------------
// 4. RPC client
// ---------------------------------------------------------------------------

function getRpcUrl(args) {
  return args.rpc || process.env.RPC_URL || DEFAULT_RPC_URL;
}

/**
 * POST a JSON body to a node's HTTP API and parse the JSON response.
 * @param {string} baseUrl  e.g. http://localhost:3001
 * @param {string} endpoint e.g. /api/node/status
 * @param {object} [opts]
 * @param {object} [opts.body]        request payload (sent as-is, not wrapped)
 * @param {string|true} [opts.adminToken] literal token, or `true` to read it from disk
 */
function rpcCall(baseUrl, endpoint, opts = {}) {
  const { body = {}, adminToken } = opts;
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, baseUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) };

    if (adminToken) {
      let token = adminToken;
      if (adminToken === true) {
        try { token = fs.readFileSync(path.join(__dirname, 'node-data', 'admin_token.txt'), 'utf8').trim(); } catch { token = ''; }
      }
      if (token) headers['x-admin-token'] = token;
    }

    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
      rejectUnauthorized: false,
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ _raw: data, _status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 5. Wallet helpers
// ---------------------------------------------------------------------------

function keypairFromPrivateKeyHex(privHex) {
  const key = Buffer.from(privHex, 'hex');
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8 = Buffer.concat([pkcs8Prefix, key]);
  const privateKeyObj = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const publicKeyObj = crypto.createPublicKey({ key: privateKeyObj });
  const pubB64 = publicKeyObj.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  return { address: CHOCOHUB.pubKeyToAddress(pubB64), publicKey: pubB64, privateKey: privHex };
}

function genWallet(seedBuffer) {
  const keyOpts = seedBuffer ? { privateKey: seedBuffer } : undefined;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', keyOpts);
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  const privHex = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex');
  return { address: CHOCOHUB.pubKeyToAddress(pubB64), publicKey: pubB64, privateKey: privHex };
}

function printWallet(w) {
  console.log(`  ${C.grn('Address:')}     ${w.address}`);
  console.log(`  ${C.dim('Public Key:')}  ${w.publicKey}`);
  console.log(`  ${C.ylw('Private Key:')} ${w.privateKey}`);
  if (w.seed) console.log(`  ${C.cyn('Seed:')}        ${w.seed}`);
}

function printError(e) {
  console.error(`  ${C.red('Error:')} ${e.message}`);
}

// ---------------------------------------------------------------------------
// 6. Command handlers
// ---------------------------------------------------------------------------

// -- node --

async function cmdNodeStart(args) {
  const config = loadConfig();
  if (args.port) config.port = parseInt(args.port, 10);
  if (args['storage-dirs']) config.plotsDir = args['storage-dirs'];

  const child = spawn(process.execPath, [require.resolve('./src/bootstrap/index.js')], {
    cwd: __dirname,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(config.port),
      PLOTS_DIR: config.plotsDir || '',
      MINER_ADDRESS: config.minerAddress || '',
    },
  });

  console.log(`\n  ${C.grn('Node started')} on port ${C.bold(config.port)}`);
  child.on('exit', (code) => console.log(`\n  Node exited (code ${code})`));
}

async function cmdNodeStatus(args) {
  try {
    const s = await rpcCall(getRpcUrl(args), '/api/node/status');
    console.log(`  ${C.grn('Node ID:')}       ${s.node_id || '?'}`);
    console.log(`  ${C.grn('Height:')}        ${s.height || s.altura || 0}`);
    console.log(`  ${C.dim('Hash:')}          ${(s.hash || '').slice(0, 20)}...`);
    console.log(`  ${C.dim('Chain Work:')}    ${s.chain_work || '0'}`);
    console.log(`  ${C.cyn('Peers:')}         ${s.peer_count || 0}`);
    console.log(`  ${C.ylw('Miner:')}         ${s.miner_address || 'none'}`);
    console.log(`  ${C.dim('Uptime:')}        ${(s.uptime || 0)}s`);
  } catch (e) { printError(e); }
}

// -- wallet --

async function cmdWalletCreate(args) {
  const w = genWallet();
  if (args.hd) w.seed = crypto.randomBytes(32).toString('hex');
  printWallet(w);
}

async function cmdWalletImport(args) {
  if (!args.seed && !args['private-key']) {
    console.error(`  ${C.red('Provide --seed or --private-key')}`);
    return;
  }
  const w = args.seed
    ? genWallet(Buffer.from(args.seed, 'hex'))
    : keypairFromPrivateKeyHex(args['private-key']);
  printWallet(w);
}

async function cmdWalletList(args) {
  try {
    const res = await rpcCall(getRpcUrl(args), '/api/wallets');
    console.log(`  ${C.bold('Wallets')}:`);
    for (const w of (res.wallets || [])) {
      console.log(`    ${C.grn(w.address)}  ${C.ylw((Number(w.balance || 0) / 1e18).toFixed(4))} CC  nonce=${w.nonce || 0}`);
    }
  } catch (e) { printError(e); }
}

async function cmdWalletBalance(args) {
  if (!args.address) { console.error(`  ${C.red('Need --address')}`); return; }
  try {
    const w = await rpcCall(getRpcUrl(args), `/api/wallet/${args.address}`);
    console.log(`  ${C.grn('Address:')} ${args.address}`);
    console.log(`  ${C.ylw('Balance:')} ${(Number(w.balance || 0) / 1e18).toFixed(6)} CC`);
    console.log(`  ${C.dim('Nonce:')}   ${w.nonce || 0}`);
  } catch (e) { printError(e); }
}

async function cmdWalletSend(args) {
  const { from, to, value, 'private-key': privKey, fee } = args;
  if (!from || !to || !value) { console.error(`  ${C.red('Need --from --to --value')}`); return; }
  if (!privKey) { console.error(`  ${C.red('Need --private-key')}`); return; }

  const url = getRpcUrl(args);
  try {
    const wallet = await rpcCall(url, `/api/wallet/${from}`);
    const gasLimit = 21000;
    const gasPrice = CHOCOHUB.suggestedGasPrice(1);
    const tx = {
      chain_id: '19971971',
      from_addr: from,
      to_addr: to,
      value: String(value),
      fee: String(fee || CHOCOHUB.computeFee(gasLimit, gasPrice)),
      nonce: wallet.nonce || 0,
      gas_limit: gasLimit,
      gas_price: String(gasPrice),
      timestamp: Math.floor(Date.now() / 1000),
    };
    tx.signature = CHOCOHUB.signMessage(CHOCOHUB.canonicalTxMessage(tx), privKey);

    const res = await rpcCall(url, '/api/tx/send', { body: tx });
    console.log(`  ${C.grn('Transaction sent:')}`, res);
  } catch (e) { printError(e); }
}

// -- chain --

async function cmdChainHeight(args) {
  try {
    const s = await rpcCall(getRpcUrl(args), '/api/node/status');
    console.log(`  ${C.bold('Height:')} ${s.height || s.altura || 0}`);
  } catch (e) { printError(e); }
}

async function cmdChainBlock(args) {
  if (!args.height && !args.hash) { console.error(`  ${C.red('Need --height or --hash')}`); return; }
  try {
    const id = args.height ? parseInt(args.height, 10) : args.hash;
    const res = await rpcCall(getRpcUrl(args), `/api/node/block/${id}`);
    console.log(JSON.stringify(res.block || res, null, 2));
  } catch (e) { printError(e); }
}

async function cmdChainPeers(args) {
  try {
    const res = await rpcCall(getRpcUrl(args), '/api/node/peers');
    console.log(`  ${C.bold('Peers')}:`);
    for (const p of (res.peers || [])) {
      const health = p.health != null ? (p.health > 0 ? C.grn(p.health) : C.red(p.health)) : '?';
      console.log(`    ${C.cyn(p.url)}  h=${p.height}  health=${health}  ${p.is_banned ? C.red('banned') : C.dim('ok')}`);
    }
  } catch (e) { printError(e); }
}

async function cmdChainSync(args) {
  try {
    const res = await rpcCall(getRpcUrl(args), '/api/node/sync');
    console.log(`  ${C.grn('Sync triggered')}:`, res);
  } catch (e) { printError(e); }
}

async function cmdChainStats(args) {
  try {
    const s = await rpcCall(getRpcUrl(args), '/api/stats');
    console.log(`  ${C.bold('Height:')}    ${s.altura || 0}`);
    console.log(`  Blocks:    ${s.blocos || 0}`);
    console.log(`  Users:     ${s.usuarios || 0}`);
    console.log(`  Txs:       ${s.total_txs || 0}`);
    console.log(`  Mempool:   ${s.mempool || 0}`);
    console.log(`  Plots:     ${s.plots_count || 0}`);
    console.log(`  Capacity:  ${(s.capacidade_gb || 0).toFixed(2)} GB`);
    console.log(`  Supply:    ${(Number(s.supply || 0) / 1e18).toFixed(2)} CC`);
    console.log(`  Reward:    ${(Number(s.current_reward_cc || 0) / 1e18).toFixed(4)} CC`);
    console.log(`  Halving:   ${s.blocks_to_halving || '?'} blocks`);
  } catch (e) { printError(e); }
}

// -- config --

async function cmdConfigShow() {
  const config = loadConfig();
  console.log(`  ${C.bold('Effective Config')}:`);
  for (const [k, v] of Object.entries(config)) {
    if (/key|secret|token|private/i.test(k)) continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : v;
    console.log(`    ${C.dim(k.padEnd(22))} ${C.grn(val)}`);
  }
}

// -- utils --

async function cmdKeygen(args) {
  const w = genWallet();
  if (args.hd) w.seed = crypto.randomBytes(32).toString('hex');
  printWallet(w);
}

async function cmdAddress(args) {
  if (!args.pubkey) { console.error(`  ${C.red('Need --pubkey')}`); return; }
  console.log(`  ${C.grn(CHOCOHUB.pubKeyToAddress(args.pubkey))}`);
}

async function cmdSign(args) {
  if (!args.message || !args['private-key']) {
    console.error(`  ${C.red('Need --message --private-key')}`); return;
  }
  console.log(`  ${C.cyn(CHOCOHUB.signMessage(args.message, args['private-key']))}`);
}

async function cmdVerify(args) {
  if (!args.message || !args.signature || !args.pubkey) {
    console.error(`  ${C.red('Need --message --signature --pubkey')}`); return;
  }
  const ok = CHOCOHUB.verifySignature(args.message, args.signature, args.pubkey);
  console.log(ok ? `  ${C.grn('Valid')}` : `  ${C.red('Invalid')}`);
}

// ---------------------------------------------------------------------------
// 7. Entry point
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }

  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  const handler = HANDLERS[cmd];

  if (!handler) {
    console.error(`  ${C.red(`Unknown command: ${cmd}`)}`);
    const similar = Object.keys(HANDLERS).filter((h) => h.includes(cmd) || cmd.includes(h));
    if (similar.length) console.error(`  ${C.dim(`Did you mean: ${similar.join(', ')}?`)}`);
    console.error();
    printUsage();
    process.exit(1);
  }

  try {
    await handler(args);
  } catch (e) {
    printError(e);
    process.exit(1);
  }
}

main();

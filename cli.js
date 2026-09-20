#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CONFIG_DIR = path.join(__dirname, 'config');
const ENV_PATH = path.join(CONFIG_DIR, 'config.env');
const PID_FILE = path.join(__dirname, 'node.pid');
const BASE_DIR = __dirname;

const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { keccak256 } = require('ethers');

function ensureEnvFile() {
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, '');
  }
}

function readEnv() {
  ensureEnvFile();
  const content = fs.readFileSync(ENV_PATH, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    const hash = v.indexOf(' #');
    if (hash >= 0) v = v.slice(0, hash).trim();
    v = v.replace(/^["']|["']$/g, '');
    env[k] = v;
  }
  return env;
}

function writeEnv(env) {
  const lines = [];
  for (const [k, v] of Object.entries(env)) {
    lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
}

function secpPrivateKeyToAddress(privateKeyHex) {
  const pk = Buffer.from(privateKeyHex.replace(/^0x/i, ''), 'hex');
  const pub = secp256k1.getPublicKey(new Uint8Array(pk), true);
  const hash = keccak256('0x' + Buffer.from(pub.slice(1)).toString('hex'));
  return '0x' + hash.slice(-40);
}

function generateWallet() {
  const privateKey = crypto.randomBytes(32).toString('hex');
  const address = secpPrivateKeyToAddress(privateKey);
  const pubBytes = secp256k1.getPublicKey(Buffer.from(privateKey, 'hex'), true);
  const publicKey = Buffer.from(pubBytes).toString('base64');
  return { privateKey, address, publicKey };
}

async function walletCreate() {
  const wallet = generateWallet();
  const env = readEnv();
  env.MINER_PRIVATE_KEY = wallet.privateKey;
  env.MINER_ADDRESS = wallet.address;
  env.MINER_PUBLIC_KEY = wallet.publicKey;
  writeEnv(env);
  console.log('Wallet created and saved to config.env');
  console.log(`Address: ${wallet.address}`);
  console.log(`Private Key: ${wallet.privateKey}`);
  console.log(`Public Key: ${wallet.publicKey}`);
}

function getPid() {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (isNaN(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function nodeStart() {
  const pid = getPid();
  if (pid) {
    console.log(`Node already running (PID: ${pid})`);
    return;
  }
  const child = spawn('node', ['chocohub.js'], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    cwd: BASE_DIR
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`Node started (PID: ${child.pid})`);
  await new Promise(r => setTimeout(r, 1000));
  const newPid = getPid();
  if (newPid) console.log('Node is running');
  else console.log('Node may have failed to start, check logs');
}

async function nodeStop() {
  const pid = getPid();
  if (!pid) {
    console.log('Node is not running');
    return;
  }
  try {
    process.kill(pid, 'SIGINT');
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (!getPid()) break;
    }
    if (getPid()) {
      process.kill(pid, 'SIGKILL');
      console.log('Node force killed');
    } else {
      console.log('Node stopped gracefully');
    }
  } catch (e) {
    console.log('Error stopping node:', e.message);
  } finally {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  }
}

async function nodeStats() {
  const env = readEnv();
  const adminToken = env.ADMIN_TOKEN;
  const port = env.PORT || 3001;
  const host = env.NODE_URL ? new URL(env.NODE_URL).hostname : 'localhost';
  const url = `http://${host}:${port}/api/stats`;

  const headers = {};
  if (adminToken) headers['X-Admin-Token'] = adminToken;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log('Node Stats:');
    console.log(`  Height: ${data.height}`);
    console.log(`  Hash: ${data.hash}`);
    console.log(`  Chain Work: ${data.chain_work}`);
    console.log(`  Peers: ${data.peers?.active || 0} active / ${data.peers?.total || 0} total`);
    console.log(`  Mempool: ${data.mempool}`);
    console.log(`  Plots: ${data.plots_count}`);
    console.log(`  Capacity: ${data.capacity_gb} GB`);
    console.log(`  Supply: ${data.supply}`);
    console.log(`  Current Reward: ${data.current_reward_cc} CC`);
    console.log(`  Version: ${data.version}`);
  } catch (e) {
    console.error('Failed to fetch stats:', e.message);
  }
}

function printHelp() {
  console.log(`
Usage: node cli.js <command>

Commands:
  wallet create     Generate new wallet and save to config.env
  node start        Start the node in background
  node stop         Stop the running node
  node stats        Fetch stats from admin endpoint
  help              Show this help
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const sub = args[1];

  if (cmd === 'wallet' && sub === 'create') {
    await walletCreate();
  } else if (cmd === 'node' && sub === 'start') {
    await nodeStart();
  } else if (cmd === 'node' && sub === 'stop') {
    await nodeStop();
  } else if (cmd === 'node' && sub === 'stats') {
    await nodeStats();
  } else {
    printHelp();
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
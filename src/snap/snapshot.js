const { sha256hex, computeStateRoot } = require('../crypto-utils/crypto');

const SNAPSHOT_FORMAT = 1;
const DOMAIN = 'cc.snapshot.v1';

function currentStateRoot(db) {
  return computeStateRoot(db);
}

function _nowSec() { return Math.floor(Date.now() / 1000); }

function extractState(db, height, opts = {}) {
  const users = db.prepare('SELECT address, public_key_secp256k1, balance, nonce, created_at, updated_at FROM users ORDER BY lower(address)').all().map((r) => ({
    address: r.address, public_key_secp256k1: r.public_key_secp256k1 || '',
    balance: String(r.balance), nonce: r.nonce || 0,
    created_at: r.created_at || 0, updated_at: r.updated_at || 0,
  }));

  const contract_accounts = db.prepare('SELECT address, balance FROM smart_contract_accounts ORDER BY lower(address)').all().map((r) => ({
    address: r.address, balance: String(r.balance),
  }));

  const contracts = db.prepare('SELECT address, creator, code, created_at, updated_at FROM smart_contracts ORDER BY lower(address)').all().map((r) => ({
    address: r.address, creator: r.creator || '', code: String(r.code || ''),
    created_at: r.created_at || 0, updated_at: r.updated_at || 0,
  }));

  const contract_storage = db.prepare('SELECT contract_address, slot, value FROM smart_contract_storage ORDER BY lower(contract_address), slot').all().map((r) => ({
    contract_address: r.contract_address, slot: r.slot, value: String(r.value),
  }));

  const contract_logs = db.prepare('SELECT tx_hash, block_height, block_hash, log_index, address, topics, data FROM contract_logs ORDER BY block_height, log_index').all().map((r) => ({
    tx_hash: r.tx_hash, block_height: r.block_height, block_hash: r.block_hash,
    log_index: r.log_index, address: r.address, topics: r.topics, data: r.data,
  }));

  return {
    format: SNAPSHOT_FORMAT,
    domain: DOMAIN,
    height,
    state_root: currentStateRoot(db),
    zkp_commitment: opts.zkp_commitment || '',
    zkp_proof_id: opts.zkp_proof_id || null,
    created_at: opts.created_at || _nowSec(),
    block_hash_at_height: opts.block_hash || '',
    users,
    contract_accounts,
    contracts,
    contract_storage,
    contract_logs,
  };
}

function snapshotDigest(snapshot) {
  const canonical = {
    height: snapshot.height,
    state_root: snapshot.state_root,
    user_hashes: snapshot.users.map((u) => sha256hex(`${u.address}|${u.public_key_secp256k1}|${u.balance}|${u.nonce}`)).sort(),
    contract_hashes: snapshot.contract_accounts.map((c) => sha256hex(`acc:${c.address}|${c.balance}`)).sort(),
    code_hashes: snapshot.contracts.map((c) => sha256hex(`code:${c.address}|${c.creator}|${sha256hex(c.code)}`)).sort(),
    storage_hashes: snapshot.contract_storage.map((s) => sha256hex(`st:${s.contract_address}|${s.slot}|${s.value}`)).sort(),
  };
  return sha256hex(JSON.stringify(canonical, Object.keys(canonical).sort()));
}

function verifySnapshotIntegrity(snapshot) {
  if (!snapshot || snapshot.domain !== DOMAIN) return { ok: false, motivo: 'invalid snapshot' };
  if (snapshot.digest && snapshot.digest !== snapshotDigest(snapshot)) return { ok: false, motivo: 'snapshot digest mismatch' };
  return { ok: true, state_root: snapshot.state_root };
}

function applySnapshot(db, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.users)) throw new Error('applySnapshot: invalid snapshot');
  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM users').run();
    const insUser = db.prepare('INSERT OR REPLACE INTO users (address, public_key_secp256k1, balance, nonce, created_at, updated_at) VALUES (?,?,?,?,?,?)');
    for (const u of snapshot.users) {
      insUser.run(u.address, u.public_key_secp256k1 || '', String(u.balance ?? '0'), u.nonce || 0, u.created_at || 0, u.updated_at || 0);
    }
    db.prepare('DELETE FROM smart_contract_accounts').run();
    const insAcc = db.prepare('INSERT OR REPLACE INTO smart_contract_accounts (address, balance) VALUES (?,?)');
    for (const a of snapshot.contract_accounts || []) insAcc.run(a.address, String(a.balance ?? '0'));
    db.prepare('DELETE FROM smart_contracts').run();
    const insCode = db.prepare('INSERT OR REPLACE INTO smart_contracts (address, creator, code, created_at, updated_at) VALUES (?,?,?,?,?)');
    for (const c of snapshot.contracts || []) insCode.run(c.address, c.creator || '', String(c.code || ''), c.created_at || 0, c.updated_at || 0);
    db.prepare('DELETE FROM smart_contract_storage').run();
    const insSt = db.prepare('INSERT OR REPLACE INTO smart_contract_storage (contract_address, slot, value) VALUES (?,?,?)');
    for (const s of snapshot.contract_storage || []) insSt.run(s.contract_address, s.slot, String(s.value ?? ''));
    try {
      db.prepare('DELETE FROM contract_logs').run();
      const insLog = db.prepare('INSERT OR REPLACE INTO contract_logs (tx_hash, block_height, block_hash, log_index, address, topics, data) VALUES (?,?,?,?,?,?,?)');
      for (const l of snapshot.contract_logs || []) insLog.run(l.tx_hash, l.block_height, l.block_hash, l.log_index, l.address, l.topics, l.data);
    } catch (e) { /* contract_logs may be absent */ }
  });
  tx();
  db.pragma('foreign_keys = ON');
  return { ok: true, applied_height: snapshot.height, state_root: snapshot.state_root };
}

module.exports = {
  SNAPSHOT_FORMAT,
  DOMAIN,
  currentStateRoot,
  extractState,
  snapshotDigest,
  verifySnapshotIntegrity,
  applySnapshot,
};

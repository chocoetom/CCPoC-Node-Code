# CCPoC Node — REST API

A plain-language guide to the HTTP API that every CCPoC node exposes.

## What's inside

1. [Auth (Admin)](#1-auth-admin)
2. [Rate Limiting](#2-rate-limiting)
3. [Mining and Registering](#3-mining-and-registering)
4. [Transactions](#4-transactions)
5. [Smart Contracts](#5-smart-contracts)
6. [JSON-RPC (aka Ethereum-json-rpc)](#6-json-rpc-aka-ethereum-json-rpc)
7. [Node and Chain state](#7-node-and-chain-state)
8. [Node-to-node (P2P network)](#8-node-to-node-p2p-network)
9. [P2P Exchange](#9-p2p-exchange)

## The basics

- **Where:** `http://<node-host>:<port>`. If the port is taken, the node quietly moves to the next one.
- **Format:** send and receive JSON. Request bodies can be up to 10 MB.
- **Amounts:** balances, `value`, `fee` and gas prices are strings in **wei** (1 coin = 10^18 wei).
- **Addresses:** lowercase `0x…`.
- **Browsers (CORS):** only sites listed in `cfg.corsOrigins` (or `cfg.nodeUrl`) can call the node from a browser.
- **Errors** come back as JSON. Most look like `{ "error": "what went wrong" }`. Transaction routes use `{ "ok": false, "error": "…" }`, and contract routes use `{ "error": "CODE", "message": "…" }`. Some chain results say `motivo` instead, which is Portuguese for "reason".

---

## 1. Auth (Admin)

Admin endpoints need the node's admin token (`cfg.adminToken`). Send it in either header:

```http
X-Admin-Token: <token>
Authorization: Bearer <token>
```

Wrong or missing token? You get `401 { "error": "unauthorized" }`.

These are the admin-only endpoints:

| Method | Path | What it does |
|---|---|---|
| POST | `/api/wallet/import` | Save or overwrite a wallet's public key |
| POST | `/api/poc/register_plot` | Register a plot without a signature (the admin version, there is a public one too) |
| POST | `/api/poc/create_plot` | Create a plot file on the node's disk |
| POST | `/api/plots/add` | Add a plot record directly |
| DELETE | `/api/plots/:id` | Delete a plot record |
| POST | `/api/node/forge` | Force the node to forge a block |
| POST | `/api/node/settings` | Change the node's config |
| GET | `/api/logs` | Read the node's recent logs |
| GET | `/api/admin/wallets` | List wallets |

Everything else is public.

---

## 2. Rate Limiting

Each IP address gets **120 requests per minute** across the whole API. A few routes have a tighter limit on top of that:

| Limit | Per minute | Applies to |
|---|---|---|
| Everything | 120 | all routes |
| Mutations | 30 | `POST /api/mempool`, both proof-submit routes, `register_plot_public`, contract `deploy` / `call` / `call-batch` / `execute`, exchange `offers` (create, take, claim, refund) |
| Wallet | 10 | `POST /api/wallet/prepare-tx`, `/register`, `/import` |
| P2P | 60 | `POST /api/peers/add`, `/api/node/announce`, `/api/node/broadcast/block`, `/api/node/broadcast/tx`, `/register` |

Every response tells you where you stand:

- `X-RateLimit-Limit`: the limit
- `X-RateLimit-Remaining`: how many requests you have left
- `X-RateLimit-Reset`: when the window resets (Unix seconds)

Go over the limit and you get `429 { "error": "…", "retryAfter": <seconds> }`.

The counters live in memory, so they reset when the node restarts.

---

## 3. Mining and Registering

Mining works in two steps: **ask for the current challenge, then submit a proof.** Before that, a miner registers their plots (their stored data) so the node knows they exist.

| Method | Path | Who | What it does |
|---|---|---|---|
| GET | `/api/challenge` | anyone | Current challenge plus a network summary |
| GET | `/api/mining/challenge` | anyone | The raw challenge |
| POST | `/api/mining/submit-proof` | anyone | Submit a proof (**use this one**) |
| POST | `/api/challenge/submit` | anyone | Another way to submit a proof |
| GET | `/api/plots` | anyone | All registered plots |
| GET | `/api/poc/plots/:miner` | anyone | One miner's plots |
| POST | `/api/poc/register_plot_public` | anyone | Register a plot with a signature |
| GET | `/api/rewards/:address` | anyone | A miner's block rewards |
| POST | `/api/poc/register_plot` | admin | Register a plot with no signature (legacy) |
| POST | `/api/poc/create_plot` | admin | Create a plot file on the node |
| POST | `/api/plots/add` | admin | Add a plot record |
| DELETE | `/api/plots/:id` | admin | Delete a plot record |
| POST | `/api/node/forge` | admin | Force-forge a block |

### GET `/api/challenge`

The active challenge, with a few extras. If there isn't one, you get `404 { "error": "no active challenge" }`.

You get back `challenge_id`, `block_height`, `challenge_seed`, `target_scoop_index`, `base_target`, `created_at` and `expires_at` (Unix seconds), and:

- `deadline`: seconds left before the challenge expires
- `plots`: how many plots are registered
- `capacity_gb`: total registered storage
- `difficulty`: `"~<height> blocks"`, or `"genesis"` at height 0

### GET `/api/mining/challenge`

The same challenge, exactly as the node holds it. `404 { "error": "no challenge available" }` if there isn't one.

### POST `/api/mining/submit-proof`

This is the route miners should use.

Send:

| Field | Needed? | Notes |
|---|---|---|
| `challenge_id` | yes | |
| `miner` | yes | Miner address |
| `plot_id` | yes | |
| `deadline` | yes | A number. `0` is fine, missing is not |
| `proof_packet` | no | The proof data |
| `proof_signature` | no | Gets copied into `proof_packet.proof_signature` if it isn't already there |

You get back:

- **200** `{ "ok": true, "motivo": "…", "bloco": { … } }`. `bloco` shows up if your proof produced a block, and the node shares that block with its peers.
- **400** `{ "error": "<reason>" }` if the proof was rejected or a field is missing.

### POST `/api/challenge/submit`

Same body as `submit-proof`, with two differences: it **always answers 200** (so check `ok` in the result), and it doesn't share the resulting block itself.

### GET `/api/plots`

`{ "plots": [ { "plot_id", "miner", "merkle_root", "size_gb", "created_at" } ] }`, biggest first. Every plot comes back at once (no paging).

### GET `/api/poc/plots/:miner`

`{ "plots": [ … ] }` with everything stored for that miner's plots. The address is lowercased for you.

### POST `/api/poc/register_plot_public`

The normal way to register a plot. The miner signs the registration with their private key, so the node knows it really came from them.

Send all of these:

| Field | Notes |
|---|---|
| `miner` | Miner address |
| `plot_id` | |
| `merkle_root` | |
| `size_gb` | More than 0, up to the node's max plot size |
| `total_scoops` | |
| `public_key` | Must match `miner` |
| `signature` | Signature over the plot details (see `plotRegisterMessage()` in `crypto-utils/crypto.js`) |

You get back:

- **200** `{ "ok": true, "plot_id": "…", "miner": "0x…" }`
- **400** for a missing field, a bad size, or a public key that doesn't match the address
- **401** `{ "error": "invalid registration signature" }`

Good to know: registering a `plot_id` that already exists **replaces** the old record. The miner's account is also created (or gets its public key updated) if needed.

### POST `/api/poc/register_plot` (admin)

The old way, left over from the built-in miner. **No signature needed.**

Send `miner`, `plot_id`, `size_gb`, and optionally `merkle_root`. If the `plot_id` already exists, nothing changes. You get `{ "ok": true, "plot_id", "miner" }`.

### POST `/api/poc/create_plot` (admin)

Makes a plot file on the node's disk and registers it.

Send `plot_id` and `size_gb`. Optionally send `miner` (defaults to the node's miner address) and `plot_dir` (defaults to the node's plots folder). The file is saved as `<plot_dir>/<plot_id>.plot`.

You get `{ "ok": true, "plot_id", "merkle_root", "size_gb", "path" }`. Errors: `400` for missing fields or a bad size, `500` if the file couldn't be created.

### POST `/api/plots/add` (admin)

Send `miner`, `plot_id`, `size_gb`, and optionally `merkle_root`. It's like `register_plot`, but it doesn't check the size or lowercase the address. You get `{ "ok": true, "plot_id", "miner" }`.

### DELETE `/api/plots/:id` (admin)

Deletes that plot record. Always answers `{ "ok": true }`, even if the id wasn't there.

### POST `/api/node/forge` (admin)

Forges a block for the current challenge. Answers `{ "ok": true }`, or `400 { "error": "no challenge" }` if there's nothing to forge.

### GET `/api/rewards/:address`

`{ "rewards": [ … ] }`: the last 100 block rewards for that miner, newest first. The address has to match exactly (no lowercasing here).

---

## 4. Transactions

A transaction looks like this:

```json
{
  "from_addr": "0x…",
  "to_addr": "0x…",
  "value": "1000000000000000000",
  "nonce": 0,
  "fee": "21000",
  "gas_limit": 21000,
  "gas_price": "…",
  "chain_id": "…",
  "priority_fee": "0",
  "data": "0x…",
  "signature": "…",
  "hash": "0x…"
}
```

- To create a contract, leave `to_addr` as `""` and put the bytecode in `data`. For a normal transfer, `data` isn't needed.
- If you leave out `hash`, the node works it out for you.

**The usual flow:**

1. Register the wallet once (`/api/wallet/register`).
2. Ask the node to build the transaction (`/api/wallet/prepare-tx`).
3. Sign the `sign_message` you get back, on your side.
4. Send the signed transaction to `/api/mempool`.

Your private key never has to leave your machine.

| Method | Path | What it does |
|---|---|---|
| POST | `/api/wallet/register` | Link an address to its public key |
| POST | `/api/wallet/import` | Same, but admin-only and it overwrites |
| POST | `/api/wallet/prepare-tx` | Build an unsigned transaction |
| POST | `/api/mempool` | Send a signed transaction |
| GET | `/api/mempool` | See pending transactions |
| GET | `/api/transactions` | Confirmed transactions |
| GET | `/api/transaction/:hash` | One confirmed transaction |
| GET | `/api/accounts` | Balance and nonce of an address |
| GET | `/api/users/:address` | Full account record |
| GET | `/api/wallets` | Top 200 accounts by balance |
| GET | `/api/gas/price` | Current gas price |

### POST `/api/wallet/register`

Send `address` and `public_key`. The node checks that the key really belongs to that address.

- **200** `{ "ok": true, "address": "0x…", "public_key": "…" }`
- **400** for a missing field, a key that doesn't match the address, or an invalid key
- **409** `{ "ok": false, "error": "public key already registered", "address": "0x…" }`

### POST `/api/wallet/import` (admin)

Same body and checks as `register`, but if the address already has a key, it gets **overwritten**. You get `{ "ok": true, "address": "0x…" }`. Only public keys are stored, never private ones.

### POST `/api/wallet/prepare-tx`

Builds an unsigned transaction and the message you need to sign.

| Field | Needed? | Notes |
|---|---|---|
| `from_addr` | yes | |
| `to_addr` | yes* | *or `data`, when creating a contract |
| `amount` | no | **In coins** (a normal decimal number). Defaults to 0 |
| `data` | no | `0x…` hex |
| `gas_limit` | no | 21000 by default, or 3000000 if you send `data` |
| `gas_price` | no | Defaults to the current base fee |
| `chain_id` | no | Defaults to the node's chain id |
| `priority_fee` | no | Defaults to `"0"` |

The `nonce` comes from the account (0 if the address is new), and `fee` is set to the gas limit.

You get back:

```json
{
  "ok": true,
  "transaction": { "from_addr": "…", "to_addr": "…", "value": "…", "nonce": 0, "fee": "21000", "gas_limit": 21000, "gas_price": "…", "chain_id": "…", "priority_fee": "0" },
  "sign_message": "0x…",
  "tx_hash": "0x…",
  "estimated_gas": 21000,
  "estimated_fee": "…",
  "gas_price": "…",
  "balance": "…",
  "nonce": 0
}
```

`estimated_fee` is the gas limit times the current base fee, in wei. Problems come back as `400 { "error": "…" }`.

> **Heads up on big amounts:** `amount` is converted to wei with regular floating-point math. For 1000 coins or more, or for lots of decimals, it's safer to build the transaction yourself and send `value` as a wei string to `/api/mempool`.

### POST `/api/mempool`

Send a signed transaction. It needs `from_addr` and either `to_addr` or `data`.

- **200** `{ "ok": true, "motivo": "…" }`. The node then passes the transaction on to its peers.
- **400** `{ "error": "invalid transaction" }`, or `{ "ok": false, "error": "<why it failed validation>" }`

### GET `/api/mempool`

`{ "transactions": [ … ], "count": n }`: up to 200 pending transactions, highest fee first.

### GET `/api/transactions`

Optional filters:

- `address`: transactions sent from or to this address (exact match)
- `limit`: 50 by default, 200 at most

You get `{ "transactions": [ … ] }`, newest block first.

### GET `/api/transaction/:hash`

The transaction, or `404 { "error": "not found" }`.

### GET `/api/accounts?address=0x…`

`{ "address", "balance", "nonce", "created_at", "updated_at" }`. If the address is unknown you get a balance of `"0"` and a nonce of `0`. Forgetting `address` gives you a `400`.

### GET `/api/users/:address`

The full account record, or `404 { "error": "user not found" }`.

### GET `/api/wallets`

`{ "wallets": [ … ], "count": n }`: the top 200 accounts by balance.

### GET `/api/gas/price`

`{ "gas_price": "<wei>", "unit": "wei" }`: the base fee for the next block.

---

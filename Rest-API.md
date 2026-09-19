# CCPoC Node — REST API reference (node endpoints)

 # Summary

 1. Auth (Admin)
 2. Rate Limiting
 3. Mining and Registering
 4. Transactions
 5. Smart Contracts
 6. Json-RPC (aka Ethereum-json-rpc)
 7. Node and Chain state

### Auth 

Admin Endpoints Require an **Admin Token** That matches with node's **cfg.adminToken**

Endpoints that require an **Admin Token**:
> /api/stats/admin
> /api/snapshot/generate
> /api/wallet/import
> /api/poc/register_plot (admin version, there is a public one too.)
> /api/contracts/:address/snapshot
> /api/logs

### Rate Limiting 

Node code have an universal **Rate Limiting** for endpoints, being 100R in a 60000ms window (60s)

### Mining and Registering



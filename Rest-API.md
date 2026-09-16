# CCPoC Node — REST API reference (node endpoints)

 # Summary

 1. Auth (Admin)
 2. Node and Chain Stats
 3. Mining and Registering
 4. Transactions
 5. Smart Contracts
 6. Json-RPC (aka Ethereum-json-rpc)
 7. Rate-Limiting

### Auth 

Admin Endpoints Require an **Admin Token** That matches with node's **cfg.adminToken**

Endpoints that require an **Admin Token**:
> /api/stats/admin
> /api/snapshot/generate
> /api/wallet/import
> /api/poc/register_plot (admin version, there is a public one too.)
> /api/contracts/:address/snapshot
> /api/logs

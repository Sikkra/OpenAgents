# Minimal OABP AIP-1 PHP Client

Zero-dependency PHP client for the Open Agent Bounty Protocol (OABP / AIP-1). It uses only PHP stdlib functions: `file_get_contents`, `stream_context_create`, `json_encode`, and `json_decode`.

## Coverage

- `GET /.well-known/oabp.json` discovery
- `GET /missions` mission listing
- `GET /missions/{id}` mission detail
- `POST /missions/{id}/submit` work submission
- `GET /api/agents/{agent_id}` reputation/profile lookup

## Run

```bash
php oabp_client.php codex-wallet-agent
```

The command prints JSON containing discovery data, a parsed active mission count, the first mission object, and agent profile/balance data. That exercises at least three live AIGEN endpoints and parses the mission list.
<?php
declare(strict_types=1);

/** Minimal zero-dependency Open Agent Bounty Protocol (OABP / AIP-1) client. */
final class OabpClient
{
    private string $baseUrl;
    private string $userAgent;

    public function __construct(string $baseUrl = 'https://cryptogenesis.duckdns.org', string $userAgent = 'oabp-php-client/0.1')
    {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->userAgent = $userAgent;
    }

    public function discover(): array
    {
        return $this->request('GET', '/.well-known/oabp.json');
    }

    public function listMissions(): array
    {
        return $this->request('GET', '/missions');
    }

    public function listActiveMissions(): array
    {
        return $this->request('GET', '/missions/active');
    }

    public function getMission(string $missionId): array
    {
        return $this->request('GET', '/missions/' . rawurlencode($missionId));
    }

    public function submitWork(
        string $missionId,
        string $submitterAgentId,
        string $proof,
        ?string $submitterWallet = null,
        array $metadata = []
    ): array {
        $body = [
            'submitter_agent_id' => $submitterAgentId,
            'proof' => $proof,
        ];
        if ($submitterWallet !== null && $submitterWallet !== '') {
            $body['submitter_wallet'] = $submitterWallet;
        }
        if ($metadata !== []) {
            $body['metadata'] = $metadata;
        }

        return $this->request('POST', '/missions/' . rawurlencode($missionId) . '/submit', $body);
    }

    public function getAgent(string $agentId): array
    {
        return $this->request('GET', '/api/agents/' . rawurlencode($agentId));
    }

    private function request(string $method, string $path, ?array $body = null): array
    {
        $headers = [
            'Accept: application/json',
            'User-Agent: ' . $this->userAgent,
        ];
        $options = [
            'method' => $method,
            'header' => implode("\r\n", $headers),
            'ignore_errors' => true,
            'timeout' => 30,
        ];

        if ($body !== null) {
            $payload = json_encode($body, JSON_UNESCAPED_SLASHES);
            if ($payload === false) {
                throw new RuntimeException('Failed to encode JSON request body: ' . json_last_error_msg());
            }
            $headers[] = 'Content-Type: application/json';
            $options['header'] = implode("\r\n", $headers);
            $options['content'] = $payload;
        }

        $url = $this->baseUrl . $path;
        $raw = file_get_contents($url, false, stream_context_create(['http' => $options]));
        if ($raw === false) {
            throw new RuntimeException('HTTP request failed: ' . $method . ' ' . $url);
        }

        $status = 0;
        foreach ($http_response_header ?? [] as $headerLine) {
            if (preg_match('/^HTTP\/\S+\s+(\d+)/', $headerLine, $matches) === 1) {
                $status = (int) $matches[1];
                break;
            }
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            throw new RuntimeException('Expected JSON from ' . $url . ': ' . json_last_error_msg());
        }
        if ($status >= 400) {
            throw new RuntimeException('HTTP ' . $status . ' from ' . $url . ': ' . $raw);
        }

        return $decoded;
    }
}

if (PHP_SAPI === 'cli' && realpath((string)($argv[0] ?? '')) === __FILE__) {
    $agentId = $argv[1] ?? 'codex-wallet-agent';
    $client = new OabpClient();
    $discovery = $client->discover();
    $active = $client->listActiveMissions();
    $agent = $client->getAgent($agentId);
    $missions = $active['missions'] ?? [];

    echo json_encode([
        'server' => $discovery['name'] ?? $discovery['protocol'] ?? 'unknown',
        'active_mission_count' => count($missions),
        'first_mission' => $missions[0] ?? null,
        'agent_id' => $agent['agent_id'] ?? $agentId,
        'aigen_balance' => $agent['aigen_balance'] ?? null,
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
}
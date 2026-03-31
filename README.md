# CargoWall GitHub Action
[![CI](https://github.com/code-cargo/cargowall-action/actions/workflows/test.yml/badge.svg)](https://github.com/code-cargo/cargowall-action/actions/workflows/test.yml)
[![Check dist](https://github.com/code-cargo/cargowall-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/code-cargo/cargowall-action/actions/workflows/check-dist.yml)
[![License](https://img.shields.io/github/license/code-cargo/cargowall-action)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/code-cargo/cargowall-action)](https://github.com/code-cargo/cargowall-action/releases)

The official GitHub Action for [CargoWall](https://github.com/code-cargo/cargowall) — an eBPF-based network firewall for GitHub Actions runners that monitors and controls outbound connections during CI/CD runs.

Secure your GitHub Actions workflows with eBPF-based network egress filtering. Prevent supply chain attacks, block data exfiltration, and control outbound connections at the kernel level.

For concepts, architecture, and platform capabilities, see the [main CargoWall repository](https://github.com/code-cargo/cargowall).

## Features

- **eBPF-based filtering**: Uses kernel-level filtering for high performance and reliability
- **Hostname filtering**: Allow/deny based on domain names
  - Subdomains are automatically allowed (i.e. `github.com` would also allow `api.github.com`)
- **CIDR filtering**: Allow/deny based on IP address ranges
- **DNS tunneling prevention**: Blocks DNS queries for non-allowed domains
- **Docker support**: Automatically configures Docker containers to respect firewall rules
- **Sudo lockdown**: Optionally restrict sudo access to prevent firewall bypass
- **Graceful degradation**: Warns and continues if eBPF is unavailable

## Quick Start

```yaml
- uses: code-cargo/cargowall-action@v1
  with:
    allowed-hosts: |
      github.com
      githubusercontent.com
      registry.npmjs.org
```

## Usage

### Basic Example

```yaml
name: Secure Build

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
      id-token: write
    steps:
      - uses: actions/checkout@v4

      - uses: code-cargo/cargowall-action@v1
        with:
          allowed-hosts: |
            githubusercontent.com
            registry.npmjs.org

      - run: npm ci
      - run: npm run build
      - run: npm test
```

> **Note:** The action connects to the [CodeCargo platform](https://www.codecargo.com) by default. For full integration, your job needs these permissions: `id-token: write` (OIDC authentication), `actions: read` (correlate network events to steps), and `contents: read`. If `id-token: write` is not granted, the action will warn and continue without API integration. Set `offline: true` to skip API communication entirely.

### With Docker Support

CargoWall automatically configures Docker to use its DNS proxy, so hostname filtering works inside containers:

```yaml
- uses: code-cargo/cargowall-action@v1
  with:
    allowed-hosts: |
      docker.io
      docker.com
      registry.npmjs.org

- name: Build Docker image
  run: docker build -t myapp .
```

### Audit Mode

Run in audit mode to log connections without blocking them — useful for understanding your workflow's network dependencies before enforcing rules:

```yaml
- uses: code-cargo/cargowall-action@v1
  with:
    mode: audit
    allowed-hosts: |
      githubusercontent.com
```

### With Sudo Lockdown (Maximum Security)

Enable sudo lockdown to prevent subsequent steps from disabling the firewall:

```yaml
- uses: code-cargo/cargowall-action@v1
  with:
    allowed-hosts: |
      archive.ubuntu.com
    sudo-lockdown: true
    sudo-allow-commands: |
      /usr/bin/apt-get
      /usr/bin/docker
```

### With Config File

For complex configurations, use a JSON or YAML config file:

```yaml
- uses: code-cargo/cargowall-action@v1
  with:
    config-file: .github/cargowall.json
```

**`.github/cargowall.json`**:
```json
{
  "rules": [
    { "type": "hostname", "value": "github.com", "action": "allow" },
    { "type": "hostname", "value": "registry.npmjs.org", "action": "allow" },
    { "type": "cidr", "value": "10.0.0.0/8", "ports": [443, 80], "action": "allow" }
  ]
}
```

## Inputs

| Input                        | Description                                                                       | Default                                        |
|------------------------------|-----------------------------------------------------------------------------------|------------------------------------------------|
| `mode`                       | Enforcement mode: `enforce` (block) or `audit` (log only)                         | `enforce`                                      |
| `allowed-hosts`              | Allowed hostnames, one per line (auto matches subdomains)                         |                                                |
| `allowed-cidrs`              | Allowed CIDR blocks, one per line                                                 |                                                |
| `github-service-hosts`       | GitHub service hostnames to auto-allow on port 443 (one per line)                 | See [defaults](#automatically-allowed-traffic) |
| `azure-infra-hosts`          | Azure infrastructure hostnames to auto-allow on port 443 (one per line)           | See [defaults](#automatically-allowed-traffic) |
| `config-file`                | Path to YAML/JSON config file for advanced rules                                  |                                                |
| `version`                    | CargoWall version to use                                                          | `latest`                                       |
| `fail-on-unsupported`        | Fail if eBPF not supported                                                        | `false`                                        |
| `sudo-lockdown`              | Enable sudo lockdown to prevent firewall bypass                                   | `false`                                        |
| `sudo-allow-commands`        | Command paths to allow via sudo when locked, one per line                         |                                                |
| `dns-upstream`               | Upstream DNS server (auto-detected if not set)                                    | auto-detect                                    |
| `allow-existing-connections` | Allow pre-existing TCP connections at startup                                     | `true`                                         |
| `binary-path`                | Path to a pre-built cargowall binary (skips download)                             |                                                |
| `debug`                      | Enable debug logging                                                              | `false`                                        |
| `audit-summary`              | Generate audit summary in workflow summary                                        | `true`                                         |
| `github-token`               | GitHub token for downloading the binary and fetching step timing in audit summary | `${{ github.token }}`                          |
| `include-prerelease`         | Include pre-release versions when resolving "latest"                              | `false`                                        |
| `api-url`                    | CodeCargo API URL for audit upload and policy fetch (policy requires GitHub App)   | `https://app.codecargo.com`                    |
| `offline`                    | Skip all CodeCargo API communication (audit upload and policy fetch)              | `false`                                        |

## Outputs

| Output      | Description                                      |
|-------------|--------------------------------------------------|
| `supported` | Whether eBPF firewall was successfully activated |
| `pid`       | Process ID of the running cargowall instance     |

## How It Works

1. **DNS Interception**: CargoWall runs a DNS proxy that intercepts all DNS queries
2. **JIT Rule Updates**: When a hostname is resolved, the resulting IPs are dynamically added to the firewall
3. **eBPF Filtering**: A TC (Traffic Control) eBPF program filters egress traffic based on destination IP and port
4. **Docker Integration**: Docker daemon is configured to use CargoWall's DNS proxy

```mermaid
flowchart LR
    subgraph runner["GitHub Actions Runner"]
        subgraph steps["Workflow Steps"]
            S1["npm ci / docker build / etc."]
        end

        subgraph cw["CargoWall"]
            DNS["DNS Proxy<br/>127.0.0.1:53"]
            BPF["TC eBPF<br/>on eth0"]
            Rules["Rule Engine"]
        end

        S1 -- "DNS query" --> DNS
        DNS -- "resolve & update rules" --> Rules
        Rules -- "allow/deny IPs" --> BPF
        S1 -- "network traffic" --> BPF
    end

    BPF -- "allowed" --> Internet(("Internet"))
    BPF -. "blocked" .-x Denied(("Denied"))
```

## Security Model

### What Gets Blocked

- **Direct IP connections**: Unless the IP is in an allowed CIDR
- **Hostname connections**: Unless the hostname matches an allowed pattern
- **DNS tunneling**: Queries for non-allowed domains are refused at the proxy

### What Gets Allowed

- Traffic to explicitly allowed hostnames and CIDR ranges
- Pre-existing TCP connections established before CargoWall starts (when `allow-existing-connections: true`, the default)

#### Automatically Allowed Traffic

CargoWall automatically allows certain traffic required for the runner and GitHub Actions to function.

**Infrastructure (hardcoded):**

| Traffic                             | Ports         | Why                                        |
|-------------------------------------|---------------|--------------------------------------------|
| Localhost (127.0.0.0/8, ::1)        | All           | Internal communication                     |
| Azure IMDS (169.254.169.254)        | 80            | Instance metadata on GitHub-hosted runners |
| DNS upstream server                 | 53            | Required for DNS resolution                |
| systemd-resolved upstreams          | 53, 80, 32526 | Runner DNS infrastructure                  |
| Docker bridge IP                    | 53            | DNS for containers                         |
| `ACTIONS_RUNTIME_URL` host          | 443           | GitHub Actions runtime                     |
| `ACTIONS_RESULTS_URL` host          | 443           | GitHub Actions results                     |
| `ACTIONS_CACHE_URL` host            | 443           | GitHub Actions cache                       |
| `ACTIONS_ID_TOKEN_REQUEST_URL` host | 443           | GitHub Actions OIDC token requests         |
| IPv6 multicast (ff00::/8)           | All           | Neighbor discovery, required for IPv6      |
| ICMPv6                              | All           | IPv6 neighbor discovery protocol           |

**GitHub service hostnames** (configurable via `github-service-hosts`):

| Hostname                            | Ports | Why                                    |
|-------------------------------------|-------|----------------------------------------|
| `github.com`                        | 443   | Git operations, API                    |
| `api.github.com`                    | 443   | GitHub REST/GraphQL API                |
| `githubapp.com`                     | 443   | GitHub Apps infrastructure             |
| `actions.githubusercontent.com`     | 443   | Actions artifact/cache/log services    |
| `github.githubassets.com`           | 443   | GitHub static assets                   |

**Azure infrastructure hostnames** (configurable via `azure-infra-hosts`):

| Hostname                | Ports | Why                                    |
|-------------------------|-------|----------------------------------------|
| `trafficmanager.net`    | 443   | Azure Traffic Manager (DNS routing)    |
| `blob.core.windows.net` | 443   | Azure Blob Storage (Actions artifacts) |

### Sudo Lockdown

When `sudo-lockdown: true`, sudo is restricted so that subsequent workflow steps cannot disable the firewall. You control which commands are still allowed via `sudo-allow-commands`:

```yaml
sudo-lockdown: true
sudo-allow-commands: |
  /usr/bin/apt-get
  /usr/bin/docker
```

With this configuration, `sudo apt-get install ...` and `sudo docker build ...` will work, but attempts to run `sudo iptables -F`, `sudo pkill cargowall`, or `sudo vim /etc/resolv.conf` will be blocked.

Sudo lockdown also removes the current user from the `docker` group. This is because Docker group membership grants the ability to run containers with root-level access, which could be used to bypass the firewall.

## Runner Compatibility

| Runner Type                   | eBPF Support | Notes                            |
|-------------------------------|--------------|----------------------------------|
| GitHub-hosted (ubuntu-latest) | Yes          | Full support with sudo           |
| GitHub-hosted (ubuntu-22.04)  | Yes          | Full support with sudo           |
| GitHub-hosted (ubuntu-24.04)  | Yes          | Full support with sudo           |
| Self-hosted Linux             | Yes          | Requires kernel 5.x+ and CAP_BPF |
| GitHub-hosted macOS           | No           | macOS doesn't support eBPF       |
| GitHub-hosted Windows         | No           | Windows doesn't support eBPF     |

## Troubleshooting

### eBPF not supported

If you see warnings about eBPF not being supported:

1. Ensure you're using a Linux runner (`ubuntu-latest`)
2. The action runs with `sudo` which is required for eBPF
3. Check kernel version with `uname -r` (need 5.x+)

### DNS resolution fails

If DNS queries are timing out:

1. Check that `dns-upstream` is reachable
2. Verify the allowed hosts include your required domains
3. Enable `debug: true` to see detailed logs

### Docker containers can't reach allowed hosts

1. Ensure Docker is running before the action
2. CargoWall automatically configures Docker DNS
3. Check `/etc/docker/daemon.json` was updated

## CodeCargo Platform

Don't want to manage policies in workflow YAML? Sign up for the [CodeCargo platform](https://www.codecargo.com) to create and assign CargoWall policies from a centralized dashboard — with hierarchical overrides at the org, repo, workflow, and job level. Just keep this action in your workflow and manage everything else from the UI.

## Documentation

* [CargoWall documentation](https://docs.codecargo.com/concepts/cargowall)
* [CargoWall repository](https://github.com/code-cargo/cargowall) — architecture, concepts, and how it works
* [CodeCargo platform](https://www.codecargo.com) — centralized policy management and enterprise features

## License

Apache 2.0 - See [LICENSE](LICENSE) for details.

## Contributing

This action is part of the [CodeCargo](https://github.com/code-cargo) project. Issues and PRs welcome!

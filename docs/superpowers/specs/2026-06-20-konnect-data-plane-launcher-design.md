# Konnect Data Plane Launcher Design

## Goal

Connect a new local Kong Gateway data plane to the existing Konnect control plane `local-kong-mtls-lab` without executing the generated Konnect command as shell code or exposing its private key in Docker environment metadata.

The existing PostgreSQL-backed Kong 3.9.1 lab remains running and unchanged. The Konnect data plane runs as a separate Kong Gateway 3.10 container.

## Scope

The implementation adds one dependency-free Node.js launcher and focused tests. It also ignores the generated credential directory in Git.

The launcher will:

1. Read the Konnect-generated Docker command from standard input as untrusted text.
2. Extract only an allowlisted set of Konnect environment values and the certificate/private-key PEM blocks.
3. Validate Kong hostnames, ports, PEM boundaries, and the expected `kong/kong-gateway:3.10` image.
4. Write credentials to `kong-local-lab/konnect-credentials/` with directory mode `0700` and file mode `0600`.
5. Invoke Docker directly with an argument array, never through a shell or `eval`.
6. Launch `kong-konnect-dp` on the existing `kong-local-lab_default` network.
7. Publish the proxy on host ports `8100` and `8543` to avoid the existing lab's ports.
8. Mount both Konnect cluster credentials and the existing local TLS/mTLS certificates read-only.

It will not migrate services/routes, modify the existing Kong container, install software, or delete/replace an existing container.

## Architecture

The launcher is `scripts/launch-konnect-dp.mjs` and has three isolated stages:

### Parse and validate

The parser treats stdin as data. It extracts these values only:

- `KONG_CLUSTER_CONTROL_PLANE`
- `KONG_CLUSTER_SERVER_NAME`
- `KONG_CLUSTER_TELEMETRY_ENDPOINT`
- `KONG_CLUSTER_TELEMETRY_SERVER_NAME`
- `KONG_CLUSTER_CERT`
- `KONG_CLUSTER_CERT_KEY`
- Docker image

Control-plane and telemetry values must use Kong's `*.konghq.com` endpoints, endpoint/server-name pairs must agree, and the image must be exactly `kong/kong-gateway:3.10`. Missing, duplicated, malformed, or unexpected values cause a failure before any files or containers are created.

### Persist credentials

The validated PEM blocks are written atomically under `kong-local-lab/konnect-credentials/`. The directory is already covered by `.gitignore`. The launcher applies restrictive permissions after each write and never prints PEM content.

### Launch without a shell

The launcher calls `docker run` with `spawnSync` and a fixed argument array. Dynamic values are inserted only after validation. The data plane uses:

- Container: `kong-konnect-dp`
- Network: `kong-local-lab_default`
- Image: `kong/kong-gateway:3.10`
- Ports: `8100:8000`, `8543:8443`
- Konnect credentials mounted at `/etc/kong/konnect:ro`
- Local TLS material mounted at `/etc/kong/certs:ro`
- Database off, role `data_plane`, PKI cluster mTLS, Konnect mode on
- Local HTTPS client-certificate verification matching the existing lab

The container is not automatically removed or replaced if the name already exists.

## Data Flow

```text
Konnect generated command (stdin)
        |
        v
allowlisted parser + validation
        |
        +--> protected cluster.crt / cluster.key
        |
        v
fixed Docker argument builder
        |
        v
docker run (no shell) --> Konnect control plane
        |
        +--> local proxy :8100 / :8543
        +--> existing mock-server via kong-local-lab_default
```

## Error Handling

The launcher exits nonzero with a concise message when:

- stdin is empty or required fields are absent;
- PEM data is malformed or duplicated;
- a hostname, endpoint pair, or image fails validation;
- credential directory/file creation fails;
- Docker is unavailable;
- `kong-konnect-dp` already exists;
- Docker cannot pull or start the image.

Errors must not include the raw input, certificate, or private key.

## Testing

Tests use Node's built-in test runner and synthetic PEM fixtures. Docker is not invoked by unit tests.

Required coverage:

- valid generated input produces the expected parsed configuration;
- Docker arguments contain credential file paths rather than PEM values;
- malformed or missing PEM blocks are rejected;
- non-Kong endpoints and unexpected images are rejected;
- shell-like extra text is ignored rather than executed;
- error messages do not contain private-key material.

After unit tests pass, verification runs the launcher with the real copied command, checks the container status/logs, confirms the node appears in Konnect, then creates or migrates the service and route in a separate step.

## Security Properties

- No `eval`, `sh -c`, `zsh -c`, or execution of clipboard/stdin text.
- No secrets in command-line arguments or Docker environment values.
- No secrets committed to Git or printed in logs.
- Read-only secret mounts and least-permissive practical filesystem modes.
- Fixed container name, network, image, ports, and mount destinations.


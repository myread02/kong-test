# Kong Local Lab

Local Kong Gateway lab using PostgreSQL database mode and Kong Manager.

## Services

| Component | URL / Port |
| --- | --- |
| Kong Manager | http://localhost:8002 |
| Admin API | http://localhost:8001 |
| Proxy HTTP | http://localhost:8005 |
| Proxy HTTPS | https://localhost:8443 |
| Postgres | localhost:5432 |

The proxy is exposed on host port `8005` because port `8000` was already used by another local Docker container. Inside Docker, Kong still listens on `8000`.

## Start

Install `mkcert` once so macOS and browsers trust the local development CA:

```bash
brew install mkcert nss
```

Generate local TLS and mTLS certificates from the repository root:

```bash
./scripts/generate-mtls-certs.sh
```

The script runs `mkcert -install`, creates a trusted `localhost` server certificate, and creates a private client CA/client certificate for mTLS. The generated files are written to `kong-local-lab/certs/` and are ignored by Git.

If `mkcert -install` asks for your macOS password, run the script in an interactive Terminal and approve the prompt.

```bash
cd kong-local-lab
docker compose up -d
```

Check status:

```bash
docker compose ps
curl -i http://localhost:8001/status
```

Open Kong Manager:

```bash
open http://localhost:8002
```

## Configure Test Route

Create a service pointing at httpbin:

```bash
curl -i -X PUT http://localhost:8001/services/mock-backend \
  --data 'url=https://httpbin.org'
```

Create a route for `/api/v1`:

```bash
curl -i -X PUT http://localhost:8001/services/mock-backend/routes/test-route \
  --data 'paths[]=/api/v1' \
  --data 'protocols[]=http' \
  --data 'protocols[]=https'
```

Verify the HTTP proxy:

```bash
curl -i http://localhost:8005/api/v1/anything
```

Expected result: `200 OK` from httpbin through Kong. If httpbin is temporarily unavailable, the response may be an upstream `503`, but Kong should still include `Via: 1.1 kong/3.9.1`.

Verify the HTTPS proxy with mTLS from the repository root:

```bash
./scripts/test-mtls-local.sh
```

The HTTPS proxy on `https://localhost:8443` uses a `mkcert` server certificate and requires a client certificate signed by `kong-local-lab/certs/client-ca.crt`. A request without a client certificate should fail. A request with the generated client certificate should reach Kong:

```bash
curl --cacert kong-local-lab/certs/localhost.crt \
  --cert kong-local-lab/certs/client.crt \
  --key kong-local-lab/certs/client.key \
  -i https://localhost:8443/api/v1/anything
```

Export the client certificate as a macOS-importable `.p12` file and open it to add it to Keychain Access:

```bash
openssl pkcs12 -export \
  -out kong-local-lab/certs/client.p12 \
  -inkey kong-local-lab/certs/client.key \
  -in kong-local-lab/certs/client.crt \
  -certfile kong-local-lab/certs/client-ca.crt \
  -name "Kong Local Client"

open kong-local-lab/certs/client.p12
```

## Postman OpenAPI Test API

Import this file into Postman:

```text
openapi/kong-local-test-api.yaml
```

Configure Kong to echo all `/api/v1/*` test requests through httpbin:

```bash
./scripts/configure-openapi-test-route.sh
```

The imported collection includes sample login, logout, profile, posts, and random-data requests. The HTTPS server URL requires the local mTLS client certificate. In Postman, add a client certificate for host `localhost` and port `8443`:

| Field | Value |
| --- | --- |
| CRT file | `kong-local-lab/certs/client.crt` |
| KEY file | `kong-local-lab/certs/client.key` |
| Passphrase | leave empty |

For a quick test without mTLS, select the `http://localhost:8005/api/v1` server in Postman.

## Rate Limit Plugin

Enable route-scoped rate limiting at 3 requests per minute:

```bash
curl -i -X POST http://localhost:8001/routes/test-route/plugins \
  --data 'name=rate-limiting' \
  --data 'config.minute=3' \
  --data 'config.policy=local'
```

Verify enforcement:

```bash
for i in 1 2 3 4; do
  curl -sS -o /dev/null -w "try ${i}: %{http_code}\n" \
    http://localhost:8005/api/v1/anything
done
```

Expected result: after the quota is consumed, Kong returns `429`.

## Stop And Reset

Stop containers while keeping the database volume:

```bash
docker compose down
```

Delete containers and the Postgres volume for a clean reset:

```bash
docker compose down -v
```

## Notes

If Docker image pulls hang at credential lookup, use a temporary Docker config without the Desktop credential helper for public image pulls:

```bash
mkdir -p .docker-nocreds
printf '{ "auths": {} }\n' > .docker-nocreds/config.json
DOCKER_CONFIG="$PWD/.docker-nocreds" docker pull postgres:15-alpine
DOCKER_CONFIG="$PWD/.docker-nocreds" docker pull kong:3.9.1
```

The `.docker-nocreds/` directory is ignored by Git.

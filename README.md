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

Create a service pointing at the stable httpbun mock backend:

```bash
curl -i -X PUT http://localhost:8001/services/mock-backend \
  --data 'url=https://httpbun.com/anything'
```

Create a route for `/api/v1` with `strip_path=true` (this strips `/api/v1` from the path and appends the rest to the backend service path):

```bash
curl -i -X PUT http://localhost:8001/services/mock-backend/routes/test-route \
  --data 'paths[]=/api/v1' \
  --data 'protocols[]=http' \
  --data 'protocols[]=https' \
  --data 'strip_path=true'
```

Verify the HTTP proxy (which bypasses mTLS):

```bash
curl -i http://localhost:8005/api/v1/anything
```

Expected result: `200 OK` from httpbun through Kong gateway.

---

## Certificates and Mutual TLS (mTLS)

A digital certificate is an X.509 document that binds an identity to a public key. TLS normally uses a server certificate so the client can authenticate the server and establish an encrypted connection. Mutual TLS adds client authentication: the server also requests a client certificate and verifies it against a trusted client certificate authority (CA).

This lab generates the following files:

| File | Purpose | Secret? |
| --- | --- | --- |
| `localhost.crt` | Server certificate presented by Kong | No |
| `localhost.key` | Private key for the Kong server certificate | **Yes** |
| `client-ca.crt` | CA certificate Kong trusts when checking clients | No |
| `client-ca.key` | CA private key used to issue client certificates | **Yes; most sensitive file** |
| `client.crt` | Client identity presented to Kong | No |
| `client.key` | Private key proving ownership of the client certificate | **Yes** |

Never commit or send private keys through unencrypted channels. The entire `kong-local-lab/certs/` directory is ignored by Git because it contains local credentials.

### How mTLS Is Enabled in This Kong OSS Lab

The `kong:3.9.1` image is Kong Gateway OSS. The current `docker-compose.yml` uses Kong's Nginx configuration injection to enforce client-certificate verification:

```yaml
KONG_SSL_CERT: /etc/kong/certs/localhost.crt
KONG_SSL_CERT_KEY: /etc/kong/certs/localhost.key
KONG_NGINX_PROXY_SSL_CLIENT_CERTIFICATE: /etc/kong/certs/client-ca.crt
KONG_NGINX_PROXY_SSL_VERIFY_CLIENT: "on"
KONG_NGINX_PROXY_SSL_VERIFY_DEPTH: "2"
```

This applies mTLS to the **entire HTTPS proxy listener on port `8443`**, not to one Kong Service or Route. The HTTP proxy on port `8005` does not use TLS and therefore bypasses mTLS.

The certificate files must exist before the Kong container starts so Docker can mount them read-only at `/etc/kong/certs`:

```bash
./scripts/generate-mtls-certs.sh
docker compose -f kong-local-lab/docker-compose.yml up -d
```

If Docker created an empty, root-owned `kong-local-lab/certs/` directory before certificate generation, stop the lab, remove only that empty directory, generate the certificates, and start again. Do not use `docker compose down -v` for this correction unless you intentionally want to delete the PostgreSQL data volume.

### Route- or Service-Specific mTLS

Kong's [Mutual TLS Authentication](https://developer.konghq.com/plugins/mtls-auth/) and [TLS Handshake Modifier](https://developer.konghq.com/plugins/tls-handshake-modifier/) plugins are Enterprise-tier and are not included in `kong:3.9.1` OSS. TLS Handshake Modifier only requests a client certificate; it does not validate the certificate by itself.

Check plugin availability before trying to configure it:

```bash
curl -s http://localhost:8001/plugins/enabled
curl -i http://localhost:8001/schemas/plugins/mtls-auth
```

For this OSS image, `mtls-auth` will not appear in the enabled plugin list and its schema request will return `404`. If route- or Service-specific mTLS is required with an OSS stack, use a dedicated Kong listener/instance for the protected APIs or terminate and validate mTLS in an external Nginx, HAProxy, or Envoy proxy.

#### Nginx-Level mTLS (OSS) vs. Enterprise mtls-auth Plugin

Why do local tests (`./scripts/test-mtls-local.sh`) pass on the OSS image even though the `mtls-auth` plugin is missing?

* **Nginx-Level mTLS (OSS):** In `docker-compose.yml`, Kong's Nginx template is configured via `KONG_NGINX_PROXY_SSL_*` environment variables. Nginx terminates TLS on port `8443`, requests the client cert, and validates it using `client-ca.crt` at the network/socket layer. Because it is handled by the underlying Nginx engine, it is free, OSS-compatible, and successfully passes the `curl` verification test. However, it applies to the **entire HTTPS listener** globally and does not map certificates to Kong Consumers.
* **Enterprise `mtls-auth` Plugin:** Enables granular mTLS configuration per Service, Route, or Consumer. It extracts the certificate's Common Name (CN) or Subject Alternative Name (SAN) and maps it to a Kong Consumer for authorization, rate limiting, and other policy rules, but requires an Enterprise license.

| Feature | Nginx-Level mTLS (OSS) | Enterprise `mtls-auth` Plugin |
| --- | --- | --- |
| **Availability** | Available in Kong OSS (Community) | Kong Enterprise Only (requires license) |
| **Granularity** | Global (entire port/listener) | Granular (per Service, Route, or Consumer) |
| **Authentication** | Validates CA certificate validity | Maps certificate fields (CN/SAN) to Kong Consumers |
| **Configuration** | Static via environment variables / Nginx template | Dynamic via Admin API |

#### Enterprise-only Admin API example

On a licensed Kong Gateway edition that includes `mtls-auth`, first upload the trusted client CA and note its returned `id`:

```bash
curl -i -X POST http://localhost:8001/ca_certificates \
  -F "cert=@kong-local-lab/certs/client-ca.crt"
```

Then apply the plugin to the Service using the documented `config.ca_certificates` field:

```bash
curl -i -X POST http://localhost:8001/services/mock-backend/plugins \
  --data 'name=mtls-auth' \
  --data 'config.ca_certificates[]=<ca-certificate-id>'
```

Do not configure `config.anonymous` when strict client-certificate enforcement is required; that option allows authentication failures to fall back to an anonymous Consumer. Uploading a server certificate to `/certificates` only configures TLS certificates and SNIs. It does not enable client-certificate validation.

### Verify mTLS

Run the automated check from the repository root:

```bash
./scripts/test-mtls-local.sh
```

For a manual request, trust the local `mkcert` root CA and present the generated client identity:

```bash
SERVER_CA="$(mkcert -CAROOT)/rootCA.pem"

curl --cacert "$SERVER_CA" \
  --cert kong-local-lab/certs/client.crt \
  --key kong-local-lab/certs/client.key \
  -i https://localhost:8443/api/v1/anything
```

If `test-route` exists, the expected result is `200 OK`. Without a matching Route, any nonzero HTTP response still proves that the TLS handshake reached Kong; use the response status and Kong logs to diagnose routing separately.

### Import the Client Certificate into macOS Keychain

Export the client identity as PKCS#12 and import it into Keychain Access when a browser or GUI client needs to present it:

```bash
openssl pkcs12 -export \
  -out kong-local-lab/certs/client.p12 \
  -inkey kong-local-lab/certs/client.key \
  -in kong-local-lab/certs/client.crt \
  -certfile kong-local-lab/certs/client-ca.crt \
  -name "Kong Local Client"

open kong-local-lab/certs/client.p12
```

The `.p12` file contains the client private key. Protect it like the original `client.key` and remove it when it is no longer needed.

### Troubleshoot mTLS

Inspect certificate identity, validity, server hostname SANs, and client extended key usage:

```bash
openssl x509 -in kong-local-lab/certs/localhost.crt \
  -noout -subject -issuer -dates

openssl x509 -in kong-local-lab/certs/localhost.crt -noout -text \
  | sed -n '/Subject Alternative Name/{n;p;}'

openssl x509 -in kong-local-lab/certs/client.crt \
  -noout -subject -issuer -dates

openssl x509 -in kong-local-lab/certs/client.crt -noout -text \
  | sed -n '/Extended Key Usage/{n;p;}'

openssl verify \
  -CAfile kong-local-lab/certs/client-ca.crt \
  kong-local-lab/certs/client.crt
```

The server certificate must contain `localhost` in its SANs. The client certificate must be unexpired and contain the `TLS Web Client Authentication`/`clientAuth` usage. This lab's client certificate does not require a SAN because Nginx validates its issuing CA rather than mapping a SAN to a Kong Consumer.

Check the rendered Compose configuration, container status, certificate mount, and startup logs:

```bash
docker compose -f kong-local-lab/docker-compose.yml config
docker compose -f kong-local-lab/docker-compose.yml ps
docker compose -f kong-local-lab/docker-compose.yml exec kong ls -l /etc/kong/certs
docker compose -f kong-local-lab/docker-compose.yml logs --tail=200 kong
```

Check that Kong received the mTLS-related settings and rendered them into its Nginx configuration:

```bash
docker compose -f kong-local-lab/docker-compose.yml exec kong sh -lc \
  'env | sort | grep -E "^(KONG_PROXY_LISTEN|KONG_.*SSL)"'

docker compose -f kong-local-lab/docker-compose.yml exec kong sh -lc \
  'grep -n "ssl_certificate\|ssl_client_certificate\|ssl_verify_client\|ssl_verify_depth" /usr/local/kong/nginx-kong.conf'
```

The running container should show these effective settings:

| Setting | Expected value | Failure mode |
| --- | --- | --- |
| `KONG_PROXY_LISTEN` | Includes `0.0.0.0:8443 ssl` | Port `8443` does not accept TLS |
| `KONG_SSL_CERT` | `/etc/kong/certs/localhost.crt` | Kong cannot load the server certificate |
| `KONG_SSL_CERT_KEY` | `/etc/kong/certs/localhost.key` | Kong cannot load the server private key |
| `KONG_NGINX_PROXY_SSL_CLIENT_CERTIFICATE` | `/etc/kong/certs/client-ca.crt` | Client certificates are rejected or not checked against the intended CA |
| `KONG_NGINX_PROXY_SSL_VERIFY_CLIENT` | `on` | Missing or `off` means mTLS is not enforced |
| `KONG_NGINX_PROXY_SSL_VERIFY_DEPTH` | `2` | Certificate chains may fail when the depth is too low |

After changing any `KONG_*` environment value or replacing certificate files, recreate the Kong container so Nginx is regenerated:

```bash
docker compose -f kong-local-lab/docker-compose.yml up -d \
  --force-recreate kong
```

When Kong is misconfigured, the startup and request logs usually identify the layer that failed:

| Log symptom | Likely cause |
| --- | --- |
| `no such file` for `/etc/kong/certs/...` | Certificate path in `docker-compose.yml` does not match the mounted files |
| `Permission denied` while reading a key or certificate | File permissions or ownership prevent the container from reading the mounted file |
| `PEM_read_bio` or `bad end line` | A certificate or key file is malformed or truncated |
| `key values mismatch` | `localhost.crt` and `localhost.key` are not a matching pair |
| `client SSL certificate verify error` | The client cert is expired, signed by another CA, or the wrong `client-ca.crt` is configured |

Inspect the TLS handshake directly:

```bash
SERVER_CA="$(mkcert -CAROOT)/rootCA.pem"

curl -v --cacert "$SERVER_CA" https://localhost:8443/

openssl s_client \
  -connect localhost:8443 \
  -servername localhost \
  -CAfile "$SERVER_CA" \
  -cert kong-local-lab/certs/client.crt \
  -key kong-local-lab/certs/client.key \
  -verify_return_error -state
```

Expected results:

| Test | Expected result |
| --- | --- |
| No client certificate | Kong's Nginx layer rejects the request, normally with HTTP `400` |
| Trusted client certificate | TLS succeeds and Kong handles the HTTP request |
| Certificate signed by another CA | TLS/client verification fails |
| Expired client or server certificate | Certificate verification fails |
| Valid TLS but `404` response | mTLS worked; configure or correct the Kong Route |

---

## Postman & Newman Settings

### 1. Import Postman Collection
Import the pre-generated Postman Collection file directly into Postman:
- File path: `openapi/kong-local-test-collection.json`

This collection is pre-populated with all the requests and their robust test scripts.

*(Optional) If you modify `openapi/kong-local-test-api.json` and want to regenerate the collection, run:*
```bash
npx openapi-to-postmanv2 -s openapi/kong-local-test-api.json -o openapi/kong-local-test-collection.json
node scripts/inject-postman-tests.js
```

### 2. Configure Client Certificates in Postman
Because HTTPS port `8443` requires mTLS, you must add the client certificate in Postman:
1. Open **Postman Settings** (Gear icon in top right -> Settings).
2. Go to the **Certificates** tab.
3. Click **Add Certificate** under *Client Certificates* and configure:
   - **Host**: `localhost`
   - **Port**: `8443`
   - **CRT file**: Select `kong-local-lab/certs/client.crt`
   - **KEY file**: Select `kong-local-lab/certs/client.key`
   - **Passphrase**: *Leave blank*
4. Click **Add**. Now, Postman will automatically attach the client certificates when querying `https://localhost:8443`.

*Alternatively, to bypass mTLS completely, you can select the `http://localhost:8005/api/v1` server variable/environment in Postman.*

### 3. Automated Test Scripts
We have embedded `x-postman-test-script` extensions directly into the OpenAPI YAML/JSON specs. When you import them into Postman, it automatically populates the **Tests** tab of the requests with the following scripts:
- Status code assertions (e.g., checks for `200 OK`, `201 Created`, or `204 No Content`).
- Automatic environment caching of the authentication `accessToken` from the login response, and cache cleanup upon logout.

---

## Rate-Limiting Settings

Kong allows you to enforce rate limits at the route level to prevent service abuse.

### 1. Enable Rate-Limiting (e.g., 3 requests per minute)
To enable route-scoped rate limiting:

```bash
curl -i -X POST http://localhost:8001/routes/test-route/plugins \
  --data 'name=rate-limiting' \
  --data 'config.minute=3' \
  --data 'config.policy=local'
```

### 2. Check / List Active Plugins
To see all active plugins configured on your Kong gateway, run:

```bash
curl -s http://localhost:8001/plugins
```

Locate the `id` of your rate-limiting plugin in the JSON output.

### 3. Delete / Disable Rate-Limiting
When running a Postman collection containing multiple requests sequentially, a low rate limit (like 3 req/min) will cause subsequent requests to fail with a `429 API rate limit exceeded` status code.

To disable or remove the rate limit, use the plugin's UUID (`<plugin-id>`) retrieved from the step above:

```bash
curl -i -X DELETE http://localhost:8001/plugins/<plugin-id>
```

## Logs, Traces, and Metrics

Logs, distributed traces, and metrics answer different questions. Logs record events and request details, traces follow one request across components, and metrics provide numeric time-series data such as request rates and latency.

### Follow Kong Logs Locally

Kong container logs are available through Docker Compose:

```bash
docker compose -f kong-local-lab/docker-compose.yml logs \
  -f --tail=200 --timestamps kong
```

Limit the output to a recent time window when investigating a failure:

```bash
docker compose -f kong-local-lab/docker-compose.yml logs \
  --since=10m --timestamps kong
```

Kong includes an `X-Kong-Request-Id` response header. Copy that value from `curl -i` output and find the corresponding request or error:

```bash
docker compose -f kong-local-lab/docker-compose.yml logs kong \
  | grep '<request-id>'
```

A TLS handshake can fail before Kong creates an HTTP request ID. For those failures, reproduce the request while following the logs and search for certificate or SSL errors instead.

For temporary deep diagnostics, add `KONG_LOG_LEVEL: debug` to the `kong` service environment and recreate that container:

```bash
docker compose -f kong-local-lab/docker-compose.yml up -d \
  --force-recreate kong
```

Debug logging is verbose and can expose additional request context. Remove the setting and recreate the container after diagnosis.

### Structured Request Logs with File Log

The free File Log plugin writes one JSON object per request. In a container, write to `/dev/stdout` so Docker captures the output:

```bash
curl -i -X POST http://localhost:8001/plugins \
  --data 'name=file-log' \
  --data 'config.path=/dev/stdout'
```

The correct field is `config.path`, not `config.config.path`. Writing to a physical path such as `/var/log/kong/custom_access.log` requires a writable persistent volume; otherwise the file is lost when the container is replaced. The File Log plugin uses blocking file I/O and produces logs only—it does not generate Jaeger, Zipkin, or OpenTelemetry traces.

### Free Open-Source Observability Options

| Signal | Collector / shipper | Storage and UI | Kong integration |
| --- | --- | --- | --- |
| Logs | Vector, Fluent Bit, or Grafana Alloy | Grafana Loki + Grafana, or OpenSearch + OpenSearch Dashboards | Docker stdout/stderr or a Kong logging plugin |
| Traces | OpenTelemetry Collector | Jaeger or Grafana Tempo | Kong OpenTelemetry plugin; alternatively use Kong Zipkin with Zipkin |
| Metrics | Prometheus | Prometheus + Grafana | Kong Prometheus plugin |

For distributed tracing on Kong 3.9.1, enable the free OpenTelemetry plugin and send OTLP data to an OpenTelemetry Collector or compatible backend. A collector is preferable when data needs batching, filtering, enrichment, or routing to more than one backend. See the [Kong OpenTelemetry plugin documentation](https://developer.konghq.com/plugins/opentelemetry/) and [Kong logging reference](https://developer.konghq.com/gateway/logs/).

## Move, Copy, Backup, and Restore

A complete, recoverable backup has three independent layers:

1. **Repository files:** `docker-compose.yml`, scripts, OpenAPI files, and this README.
2. **Certificate material:** generated files in `kong-local-lab/certs/`, which Git intentionally ignores.
3. **Kong state:** Services, Routes, plugins, certificates, and other entities stored in PostgreSQL in the `pgdata` Docker volume.

Backing up only the Git repository does not preserve certificates or Kong's database state.

### Copy the Repository

Prefer cloning from the Git remote on the destination machine:

```bash
git clone <repository-url> kong-test
cd kong-test
```

If no remote is available, copy the source tree with `rsync`. Transfer certificates and the database dump separately:

```bash
rsync -a \
  --exclude='.git' \
  --exclude='.DS_Store' \
  --exclude='kong-local-lab/.docker-nocreds' \
  --exclude='kong-local-lab/certs' \
  /path/to/kong-test/ user@destination:/path/to/kong-test/
```

Docker's named `pgdata` volume is not stored inside this source tree.

### Back Up PostgreSQL

Run a logical backup while the current database container is healthy. Store the dump outside the Git repository:

```bash
mkdir -p ../kong-test-backup

docker compose -f kong-local-lab/docker-compose.yml exec -T kong-database \
  pg_dump -U kong -d kong -Fc --no-owner --no-acl \
  > ../kong-test-backup/kong.dump
```

Verify that PostgreSQL can read the custom-format archive:

```bash
docker compose -f kong-local-lab/docker-compose.yml exec -T kong-database \
  pg_restore -l < ../kong-test-backup/kong.dump
```

Do not copy the raw files of a running PostgreSQL Docker volume. A logical `pg_dump` is portable and consistent. `docker compose down -v` permanently deletes the `pgdata` volume and must not be used until the backup has been verified.

### Back Up Certificates Securely

For ordinary local development, the preferred destination setup is to generate fresh certificates with `./scripts/generate-mtls-certs.sh`. This creates a server certificate trusted by the destination machine's `mkcert` CA.

If existing client identities must be preserved, back up the certificate directory with encryption. The following example uses the open-source `age` tool and prompts for a passphrase:

```bash
brew install age

tar -C kong-local-lab -czf - certs \
  | age -p -o ../kong-test-backup/kong-certs.tar.gz.age

chmod 600 ../kong-test-backup/kong-certs.tar.gz.age
```

The encrypted archive includes server and client private keys plus the client CA private key. Store its passphrase separately. Copying only `localhost.crt` does not make another machine trust the source machine's `mkcert` CA.

### Restore on Another Machine

Restore into the same Kong (`3.9.1`) and PostgreSQL (`15`) versions first. Upgrade only after the restored lab works.

1. Clone or copy the repository.
2. Choose one certificate strategy:
   - For new local identities, run `./scripts/generate-mtls-certs.sh` and do not restore the certificate archive.
   - To preserve client identities, install the destination `mkcert` CA, restore the encrypted archive, and regenerate only the server certificate for the destination machine:

   ```bash
   brew install mkcert nss age
   mkcert -install

   age -d /path/to/kong-certs.tar.gz.age \
     | tar -xzf - -C kong-local-lab

   mkcert \
     -cert-file kong-local-lab/certs/localhost.crt \
     -key-file kong-local-lab/certs/localhost.key \
     localhost 127.0.0.1 ::1

   chmod 600 kong-local-lab/certs/*.key
   ```

   This keeps `client-ca.crt`, `client-ca.key`, `client.crt`, and `client.key`, while replacing the server identity with one trusted on the destination.

3. Start the empty lab once so PostgreSQL and Kong initialize normally:

   ```bash
   docker compose -f kong-local-lab/docker-compose.yml up -d
   curl -i http://localhost:8001/status
   ```

4. Stop Kong to close its database connections while leaving PostgreSQL running:

   ```bash
   docker compose -f kong-local-lab/docker-compose.yml stop kong
   ```

5. Restore the logical dump:

   ```bash
   docker compose -f kong-local-lab/docker-compose.yml exec -T kong-database \
     pg_restore -U kong -d kong --clean --if-exists \
     --no-owner --no-acl --exit-on-error \
     < /path/to/kong.dump
   ```

6. Restart Kong and verify the restored state:

   ```bash
   docker compose -f kong-local-lab/docker-compose.yml start kong

   curl -i http://localhost:8001/status
   curl -s http://localhost:8001/services
   curl -s http://localhost:8001/routes
   curl -s http://localhost:8001/plugins
   docker compose -f kong-local-lab/docker-compose.yml logs --tail=100 kong
   ./scripts/test-mtls-local.sh
   ```

Keep the database dump and certificate archive until all health, configuration, routing, logging, and mTLS checks pass on the destination.

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

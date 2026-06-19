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

## Mutual TLS (mTLS) Setting

By default, Kong is configured to verify client SSL certificates on the HTTPS proxy port `8443`. This is enabled in the `docker-compose.yml` file via:
- `KONG_NGINX_PROXY_SSL_VERIFY_CLIENT: "on"`
- `KONG_NGINX_PROXY_SSL_CLIENT_CERTIFICATE: "/etc/kong/certs/client-ca.crt"`

If you request `https://localhost:8443` without presenting a client certificate signed by that CA, Nginx will reject the connection with a `400 Bad Request` (`400 No required SSL certificate was sent`).

### 1. How to Generate and Mount Certificates (Container Activation)

To activate mTLS and HTTPS, the certificate files must exist on the host before the Docker containers are started. If you start Docker first, Docker will automatically create an empty `certs/` directory on the host owned by `root`, which will block your certificate generation script and cause Kong gateway startup to fail.

To activate correctly:
1. **Clean up any bad setup (if you ran `docker compose up` first):**
   ```bash
   cd kong-local-lab
   docker compose down -v
   # Remove empty certs folder if created by root
   sudo rm -rf certs
   ```
2. **Generate the certificates from the repository root:**
   ```bash
   ./scripts/generate-mtls-certs.sh
   ```
3. **Start the containers to mount the files and activate the gateway:**
   ```bash
   cd kong-local-lab
   docker compose up -d
   ```

### 2. Dynamic Certificate Activation via Kong Admin API

If you are using Kong's database-backed mode and want to dynamically register and manage certificates in the database rather than pinning them to container configuration files, use the Kong Admin API:

#### A. Activate Server Certificates (for Custom SNIs)
To dynamically upload and activate your server SSL certificate/key for SNIs like `localhost`:
```bash
curl -i -X POST http://localhost:8001/certificates \
  -F "cert=@kong-local-lab/certs/localhost.crt" \
  -F "key=@kong-local-lab/certs/localhost.key" \
  -F "snis[]=localhost"
```

#### B. Activate CA Certificates (to Trust Client CAs)
To dynamically register your client Certificate Authority (CA) in Kong's database:
```bash
curl -i -X POST http://localhost:8001/ca_certificates \
  -F "cert=@kong-local-lab/certs/client-ca.crt"
```
*Note the returned JSON `id` of the CA certificate. You will need it to configure routes or plugins.*

#### C. Activate the mTLS Authentication (`mtls-auth`) Plugin on a Route
To enforce client-certificate-based authentication dynamically on a specific route (e.g., `test-route`) using the registered CA certificate:
```bash
curl -i -X POST http://localhost:8001/routes/test-route/plugins \
  --data "name=mtls-auth" \
  --data "config.ca_certificates[]=<ca-certificate-uuid>"
```

### 3. Verify mTLS with Curl
To verify that mTLS works locally, run:

```bash
./scripts/test-mtls-local.sh
```

Or run the manual curl command:

```bash
curl --cacert kong-local-lab/certs/localhost.crt \
  --cert kong-local-lab/certs/client.crt \
  --key kong-local-lab/certs/client.key \
  -i https://localhost:8443/api/v1/anything
```

### Import Certificate into macOS Keychain
To make macOS and browsers trust the client certificate:
1. Export the client certificate as a `.p12` file:
   ```bash
   openssl pkcs12 -export \
     -out kong-local-lab/certs/client.p12 \
     -inkey kong-local-lab/certs/client.key \
     -in kong-local-lab/certs/client.crt \
     -certfile kong-local-lab/certs/client-ca.crt \
     -name "Kong Local Client"
   ```
2. Double-click the generated `kong-local-lab/certs/client.p12` file (or run `open kong-local-lab/certs/client.p12`) to import it into your Keychain Access.

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

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT_DIR/kong-local-lab/certs"
HTTPS_URL="${HTTPS_URL:-https://localhost:8443/}"

SERVER_CA="$CERT_DIR/localhost.crt"
CLIENT_CERT="$CERT_DIR/client.crt"
CLIENT_KEY="$CERT_DIR/client.key"

for file in "$SERVER_CA" "$CLIENT_CERT" "$CLIENT_KEY"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing required certificate file: $file" >&2
    echo "Run ./scripts/generate-mtls-certs.sh first." >&2
    exit 1
  fi
done

echo "Checking that HTTPS without a client cert is rejected..."
set +e
no_client_output="$(
  curl --cacert "$SERVER_CA" \
    -sS -o /dev/null \
    -w "http_code=%{http_code} ssl_verify_result=%{ssl_verify_result}" \
    "$HTTPS_URL" 2>&1
)"
no_client_status=$?
set -e

if [[ "$no_client_status" -eq 0 && "$no_client_output" != *"http_code=400"* && "$no_client_output" != *"http_code=403"* ]]; then
  echo "Expected request without a client certificate to fail, but it succeeded:" >&2
  echo "$no_client_output" >&2
  exit 1
fi

echo "Checking that HTTPS with the trusted client cert is accepted..."
with_client_output="$(
  curl --cacert "$SERVER_CA" \
    --cert "$CLIENT_CERT" \
    --key "$CLIENT_KEY" \
    -sS -o /dev/null \
    -w "http_code=%{http_code} ssl_verify_result=%{ssl_verify_result}" \
    "$HTTPS_URL"
)"

if [[ "$with_client_output" != *"ssl_verify_result=0"* ]]; then
  echo "Expected request with client certificate to verify the server cert:" >&2
  echo "$with_client_output" >&2
  exit 1
fi

if [[ "$with_client_output" == *"http_code=000"* ]]; then
  echo "Expected request with client certificate to reach Kong:" >&2
  echo "$with_client_output" >&2
  exit 1
fi

echo "mTLS local test passed: $with_client_output"

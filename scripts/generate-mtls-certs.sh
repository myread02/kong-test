#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT_DIR/kong-local-lab/certs"
CLIENT_EXT="$(mktemp "${TMPDIR:-/tmp}/kong-client-ext.XXXXXX")"

cleanup() {
  rm -f "$CLIENT_EXT"
}
trap cleanup EXIT

mkdir -p "$CERT_DIR"

openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -keyout "$CERT_DIR/localhost.key" \
  -out "$CERT_DIR/localhost.crt" \
  -subj /CN=localhost \
  -addext subjectAltName=DNS:localhost,IP:127.0.0.1

openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -keyout "$CERT_DIR/client-ca.key" \
  -out "$CERT_DIR/client-ca.crt" \
  -subj /CN=kong-local-client-ca

openssl req -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/client.key" \
  -out "$CERT_DIR/client.csr" \
  -subj /CN=kong-local-client

printf 'extendedKeyUsage=clientAuth\n' > "$CLIENT_EXT"

openssl x509 -req \
  -in "$CERT_DIR/client.csr" \
  -CA "$CERT_DIR/client-ca.crt" \
  -CAkey "$CERT_DIR/client-ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/client.crt" \
  -days 365 \
  -sha256 \
  -extfile "$CLIENT_EXT"

chmod 600 "$CERT_DIR"/*.key

echo "Generated local mTLS files in $CERT_DIR"

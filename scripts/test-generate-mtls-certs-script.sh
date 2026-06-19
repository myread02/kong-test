#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/generate-mtls-certs.sh"

assert_contains() {
  local expected="$1"

  if ! grep -Fq -- "$expected" "$SCRIPT"; then
    echo "Expected $SCRIPT to contain: $expected" >&2
    exit 1
  fi
}

assert_contains 'command -v mkcert'
assert_contains 'mkcert -install'
assert_contains 'mkcert -cert-file "$CERT_DIR/localhost.crt"'
assert_contains 'localhost 127.0.0.1 ::1'

echo "generate-mtls-certs mkcert checks passed"

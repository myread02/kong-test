#!/usr/bin/env bash
set -euo pipefail

ADMIN_API="${ADMIN_API:-http://localhost:8001}"

echo "Configuring Kong service mock-backend..."
curl -sS -o /dev/null -w "service http_code=%{http_code}\n" \
  -X PUT "$ADMIN_API/services/mock-backend" \
  --data 'url=https://httpbin.org/anything'

echo "Configuring Kong route test-route for /api/v1..."
curl -sS -o /dev/null -w "route http_code=%{http_code}\n" \
  -X PUT "$ADMIN_API/services/mock-backend/routes/test-route" \
  --data 'paths[]=/api/v1' \
  --data 'protocols[]=http' \
  --data 'protocols[]=https' \
  --data 'strip_path=true'

echo "OpenAPI test route is ready at http://localhost:8005/api/v1 and https://localhost:8443/api/v1"

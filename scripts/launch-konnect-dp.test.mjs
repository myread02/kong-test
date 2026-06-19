import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parseAndValidate } from './launch-konnect-dp.mjs';

test('tokenize: should split simple arguments', () => {
  const input = 'docker run -d --name kong-dp';
  const expected = ['docker', 'run', '-d', '--name', 'kong-dp'];
  assert.deepEqual(tokenize(input), expected);
});

test('tokenize: should handle single and double quotes', () => {
  const input = `docker run -e "KONG_CLUSTER_CERT=abc def" -e 'KONG_VAL=123'`;
  const expected = ['docker', 'run', '-e', 'KONG_CLUSTER_CERT=abc def', '-e', 'KONG_VAL=123'];
  assert.deepEqual(tokenize(input), expected);
});

test('tokenize: should handle line continuations', () => {
  const input = `docker run \\\n  -d \\\n  -e "VAR=123"`;
  const expected = ['docker', 'run', '-d', '-e', 'VAR=123'];
  assert.deepEqual(tokenize(input), expected);
});

test('parseAndValidate: should parse valid inputs', () => {
  const input = `docker run -d \\
    -e KONG_CLUSTER_CONTROL_PLANE=control.konghq.com:443 \\
    -e KONG_CLUSTER_SERVER_NAME=control.konghq.com \\
    -e KONG_CLUSTER_TELEMETRY_ENDPOINT=telemetry.konghq.com:443 \\
    -e KONG_CLUSTER_TELEMETRY_SERVER_NAME=telemetry.konghq.com \\
    -e KONG_CLUSTER_CERT="-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----" \\
    -e KONG_CLUSTER_CERT_KEY="-----BEGIN PRIVATE KEY-----\\nKEY\\n-----END PRIVATE KEY-----" \\
    kong/kong-gateway:3.10`;

  const parsed = parseAndValidate(input);
  assert.equal(parsed.controlPlane, 'control.konghq.com:443');
  assert.equal(parsed.serverName, 'control.konghq.com');
  assert.equal(parsed.telemetryEndpoint, 'telemetry.konghq.com:443');
  assert.equal(parsed.telemetryServerName, 'telemetry.konghq.com');
  assert.equal(parsed.cert, '-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----');
  assert.equal(parsed.certKey, '-----BEGIN PRIVATE KEY-----\\nKEY\\n-----END PRIVATE KEY-----');
  assert.equal(parsed.image, 'kong/kong-gateway:3.10');
});

test('parseAndValidate: should reject non-konghq.com domains', () => {
  const input = `docker run -d \\
    -e KONG_CLUSTER_CONTROL_PLANE=control.evil.com:443 \\
    -e KONG_CLUSTER_SERVER_NAME=control.evil.com \\
    -e KONG_CLUSTER_TELEMETRY_ENDPOINT=telemetry.konghq.com:443 \\
    -e KONG_CLUSTER_TELEMETRY_SERVER_NAME=telemetry.konghq.com \\
    -e KONG_CLUSTER_CERT="-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----" \\
    -e KONG_CLUSTER_CERT_KEY="-----BEGIN PRIVATE KEY-----\\nKEY\\n-----END PRIVATE KEY-----" \\
    kong/kong-gateway:3.10`;

  assert.throws(() => parseAndValidate(input), /Host.*must end with.*\.konghq\.com/);
});

test('parseAndValidate: should reject mismatching endpoint and server name', () => {
  const input = `docker run -d \\
    -e KONG_CLUSTER_CONTROL_PLANE=control.konghq.com:443 \\
    -e KONG_CLUSTER_SERVER_NAME=wrong.konghq.com \\
    -e KONG_CLUSTER_TELEMETRY_ENDPOINT=telemetry.konghq.com:443 \\
    -e KONG_CLUSTER_TELEMETRY_SERVER_NAME=telemetry.konghq.com \\
    -e KONG_CLUSTER_CERT="-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----" \\
    -e KONG_CLUSTER_CERT_KEY="-----BEGIN PRIVATE KEY-----\\nKEY\\n-----END PRIVATE KEY-----" \\
    kong/kong-gateway:3.10`;

  assert.throws(() => parseAndValidate(input), /Control-plane endpoint host and server name do not match/);
});

test('parseAndValidate: should reject invalid image', () => {
  const input = `docker run -d \\
    -e KONG_CLUSTER_CONTROL_PLANE=control.konghq.com:443 \\
    -e KONG_CLUSTER_SERVER_NAME=control.konghq.com \\
    -e KONG_CLUSTER_TELEMETRY_ENDPOINT=telemetry.konghq.com:443 \\
    -e KONG_CLUSTER_TELEMETRY_SERVER_NAME=telemetry.konghq.com \\
    -e KONG_CLUSTER_CERT="-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----" \\
    -e KONG_CLUSTER_CERT_KEY="-----BEGIN PRIVATE KEY-----\\nKEY\\n-----END PRIVATE KEY-----" \\
    kong/kong-gateway:3.9.1`;

  assert.throws(() => parseAndValidate(input), /Unexpected image/);
});

test('parseAndValidate: should reject malformed or missing PEM', () => {
  const missingCert = `docker run -d \\
    -e KONG_CLUSTER_CONTROL_PLANE=control.konghq.com:443 \\
    -e KONG_CLUSTER_SERVER_NAME=control.konghq.com \\
    -e KONG_CLUSTER_TELEMETRY_ENDPOINT=telemetry.konghq.com:443 \\
    -e KONG_CLUSTER_TELEMETRY_SERVER_NAME=telemetry.konghq.com \\
    -e KONG_CLUSTER_CERT_KEY="-----BEGIN PRIVATE KEY-----\\nKEY\\n-----END PRIVATE KEY-----" \\
    kong/kong-gateway:3.10`;
  assert.throws(() => parseAndValidate(missingCert), /Missing required env variable.*KONG_CLUSTER_CERT/);

  const malformedCert = `docker run -d \\
    -e KONG_CLUSTER_CONTROL_PLANE=control.konghq.com:443 \\
    -e KONG_CLUSTER_SERVER_NAME=control.konghq.com \\
    -e KONG_CLUSTER_TELEMETRY_ENDPOINT=telemetry.konghq.com:443 \\
    -e KONG_CLUSTER_TELEMETRY_SERVER_NAME=telemetry.konghq.com \\
    -e KONG_CLUSTER_CERT="-----BEGIN CERTIFICATE-----" \\
    -e KONG_CLUSTER_CERT_KEY="-----BEGIN PRIVATE KEY-----\\nKEY\\n-----END PRIVATE KEY-----" \\
    kong/kong-gateway:3.10`;
  assert.throws(() => parseAndValidate(malformedCert), /PEM block.*must contain exactly one END header/);
});

test('parseAndValidate: should reject duplicated environment variables', () => {
  const duplicated = `docker run -d \\
    -e KONG_CLUSTER_CONTROL_PLANE=control.konghq.com:443 \\
    -e KONG_CLUSTER_SERVER_NAME=control.konghq.com \\
    -e KONG_CLUSTER_TELEMETRY_ENDPOINT=telemetry.konghq.com:443 \\
    -e KONG_CLUSTER_TELEMETRY_SERVER_NAME=telemetry.konghq.com \\
    -e KONG_CLUSTER_CERT="-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----" \\
    -e KONG_CLUSTER_CERT="-----BEGIN CERTIFICATE-----\\nXYZ\\n-----END CERTIFICATE-----" \\
    -e KONG_CLUSTER_CERT_KEY="-----BEGIN PRIVATE KEY-----\\nKEY\\n-----END PRIVATE KEY-----" \\
    kong/kong-gateway:3.10`;
  assert.throws(() => parseAndValidate(duplicated), /Duplicated environment variable/);
});

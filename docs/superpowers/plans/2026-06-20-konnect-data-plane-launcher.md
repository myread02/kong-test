# Secure Konnect Data Plane Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and use a dependency-free Node.js launcher that safely converts a copied Konnect Docker command into protected credential files and a fixed, non-shell Docker launch for the local mTLS lab.

**Architecture:** A single ES module reads the generated command as untrusted stdin, extracts and validates only allowlisted Konnect values, persists PEM files atomically, and invokes Docker with an argument array. Unit tests exercise parsing, validation, file modes, argument construction, and Docker orchestration without contacting Docker; the final task performs the live launch and Konnect verification.

**Tech Stack:** Node.js ES modules, Node built-in test runner, Node standard library (`fs`, `path`, `crypto`, `child_process`), Docker, Kong Gateway 3.10, Kong Konnect.

---

## File Structure

- Create `scripts/launch-konnect-dp.mjs`: parser, validator, credential writer, fixed Docker argument builder, Docker runner, and CLI entry point.
- Create `scripts/launch-konnect-dp.test.mjs`: synthetic fixtures and unit tests; never calls the real Docker daemon.
- Modify `README.md`: document safe Konnect launch and verification commands.
- Existing `.gitignore`: already ignores `kong-local-lab/konnect-credentials/`; no further change is expected.

### Task 1: Parse and validate the generated Konnect command

**Files:**
- Create: `scripts/launch-konnect-dp.test.mjs`
- Create: `scripts/launch-konnect-dp.mjs`

- [ ] **Step 1: Write failing parser tests**

Create `scripts/launch-konnect-dp.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseKonnectCommand } from './launch-konnect-dp.mjs';

const CERT = `-----BEGIN CERTIFICATE-----
QUJDREVGRw==
-----END CERTIFICATE-----`;

const KEY = `-----BEGIN PRIVATE KEY-----
SElKS0xNTg==
-----END PRIVATE KEY-----`;

function generatedCommand(overrides = {}) {
  const values = {
    controlPlane: '13870b4712.us.cp.konghq.com:443',
    controlPlaneName: '13870b4712.us.cp.konghq.com',
    telemetry: '13870b4712.us.tp.konghq.com:443',
    telemetryName: '13870b4712.us.tp.konghq.com',
    cert: CERT,
    key: KEY,
    image: 'kong/kong-gateway:3.10',
    ...overrides,
  };

  return `docker run -d \\
-e "KONG_ROLE=data_plane" \\
-e "KONG_CLUSTER_CONTROL_PLANE=${values.controlPlane}" \\
-e "KONG_CLUSTER_SERVER_NAME=${values.controlPlaneName}" \\
-e "KONG_CLUSTER_TELEMETRY_ENDPOINT=${values.telemetry}" \\
-e "KONG_CLUSTER_TELEMETRY_SERVER_NAME=${values.telemetryName}" \\
-e "KONG_CLUSTER_CERT=${values.cert}" \\
-e "KONG_CLUSTER_CERT_KEY=${values.key}" \\
${values.image}`;
}

test('parses allowlisted Konnect values from a valid generated command', () => {
  const result = parseKonnectCommand(generatedCommand());

  assert.deepEqual(result, {
    controlPlane: '13870b4712.us.cp.konghq.com:443',
    controlPlaneName: '13870b4712.us.cp.konghq.com',
    telemetry: '13870b4712.us.tp.konghq.com:443',
    telemetryName: '13870b4712.us.tp.konghq.com',
    cert: CERT,
    key: KEY,
    image: 'kong/kong-gateway:3.10',
  });
});

test('rejects missing or duplicated private keys', () => {
  assert.throws(
    () => parseKonnectCommand(generatedCommand().replace(/-e "KONG_CLUSTER_CERT_KEY=[\s\S]*?" \\\n/, '')),
    /exactly one KONG_CLUSTER_CERT_KEY/,
  );

  assert.throws(
    () => parseKonnectCommand(`${generatedCommand()}\n-e "KONG_CLUSTER_CERT_KEY=${KEY}"`),
    /exactly one KONG_CLUSTER_CERT_KEY/,
  );
});

test('rejects non-Kong endpoints and unexpected images', () => {
  assert.throws(
    () => parseKonnectCommand(generatedCommand({ controlPlane: 'attacker.example:443' })),
    /Invalid control-plane endpoint/,
  );
  assert.throws(
    () => parseKonnectCommand(generatedCommand({ image: 'alpine:latest' })),
    /Docker image/,
  );
});

test('ignores unrelated shell-like text instead of executing it', () => {
  const input = `${generatedCommand()}\n$(touch /tmp/must-not-exist)\n; echo unsafe`;
  const result = parseKonnectCommand(input);

  assert.equal(result.image, 'kong/kong-gateway:3.10');
  assert.equal(result.controlPlaneName, '13870b4712.us.cp.konghq.com');
});
```

- [ ] **Step 2: Run the parser tests and verify RED**

Run:

```bash
node --test scripts/launch-konnect-dp.test.mjs
```

Expected: FAIL because `scripts/launch-konnect-dp.mjs` does not exist.

- [ ] **Step 3: Implement the minimal parser and validator**

Create `scripts/launch-konnect-dp.mjs`:

```js
const EXPECTED_IMAGE = 'kong/kong-gateway:3.10';
const PEM_BODY = '[A-Za-z0-9+/=\\r\\n]+';

function extractUnique(input, label, pattern) {
  const matches = [...input.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}`);
  }
  return matches[0][1];
}

function extractScalar(input, name) {
  const pattern = new RegExp(
    String.raw`(?:^|\n)\s*-e\s+"?${name}=([^"\s]+)"?\s*\\?\s*(?:\n|$)`,
    'g',
  );
  return extractUnique(input, name, pattern);
}

function extractPem(input, name, type) {
  const pattern = new RegExp(
    `${name}=(-----BEGIN ${type}-----\\r?\\n${PEM_BODY}\\r?\\n-----END ${type}-----)`,
    'g',
  );
  return extractUnique(input, name, pattern).replace(/\r\n/g, '\n');
}

function validateEndpoint(value, kind, label) {
  const pattern = new RegExp(
    `^([a-z0-9-]+\\.(?:us|eu|au|sg|in|me)\\.${kind}\\.konghq\\.com):443$`,
  );
  const match = value.match(pattern);
  if (!match) {
    throw new Error(`Invalid ${label} endpoint`);
  }
  return match[1];
}

function validateServerName(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} server name does not match its endpoint`);
  }
}

export function parseKonnectCommand(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('Konnect command input is empty');
  }

  const controlPlane = extractScalar(input, 'KONG_CLUSTER_CONTROL_PLANE');
  const controlPlaneName = extractScalar(input, 'KONG_CLUSTER_SERVER_NAME');
  const telemetry = extractScalar(input, 'KONG_CLUSTER_TELEMETRY_ENDPOINT');
  const telemetryName = extractScalar(input, 'KONG_CLUSTER_TELEMETRY_SERVER_NAME');
  const cert = extractPem(input, 'KONG_CLUSTER_CERT', 'CERTIFICATE');
  const key = extractPem(input, 'KONG_CLUSTER_CERT_KEY', 'PRIVATE KEY');
  const image = extractUnique(
    input,
    `Docker image ${EXPECTED_IMAGE}`,
    /^\s*(kong\/kong-gateway:[^\s\\]+)\s*$/gm,
  );

  const controlHost = validateEndpoint(controlPlane, 'cp', 'control-plane');
  const telemetryHost = validateEndpoint(telemetry, 'tp', 'telemetry');
  validateServerName(controlPlaneName, controlHost, 'Control-plane');
  validateServerName(telemetryName, telemetryHost, 'Telemetry');
  if (telemetryHost !== controlHost.replace('.cp.', '.tp.')) {
    throw new Error('Telemetry and control-plane endpoints do not belong together');
  }
  if (image !== EXPECTED_IMAGE) {
    throw new Error(`Expected ${EXPECTED_IMAGE}`);
  }

  return {
    controlPlane,
    controlPlaneName,
    telemetry,
    telemetryName,
    cert,
    key,
    image,
  };
}
```

- [ ] **Step 4: Run the parser tests and verify GREEN**

Run:

```bash
node --test scripts/launch-konnect-dp.test.mjs
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 5: Commit the parser**

```bash
git add scripts/launch-konnect-dp.mjs scripts/launch-konnect-dp.test.mjs
git commit -m "feat: validate generated Konnect commands"
```

### Task 2: Store credentials and build fixed Docker arguments

**Files:**
- Modify: `scripts/launch-konnect-dp.test.mjs`
- Modify: `scripts/launch-konnect-dp.mjs`

- [ ] **Step 1: Add failing credential and argument tests**

Append to `scripts/launch-konnect-dp.test.mjs`:

```js
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildDockerArgs,
  persistCredentials,
} from './launch-konnect-dp.mjs';

test('writes protected credential files without changing their content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'konnect-launcher-'));
  const credentialDir = path.join(root, 'credentials');

  const paths = await persistCredentials({ cert: CERT, key: KEY }, credentialDir);

  assert.equal(await readFile(paths.certPath, 'utf8'), `${CERT}\n`);
  assert.equal(await readFile(paths.keyPath, 'utf8'), `${KEY}\n`);
  assert.equal((await stat(credentialDir)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.certPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.keyPath)).mode & 0o777, 0o600);
});

test('builds fixed Docker arguments with file paths instead of PEM values', () => {
  const config = parseKonnectCommand(generatedCommand());
  const args = buildDockerArgs(config, {
    credentialDir: '/repo/kong-local-lab/konnect-credentials',
    localCertDir: '/repo/kong-local-lab/certs',
  });
  const rendered = args.join(' ');

  assert.deepEqual(args.slice(0, 7), [
    'run', '-d', '--name', 'kong-konnect-dp',
    '--network', 'kong-local-lab_default', '-v',
  ]);
  assert.match(rendered, /8100:8000/);
  assert.match(rendered, /8543:8443/);
  assert.match(rendered, /KONG_CLUSTER_CERT=\/etc\/kong\/konnect\/cluster.crt/);
  assert.match(rendered, /KONG_NGINX_PROXY_SSL_VERIFY_CLIENT=on/);
  assert.ok(!rendered.includes('BEGIN CERTIFICATE'));
  assert.ok(!rendered.includes('BEGIN PRIVATE KEY'));
  assert.equal(args.at(-1), 'kong/kong-gateway:3.10');
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test scripts/launch-konnect-dp.test.mjs
```

Expected: FAIL because `persistCredentials` and `buildDockerArgs` are not exported.

- [ ] **Step 3: Implement atomic credential persistence and fixed Docker arguments**

Add these imports and exports to `scripts/launch-konnect-dp.mjs`:

```js
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CONTAINER_NAME = 'kong-konnect-dp';
const DOCKER_NETWORK = 'kong-local-lab_default';

async function atomicWrite(filePath, value) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${value}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

export async function persistCredentials({ cert, key }, credentialDir) {
  await mkdir(credentialDir, { recursive: true, mode: 0o700 });
  await chmod(credentialDir, 0o700);
  const certPath = path.join(credentialDir, 'cluster.crt');
  const keyPath = path.join(credentialDir, 'cluster.key');
  await atomicWrite(certPath, cert);
  await atomicWrite(keyPath, key);
  return { certPath, keyPath };
}

export function buildDockerArgs(config, { credentialDir, localCertDir }) {
  const environment = [
    'KONG_ROLE=data_plane',
    'KONG_DATABASE=off',
    'KONG_VITALS=off',
    'KONG_CLUSTER_MTLS=pki',
    `KONG_CLUSTER_CONTROL_PLANE=${config.controlPlane}`,
    `KONG_CLUSTER_SERVER_NAME=${config.controlPlaneName}`,
    `KONG_CLUSTER_TELEMETRY_ENDPOINT=${config.telemetry}`,
    `KONG_CLUSTER_TELEMETRY_SERVER_NAME=${config.telemetryName}`,
    'KONG_CLUSTER_CERT=/etc/kong/konnect/cluster.crt',
    'KONG_CLUSTER_CERT_KEY=/etc/kong/konnect/cluster.key',
    'KONG_LUA_SSL_TRUSTED_CERTIFICATE=system',
    'KONG_KONNECT_MODE=on',
    'KONG_ROUTER_FLAVOR=expressions',
    'KONG_PROXY_LISTEN=0.0.0.0:8000, 0.0.0.0:8443 ssl',
    'KONG_SSL_CERT=/etc/kong/certs/localhost.crt',
    'KONG_SSL_CERT_KEY=/etc/kong/certs/localhost.key',
    'KONG_NGINX_PROXY_SSL_CLIENT_CERTIFICATE=/etc/kong/certs/client-ca.crt',
    'KONG_NGINX_PROXY_SSL_VERIFY_CLIENT=on',
    'KONG_NGINX_PROXY_SSL_VERIFY_DEPTH=2',
  ];

  return [
    'run', '-d',
    '--name', CONTAINER_NAME,
    '--network', DOCKER_NETWORK,
    '-v', `${credentialDir}:/etc/kong/konnect:ro`,
    '-v', `${localCertDir}:/etc/kong/certs:ro`,
    ...environment.flatMap((value) => ['-e', value]),
    '-p', '8100:8000',
    '-p', '8543:8443',
    config.image,
  ];
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --test scripts/launch-konnect-dp.test.mjs
```

Expected: 6 tests pass, 0 fail.

- [ ] **Step 5: Commit credential handling and argument construction**

```bash
git add scripts/launch-konnect-dp.mjs scripts/launch-konnect-dp.test.mjs
git commit -m "feat: protect Konnect data plane credentials"
```

### Task 3: Add bounded Docker orchestration and CLI behavior

**Files:**
- Modify: `scripts/launch-konnect-dp.test.mjs`
- Modify: `scripts/launch-konnect-dp.mjs`

- [ ] **Step 1: Add failing Docker orchestration tests**

Append to `scripts/launch-konnect-dp.test.mjs`:

```js
import { launchDocker } from './launch-konnect-dp.mjs';

test('checks Docker and container absence before launching fixed arguments', () => {
  const calls = [];
  const fakeSpawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'info') return { status: 0, stdout: '3.10.0', stderr: '' };
    if (args[0] === 'container') return { status: 1, stdout: '', stderr: 'not found' };
    return { status: 0, stdout: 'abc123\n', stderr: '' };
  };

  const id = launchDocker(['run', '-d', 'kong/kong-gateway:3.10'], fakeSpawn);

  assert.equal(id, 'abc123');
  assert.deepEqual(calls, [
    ['docker', ['info', '--format', '{{.ServerVersion}}']],
    ['docker', ['container', 'inspect', 'kong-konnect-dp']],
    ['docker', ['run', '-d', 'kong/kong-gateway:3.10']],
  ]);
});

test('refuses to replace an existing container', () => {
  const fakeSpawn = (_command, args) => {
    if (args[0] === 'info') return { status: 0, stdout: '3.10.0', stderr: '' };
    return { status: 0, stdout: '{}', stderr: '' };
  };

  assert.throws(
    () => launchDocker(['run'], fakeSpawn),
    /already exists; it was not replaced/,
  );
});

test('Docker failures do not echo credential material', () => {
  const fakeSpawn = (_command, args) => {
    if (args[0] === 'info') return { status: 0, stdout: '3.10.0', stderr: '' };
    if (args[0] === 'container') return { status: 1, stdout: '', stderr: 'not found' };
    return { status: 1, stdout: '', stderr: `${KEY}\nfailed` };
  };

  assert.throws(
    () => launchDocker(['run'], fakeSpawn),
    (error) => !error.message.includes('BEGIN PRIVATE KEY') && /Docker failed to start/.test(error.message),
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test scripts/launch-konnect-dp.test.mjs
```

Expected: FAIL because `launchDocker` is not exported.

- [ ] **Step 3: Implement Docker checks and the CLI entry point**

Add to `scripts/launch-konnect-dp.mjs`:

```js
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function run(spawn, args) {
  return spawn('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function launchDocker(args, spawn = spawnSync) {
  const info = run(spawn, ['info', '--format', '{{.ServerVersion}}']);
  if (info.error || info.status !== 0) {
    throw new Error('Docker Desktop is unavailable');
  }

  const inspect = run(spawn, ['container', 'inspect', CONTAINER_NAME]);
  if (inspect.error) {
    throw new Error('Docker could not inspect existing containers');
  }
  if (inspect.status === 0) {
    throw new Error(`${CONTAINER_NAME} already exists; it was not replaced`);
  }

  const launched = run(spawn, args);
  if (launched.error || launched.status !== 0) {
    throw new Error('Docker failed to start the Konnect data plane');
  }
  const containerId = launched.stdout.trim();
  if (!/^[a-f0-9]{6,64}$/i.test(containerId)) {
    throw new Error('Docker returned an invalid container ID');
  }
  return containerId;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const credentialDir = path.join(repositoryRoot, 'kong-local-lab', 'konnect-credentials');
  const localCertDir = path.join(repositoryRoot, 'kong-local-lab', 'certs');
  const config = parseKonnectCommand(await readStdin());
  await persistCredentials(config, credentialDir);
  const args = buildDockerArgs(config, { credentialDir, localCertDir });
  const containerId = launchDocker(args);
  console.log(`Started kong-konnect-dp (${containerId.slice(0, 12)})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Konnect data plane launch failed: ${error.message}`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run all launcher tests and verify GREEN**

Run:

```bash
node --test scripts/launch-konnect-dp.test.mjs
```

Expected: 9 tests pass, 0 fail, with no warnings or secret material.

- [ ] **Step 5: Run static and repository checks**

Run:

```bash
node --check scripts/launch-konnect-dp.mjs
node --check scripts/launch-konnect-dp.test.mjs
git diff --check
```

Expected: all commands exit 0 with no output.

- [ ] **Step 6: Commit the bounded launcher**

```bash
git add scripts/launch-konnect-dp.mjs scripts/launch-konnect-dp.test.mjs
git commit -m "feat: launch Konnect data plane without shell evaluation"
```

### Task 4: Document and execute the live Konnect connection

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add safe usage documentation**

Append this section before `## Stop And Reset` in `README.md`:

````markdown
## Konnect Self-Managed Data Plane

The `local-kong-mtls-lab` Konnect control plane uses a separate Kong Gateway 3.10 data-plane container. Keep the existing database-backed Kong 3.9.1 lab running.

From the Konnect data-plane setup page, generate the Docker command and click **Copy**. Then run:

```bash
pbpaste | node scripts/launch-konnect-dp.mjs
```

The launcher treats the copied command as untrusted data. It validates only the required Konnect fields, writes the cluster certificate/key under the Git-ignored `kong-local-lab/konnect-credentials/` directory, and invokes Docker without a shell.

The Konnect proxy endpoints are:

- HTTP: `http://localhost:8100`
- HTTPS with local mTLS: `https://localhost:8543`

Check the container without exposing its environment:

```bash
docker ps --filter name=kong-konnect-dp
docker logs --tail 100 kong-konnect-dp
```

The launcher refuses to replace an existing `kong-konnect-dp` container. Remove or rename that container manually only when replacement is intentional.
````

- [ ] **Step 2: Verify docs and tests**

Run:

```bash
node --test scripts/launch-konnect-dp.test.mjs
git diff --check
```

Expected: 9 tests pass and no whitespace errors.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "docs: add secure Konnect data plane workflow"
```

- [ ] **Step 4: Launch with the copied real Konnect command**

Ensure the generated command is in the clipboard, then run:

```bash
pbpaste | node scripts/launch-konnect-dp.mjs
```

Expected: `Started kong-konnect-dp (<12-character ID>)` and no certificate or key output.

- [ ] **Step 5: Verify the local container and cluster connection**

Run:

```bash
docker ps --filter name=kong-konnect-dp
docker logs --tail 100 kong-konnect-dp
```

Expected: the container is running; logs show a successful control-plane connection and contain no crash loop or certificate error.

- [ ] **Step 6: Verify the node in Konnect**

Return to the open `local-kong-mtls-lab` setup page and wait for **View your data plane node** to become enabled. Open it and verify one connected node reports Gateway 3.10.

- [ ] **Step 7: Run final repository verification**

Run:

```bash
node --test scripts/launch-konnect-dp.test.mjs
git status --short
```

Expected: 9 tests pass. Git status is clean except for the ignored runtime credential directory, which must not appear.

The service/route migration and Postman request against ports `8100`/`8543` begin only after this connection is verified.

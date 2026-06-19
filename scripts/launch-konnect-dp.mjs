/**
 * Tokenizes a command string into an array of shell arguments.
 * Handles single quotes, double quotes, and backslash line continuations.
 */
export function tokenize(commandString) {
  const args = [];
  let current = '';
  let inDoubleQuotes = false;
  let inSingleQuotes = false;
  let escaped = false;

  for (let i = 0; i < commandString.length; i++) {
    const char = commandString[i];

    if (escaped) {
      if (char === '\n') {
        // Line continuation: ignore backslash and newline (do not append to current)
      } else {
        current += char;
      }
      escaped = false;
      continue;
    }

    if (char === '\\') {
      if (inSingleQuotes) {
        current += char;
      } else if (inDoubleQuotes) {
        // In double quotes, backslash only escapes double quotes, backslashes, or newlines
        const nextChar = commandString[i + 1];
        if (nextChar === '"' || nextChar === '\\' || nextChar === '\n') {
          escaped = true;
        } else {
          current += char;
        }
      } else {
        escaped = true;
      }
      continue;
    }

    if (char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
      continue;
    }

    if (char === '\'' && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
      continue;
    }

    if (/\s/.test(char) && !inDoubleQuotes && !inSingleQuotes) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

/**
 * Validates a hostname to ensure it ends with .konghq.com and is not empty.
 */
function validateKongHostname(hostAndPort, fieldName) {
  if (!hostAndPort) {
    throw new Error(`Missing required field: ${fieldName}`);
  }
  const host = hostAndPort.split(':')[0];
  if (!host.toLowerCase().endsWith('.konghq.com') || host.length <= '.konghq.com'.length) {
    throw new Error(`Hostname ${host} for ${fieldName} must end with .konghq.com`);
  }
  return host;
}

/**
 * Validates a PEM block structure.
 */
function validatePEM(pem, expectedBegin, expectedEnd, fieldName) {
  if (!pem) {
    throw new Error(`Missing required env variable: ${fieldName}`);
  }

  // Handle both literal \n and actual newlines
  const normalized = pem.replace(/\\n/g, '\n');

  const beginMatches = normalized.match(/-----BEGIN [^-]+-----/g);
  const endMatches = normalized.match(/-----END [^-]+-----/g);

  if (!beginMatches || beginMatches.length !== 1) {
    throw new Error(`PEM block for ${fieldName} must contain exactly one BEGIN header`);
  }
  if (!endMatches || endMatches.length !== 1) {
    throw new Error(`PEM block for ${fieldName} must contain exactly one END header`);
  }

  const beginHeader = beginMatches[0];
  const endHeader = endMatches[0];

  if (beginHeader !== expectedBegin) {
    throw new Error(`PEM block for ${fieldName} has unexpected BEGIN header: ${beginHeader}`);
  }
  if (endHeader !== expectedEnd) {
    throw new Error(`PEM block for ${fieldName} has unexpected END header: ${endHeader}`);
  }

  const startIndex = normalized.indexOf(beginHeader);
  const endIndex = normalized.indexOf(endHeader);
  if (startIndex >= endIndex) {
    throw new Error(`PEM block for ${fieldName} BEGIN header must come before END header`);
  }
}

/**
 * Parses the command string and validates it against security constraints.
 */
export function parseAndValidate(commandString) {
  const args = tokenize(commandString);
  const envVars = {};
  const seenVars = new Set();
  let image = null;

  const optionsWithArgs = new Set([
    '-p', '--publish',
    '-e', '--env',
    '--name',
    '-v', '--volume',
    '--network',
    '--mount',
    '-u', '--user',
    '-w', '--workdir',
    '--entrypoint',
    '--restart',
    '--log-driver',
    '--log-opt',
    '--cidfile',
    '--cpuset-cpus',
    '--cpuset-mems',
    '-m', '--memory',
    '--memory-swap',
    '--memory-reservation',
    '--kernel-memory',
    '--blkio-weight',
    '--cpu-shares',
    '--cpu-period',
    '--cpu-quota',
    '--cpu-rt-period',
    '--cpu-rt-runtime',
    '--cpus',
    '--device',
    '--device-read-bps',
    '--device-write-bps',
    '--device-read-iops',
    '--device-write-iops',
    '--ipc',
    '--mac-address',
    '--pid',
    '--security-opt',
    '--stop-signal',
    '--stop-timeout',
    '--storage-opt',
    '--runtime',
    '--shm-size',
    '--sysctl',
    '--ulimit',
    '--gpus',
    '--health-cmd',
    '--health-interval',
    '--health-retries',
    '--health-timeout',
    '--health-start-period'
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-e' || arg === '--env') {
      const next = args[i + 1];
      if (next && next.includes('=')) {
        const idx = next.indexOf('=');
        const name = next.slice(0, idx);
        const val = next.slice(idx + 1);
        if (seenVars.has(name)) {
          throw new Error(`Duplicated environment variable: ${name}`);
        }
        seenVars.add(name);
        envVars[name] = val;
      }
      i++;
      continue;
    }

    if (arg.startsWith('--env=')) {
      const valPart = arg.slice('--env='.length);
      const idx = valPart.indexOf('=');
      if (idx !== -1) {
        const name = valPart.slice(0, idx);
        const val = valPart.slice(idx + 1);
        if (seenVars.has(name)) {
          throw new Error(`Duplicated environment variable: ${name}`);
        }
        seenVars.add(name);
        envVars[name] = val;
      }
      continue;
    }

    if (arg.startsWith('-e') && arg.length > 2) {
      const valPart = arg.slice(2);
      const idx = valPart.indexOf('=');
      if (idx !== -1) {
        const name = valPart.slice(0, idx);
        const val = valPart.slice(idx + 1);
        if (seenVars.has(name)) {
          throw new Error(`Duplicated environment variable: ${name}`);
        }
        seenVars.add(name);
        envVars[name] = val;
      }
      continue;
    }

    if (i === 0 && (arg === 'docker' || arg === 'run')) {
      continue;
    }
    if (i === 1 && arg === 'run' && args[0] === 'docker') {
      continue;
    }

    if (arg.startsWith('-')) {
      if (optionsWithArgs.has(arg)) {
        i++;
      }
      continue;
    }

    if (!image) {
      image = arg;
    }
  }

  // Validate Hostnames
  const cpHost = validateKongHostname(envVars.KONG_CLUSTER_CONTROL_PLANE, 'KONG_CLUSTER_CONTROL_PLANE');
  const cpServerName = envVars.KONG_CLUSTER_SERVER_NAME;
  if (!cpServerName) {
    throw new Error('Missing KONG_CLUSTER_SERVER_NAME');
  }
  if (cpHost !== cpServerName) {
    throw new Error('Control-plane endpoint host and server name do not match.');
  }

  const tpHost = validateKongHostname(envVars.KONG_CLUSTER_TELEMETRY_ENDPOINT, 'KONG_CLUSTER_TELEMETRY_ENDPOINT');
  const tpServerName = envVars.KONG_CLUSTER_TELEMETRY_SERVER_NAME;
  if (!tpServerName) {
    throw new Error('Missing KONG_CLUSTER_TELEMETRY_SERVER_NAME');
  }
  if (tpHost !== tpServerName) {
    throw new Error('Telemetry endpoint host and server name do not match.');
  }

  // Validate PEM Blocks
  validatePEM(envVars.KONG_CLUSTER_CERT, '-----BEGIN CERTIFICATE-----', '-----END CERTIFICATE-----', 'KONG_CLUSTER_CERT');
  
  const certKey = envVars.KONG_CLUSTER_CERT_KEY;
  if (!certKey) {
    throw new Error('Missing required env variable: KONG_CLUSTER_CERT_KEY');
  }
  const certKeyNormalized = certKey.replace(/\\n/g, '\n');
  const keyBeginMatch = certKeyNormalized.match(/-----BEGIN [^-]*PRIVATE KEY-----/);
  const keyEndMatch = certKeyNormalized.match(/-----END [^-]*PRIVATE KEY-----/);
  if (!keyBeginMatch || !keyEndMatch) {
    throw new Error('KONG_CLUSTER_CERT_KEY does not contain a valid private key header');
  }
  validatePEM(certKey, keyBeginMatch[0], keyEndMatch[0], 'KONG_CLUSTER_CERT_KEY');

  // Validate Image
  if (image !== 'kong/kong-gateway:3.10') {
    throw new Error(`Unexpected image: ${image || 'none'}. Only kong/kong-gateway:3.10 is allowed.`);
  }

  return {
    controlPlane: envVars.KONG_CLUSTER_CONTROL_PLANE,
    serverName: envVars.KONG_CLUSTER_SERVER_NAME,
    telemetryEndpoint: envVars.KONG_CLUSTER_TELEMETRY_ENDPOINT,
    telemetryServerName: envVars.KONG_CLUSTER_TELEMETRY_SERVER_NAME,
    cert: envVars.KONG_CLUSTER_CERT,
    certKey: envVars.KONG_CLUSTER_CERT_KEY,
    image
  };
}

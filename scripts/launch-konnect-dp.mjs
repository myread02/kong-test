/**
 * Tokenizes a command string into an array of shell arguments.
 * Handles single quotes, double quotes, and backslash line continuations.
 * Throws an error on unclosed quotes or unescaped newlines outside of quotes.
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
      } else if (char === '\r') {
        // Handle \r\n line continuations
        const nextChar = commandString[i + 1];
        if (nextChar === '\n') {
          i++; // skip both \r and \n
        }
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
        if (nextChar === '"' || nextChar === '\\' || nextChar === '\n' || nextChar === '\r') {
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

    // Reject unescaped newline outside of quotes
    if ((char === '\n' || char === '\r') && !inDoubleQuotes && !inSingleQuotes) {
      throw new Error("Command injection vulnerability: unescaped newline encountered outside of quotes.");
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

  if (inDoubleQuotes || inSingleQuotes) {
    throw new Error("Command contains unclosed quotes.");
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
 * Helper to escape characters for a regular expression.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validates a PEM block structure, optionally supporting certificate chains.
 */
function validatePEM(pem, expectedBegin, expectedEnd, fieldName, allowChain = false) {
  if (!pem) {
    throw new Error(`Missing required env variable: ${fieldName}`);
  }

  // Handle both literal \n and actual newlines
  const normalized = pem.replace(/\\n/g, '\n');

  const beginMatches = [...normalized.matchAll(new RegExp(escapeRegExp(expectedBegin), 'g'))];
  const endMatches = [...normalized.matchAll(new RegExp(escapeRegExp(expectedEnd), 'g'))];

  if (beginMatches.length === 0) {
    throw new Error(`PEM block for ${fieldName} must contain at least one BEGIN header`);
  }
  if (endMatches.length === 0) {
    throw new Error(`PEM block for ${fieldName} must contain at least one END header`);
  }

  if (!allowChain && beginMatches.length !== 1) {
    throw new Error(`PEM block for ${fieldName} must contain exactly one BEGIN header`);
  }
  if (!allowChain && endMatches.length !== 1) {
    throw new Error(`PEM block for ${fieldName} must contain exactly one END header`);
  }

  if (beginMatches.length !== endMatches.length) {
    throw new Error(`PEM block for ${fieldName} has mismatching number of BEGIN and END headers`);
  }

  // Verify sequence and ensure no interleaving/overlap
  for (let i = 0; i < beginMatches.length; i++) {
    const beginIndex = beginMatches[i].index;
    const endIndex = endMatches[i].index;

    if (beginIndex >= endIndex) {
      throw new Error(`PEM block for ${fieldName} BEGIN header must come before END header`);
    }

    if (i < beginMatches.length - 1) {
      const nextBeginIndex = beginMatches[i + 1].index;
      if (endIndex >= nextBeginIndex) {
        throw new Error(`PEM block for ${fieldName} has interleaved or nested headers`);
      }
    }
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

  const allowedOptions = new Set([
    '-d',
    '--name',
    '-e',
    '--env',
    '-v',
    '--volume',
    '-p',
    '--publish',
    '--network'
  ]);

  const optionsWithArgs = new Set([
    '--name',
    '-e',
    '--env',
    '-v',
    '--volume',
    '-p',
    '--publish',
    '--network'
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Skip "docker" and "run" at the start
    if (i === 0 && (arg === 'docker' || arg === 'run')) {
      continue;
    }
    if (i === 1 && arg === 'run' && args[0] === 'docker') {
      continue;
    }

    if (arg.startsWith('-')) {
      let optName = arg;
      let optVal = null;
      if (arg.includes('=')) {
        const idx = arg.indexOf('=');
        optName = arg.slice(0, idx);
        optVal = arg.slice(idx + 1);
      }

      if (!allowedOptions.has(optName)) {
        throw new Error(`Forbidden option encountered: ${optName}`);
      }

      if (optName === '-e' || optName === '--env') {
        let envArg = optVal;
        if (envArg === null) {
          envArg = args[i + 1];
          i++;
        }
        if (envArg && envArg.includes('=')) {
          const idx = envArg.indexOf('=');
          const name = envArg.slice(0, idx);
          const val = envArg.slice(idx + 1);
          if (seenVars.has(name)) {
            throw new Error(`Duplicated environment variable: ${name}`);
          }
          seenVars.add(name);
          envVars[name] = val;
        }
      } else {
        if (optVal === null && optionsWithArgs.has(optName)) {
          i++;
        }
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
  if (cpHost.toLowerCase() !== cpServerName.toLowerCase()) {
    throw new Error('Control-plane endpoint host and server name do not match.');
  }

  const tpHost = validateKongHostname(envVars.KONG_CLUSTER_TELEMETRY_ENDPOINT, 'KONG_CLUSTER_TELEMETRY_ENDPOINT');
  const tpServerName = envVars.KONG_CLUSTER_TELEMETRY_SERVER_NAME;
  if (!tpServerName) {
    throw new Error('Missing KONG_CLUSTER_TELEMETRY_SERVER_NAME');
  }
  if (tpHost.toLowerCase() !== tpServerName.toLowerCase()) {
    throw new Error('Telemetry endpoint host and server name do not match.');
  }

  // Validate PEM Blocks
  validatePEM(envVars.KONG_CLUSTER_CERT, '-----BEGIN CERTIFICATE-----', '-----END CERTIFICATE-----', 'KONG_CLUSTER_CERT', true);
  
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
  validatePEM(certKey, keyBeginMatch[0], keyEndMatch[0], 'KONG_CLUSTER_CERT_KEY', false);

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

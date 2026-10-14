#!/usr/bin/env node
/**
 * Sync notification-service/.env from propmv backend env.
 *
 * Usage (from propmv/):
 *   node scripts/sync-notification-env.js
 */
const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');

function resolveNotifDir() {
  const candidates = [
    path.join(BACKEND_DIR, '..', 'notification-service'),
    path.join(BACKEND_DIR, '..', 'propmv-notification-service'),
    path.join(BACKEND_DIR, 'notification-service'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return null;
}

const NOTIF_DIR = resolveNotifDir();

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function upsertEnv(filePath, updates) {
  const lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/) : [];
  const keys = new Set(Object.keys(updates));
  const result = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line);
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      result.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (keys.has(key)) {
      result.push(`${key}=${updates[key]}`);
      keys.delete(key);
    } else {
      result.push(line);
    }
  }

  for (const key of keys) {
    result.push(`${key}=${updates[key]}`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, result.join('\n').replace(/\n*$/, '\n'), 'utf8');
}

function deriveMongoUri(dbUrl) {
  if (!dbUrl) return '';
  return dbUrl.replace(/^(mongodb(\+srv)?:\/\/[^/]+)\/[^/?]+(\?.*)?$/, '$1/$3');
}

function deriveMongoDbName(dbUrl) {
  if (!dbUrl) return 'PropMv';
  const match = dbUrl.match(/mongodb(\+srv)?:\/\/[^/]+\/([^/?]+)/);
  return match ? match[2] : 'PropMv';
}

function pickBackendEnvFile() {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(BACKEND_DIR, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function main() {
  if (!NOTIF_DIR) {
    console.error('[ERROR] notification-service not found next to propmv');
    process.exit(1);
  }

  const backendEnvFile = pickBackendEnvFile();
  const notifEnvFile = path.join(NOTIF_DIR, '.env');
  const exampleFile = path.join(NOTIF_DIR, '.env.example');

  if (!fs.existsSync(notifEnvFile) && fs.existsSync(exampleFile)) {
    fs.copyFileSync(exampleFile, notifEnvFile);
    console.log(`Created ${notifEnvFile} from .env.example`);
  }

  if (!backendEnvFile) {
    console.warn('[WARN] No .env.local or .env in propmv - edit notification-service/.env manually');
    process.exit(0);
  }

  const backend = readEnvFile(backendEnvFile);
  let apiKey = backend.NOTIFICATION_SERVICE_API_KEY;

  if (!apiKey) {
    apiKey = 'local-dev-notification-key';
    upsertEnv(backendEnvFile, {
      NOTIFICATION_SERVICE_URL: 'http://127.0.0.1:3000',
      NOTIFICATION_SERVICE_API_KEY: apiKey,
    });
    console.log(`Generated local NOTIFICATION_SERVICE_API_KEY in ${backendEnvFile}`);
  } else {
    upsertEnv(backendEnvFile, { NOTIFICATION_SERVICE_URL: 'http://127.0.0.1:3000' });
  }

  const updates = {
    PORT: '3000',
    NODE_ENV: 'development',
    REDIS_URL: 'redis://127.0.0.1:6379',
    RABBITMQ_URL: 'amqp://guest:guest@127.0.0.1:5672',
    RABBITMQ_QUEUE: 'notifications',
    LOG_LEVEL: 'info',
    JWT_SECRET: backend.JWT_SECRET || '',
    SERVICE_API_KEY: apiKey,
  };

  if (backend.DB_URL) {
    updates.MONGO_URI = deriveMongoUri(backend.DB_URL);
    updates.MONGO_DB_NAME = deriveMongoDbName(backend.DB_URL);
  }

  upsertEnv(notifEnvFile, updates);
  console.log(`Synced ${notifEnvFile} from ${backendEnvFile}`);
}

main();

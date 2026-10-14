/**
 * ------------------------------------------------------------------
 * File: loadEnv.js
 * Module: Src Config
 *
 * Purpose:
 * Backend utility/module providing helper functions for loadEnv.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const rootDir = path.join(__dirname, '../..');
const localPath = path.join(rootDir, '.env.local');
const productionPath = path.join(rootDir, '.env.production');
const defaultPath = path.join(rootDir, '.env');

/**
 * Load environment variables once, consistently, before any other module reads process.env.
 *
 * - Development (NODE_ENV !== 'production'): `.env.local`
 * - Production: `.env.production`, then optional `.env.local` overrides (non-secret local tweaks)
 * - Optional `.env` as a lowest-priority base when present
 */
function loadEnv() {
  if (process.env.__PROPMV_ENV_LOADED__) return;

  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction && fs.existsSync(defaultPath)) {
    dotenv.config({ path: defaultPath });
  }

  if (isProduction && fs.existsSync(productionPath)) {
    dotenv.config({ path: productionPath, override: true });
    // Allow local overrides in prod-like runs on a dev machine (e.g. ADDRESS_GOOGLE_MONTHLY_LIMIT=0).
    if (fs.existsSync(localPath)) {
      dotenv.config({ path: localPath, override: true });
    }
  } else if (fs.existsSync(localPath)) {
    dotenv.config({ path: localPath, override: true });
  } else if (fs.existsSync(productionPath)) {
    dotenv.config({ path: productionPath, override: true });
  }

  process.env.__PROPMV_ENV_LOADED__ = 'true';
}

loadEnv();

module.exports = { loadEnv };

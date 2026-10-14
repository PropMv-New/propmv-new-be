/**
 * ------------------------------------------------------------------
 * File: ecosystem.config.js
 * Module: Backend Core
 *
 * Purpose:
 * Configuration settings, variables mapping, and constants definitions.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// CI/CD pipeline test trigger - harmless comment, no behavior change
const path = require('path');

module.exports = {
  apps: [{
    name: 'propmv-backend',
    script: './src/server.js',
    cwd: path.join(__dirname),
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: process.env.PM2_MAX_MEMORY || '300M',
    env: {
      NODE_ENV: 'production',
      SLOW_API_MS: '1000',
      SLOW_REQUEST_MS: '1000',
    },
  }],
};

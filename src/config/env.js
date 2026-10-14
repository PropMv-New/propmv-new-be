/**
 * ------------------------------------------------------------------
 * File: env.js
 * Module: Src Config
 *
 * Purpose:
 * Backend utility/module providing helper functions for env.
 *
 * Used By:
 * cryptoHelper
 * ------------------------------------------------------------------
 */

require('./loadEnv');

const env = {
  PORT: parseInt(process.env.PORT, 10) || 5000,
  DB_URL: process.env.DB_URL || '',
  JWT_SECRET: process.env.JWT_SECRET || '',
  REFRESH_TOKEN_SECRET: process.env.REFRESH_TOKEN_SECRET || '',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '15m',
  REDIS_URL: process.env.REDIS_URL || '',
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  DOCUSIGN_INTEGRATOR_KEY: process.env.DOCUSIGN_INTEGRATOR_KEY || '',
  PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID || '',
  PLAID_SECRET: process.env.PLAID_SECRET || '',
  PASSWORD_ENCRYPTION: process.env.PASSWORD_ENCRYPTION || '',
  PASSWORD_ENCRYPTION_KEY: process.env.PASSWORD_ENCRYPTION_KEY || '',
  PASSWORD_ENCRYPTION_IV: process.env.PASSWORD_ENCRYPTION_IV || '',
  NOTIFICATION_SERVICE_URL: process.env.NOTIFICATION_SERVICE_URL || '',
  NOTIFICATION_SERVICE_API_KEY: process.env.NOTIFICATION_SERVICE_API_KEY || '',
};

module.exports = env;



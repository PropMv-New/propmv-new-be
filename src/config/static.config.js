/**
 * ------------------------------------------------------------------
 * File: static.config.js
 * Module: Src Config
 *
 * Purpose:
 * Configuration settings, variables mapping, and constants definitions.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const config = require('./default');
const logger = require('../common/logger');

/**
 * Setup static serving for mock storage when mock mode is enabled.
 * Cloud providers (s3 / azure) serve objects directly - no local static mount.
 */
function setupMockS3(app) {
  const provider = (
    process.env.STORAGE_PROVIDER ||
    (config.storage && config.storage.provider) ||
    ''
  ).toString().trim().toLowerCase();

  const useMock = provider === 'mock' || !!(config && config.s3 && config.s3.useMock);

  if (!useMock) {
    app.locals.s3Mode = provider || 'cloud';
    app.locals.storageProvider = provider || 's3';
    logger.info('Cloud storage enabled', { provider: app.locals.storageProvider });
    return;
  }

  const baseUrl = (config.s3 && config.s3.baseUrl) || '/mock-s3';
  const profile = config.profile || 'local';
  // Align with MockStorageProvider: local profile writes under uploads/
  const mockDir = path.resolve(
    profile === 'local'
      ? path.join(__dirname, '../../uploads')
      : ((config.s3 && config.s3.mockDir) || path.join(__dirname, '../../mock_s3'))
  );

  try {
    if (!fs.existsSync(mockDir)) fs.mkdirSync(mockDir, { recursive: true });
  } catch (e) {
    logger.warn('Failed to create mock storage dir', { error: e.message });
  }

  app.use(baseUrl, require('express').static(mockDir));
  app.locals.s3Mode = 'mock';
  app.locals.storageProvider = 'mock';
  logger.info('Using mock storage', { mockDir, baseUrl });
}

module.exports = { setupMockS3 };

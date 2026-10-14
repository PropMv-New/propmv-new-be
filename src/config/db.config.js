/**
 * ------------------------------------------------------------------
 * File: db.config.js
 * Module: Src Config
 *
 * Purpose:
 * Configuration settings, variables mapping, and constants definitions.
 *
 * Used By:
 * ensureHoaIndexes, app, database, populate-listing-location-fields
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const path = require('path');
require('./loadEnv');
const logger = require('../common/logger');
let isConnected = false;

function requireDbUrl() {
  if (!process.env.DB_URL) {
    throw new Error('DB_URL is not defined in environment variables');
  }
  return process.env.DB_URL;
}

/**
 * Returns the primary MongoDB connection string used by the application.
 *
 * @returns The configured database URI.
 */
function getMongoUri() {
  return requireDbUrl();
}

/**
 * Connects the app to MongoDB and applies a small set of startup migrations for schema indexes.
 */
async function connectDB() {
  if (isConnected) return mongoose.connection;

  const DB_URL = requireDbUrl();
  const DB_USER = process.env.DB_USER;
  const DB_PASS = process.env.DB_PASS;
  const DB_NAME = process.env.DB_NAME;
  const DB_SSL = process.env.DB_SSL === 'true';
  const DB_REPLICA_SET = process.env.DB_REPLICA_SET;

  const options = {
    dbName: DB_NAME,
    autoIndex: process.env.MONGO_AUTO_INDEX !== 'false' && process.env.NODE_ENV !== 'production',
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 20),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 5),
    maxIdleTimeMS: Number(process.env.MONGO_MAX_IDLE_TIME_MS || 30_000),
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45_000),
    waitQueueTimeoutMS: Number(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS || 10_000),
  };

  if (DB_USER && DB_PASS) {
    options.user = DB_USER;
    options.pass = DB_PASS;
  }

  if (DB_SSL) options.ssl = true;
  if (DB_REPLICA_SET) options.replicaSet = DB_REPLICA_SET;

  mongoose.set('strictQuery', true);

  const { installMongooseQueryProfiler } = require('../common/helpers/queryProfiler');
  installMongooseQueryProfiler();

  try {
    await mongoose.connect(DB_URL, options);
  } catch (err) {
    logger.error('MongoDB connection failed', { error: err.message });
    throw err;
  }

  try {
    const { ensurePropertyUniqueIndexes } = require('../database/ensurePropertyIndexes');
    await ensurePropertyUniqueIndexes();
  } catch (idxErr) {
    logger.warn('Property index migration skipped or failed', { error: idxErr.message });
  }

  try {
    const { ensureUserEmailUniqueIndex } = require('../database/ensureUserEmailIndex');
    await ensureUserEmailUniqueIndex();
  } catch (idxErr) {
    logger.warn('User email index migration skipped or failed', { error: idxErr.message });
  }

  isConnected = true;
  return mongoose.connection;
}

/**
 * Disconnects the application from MongoDB when the process is shutting down.
 */
async function disconnectDB() {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
  logger.info('MongoDB disconnected');
}

module.exports = {
  connectDB,
  disconnectDB,
  getMongoUri,
};

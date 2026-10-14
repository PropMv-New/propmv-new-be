/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: Src Database
 *
 * Purpose:
 * Backend utility/module providing helper functions for index.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const { connectDB } = require('../config/db.config');

async function connectToDatabase() {
  return connectDB();
}

module.exports = { connectToDatabase };



#!/usr/bin/env node
/**
 * Ops: sync MongoDB indexes for email delivery safety collections.
 *
 * Usage:
 *   npm run ensure:email-delivery-indexes
 */
require('../src/config/loadEnv');

const MODEL_PATHS = [
  '../src/common/models/emailSuppression.model',
  '../src/common/models/emailBounceProcessed.model',
  '../src/common/models/emailValidationLog.model',
];

async function main() {
  const { connectDB, disconnectDB } = require('../src/config/db.config');
  await connectDB();

  const results = [];
  for (const modelPath of MODEL_PATHS) {
    const Model = require(modelPath);
    const syncResult = await Model.syncIndexes();
    results.push({ model: Model.modelName, syncResult });
  }

  console.log(JSON.stringify({ synced: results }, null, 2));
  await disconnectDB();
}

main().catch((err) => {
  console.error('[ensure-email-delivery-indexes] failed:', err.message || err);
  process.exit(1);
});

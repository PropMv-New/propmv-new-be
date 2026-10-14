/**
 * Seed payment-related Master DB reference data (Ref Code / Ref Data).
 * Run: node src/scripts/seedPaymentMasterData.js
 *
 * Environment (loaded via src/config/loadEnv.js - same as the API server):
 *   DB_URL or MONGO_URI  (required) - Mongo connection string
 *   DB_NAME              (optional) - database name override
 *   DB_USER / DB_PASS    (optional) - credentials when not embedded in DB_URL
 *   DB_SSL=true          (optional) - enable TLS
 *   DB_REPLICA_SET       (optional) - replica set name
 */

const mongoose = require('mongoose');
const { loadEnv } = require('../config/loadEnv');

// Idempotent: loadEnv() is also invoked when the module loads; safe to call again.
loadEnv();

const MasterData = require('../shared/modules/master/model/masterData.model');
const { MASTER_DATA_KEYS } = require('../common/constants/masterDataKeys');

/**
 * Ref data shape notes:
 * - value: stable API / UI code (changing labels in Master DB does not break charge APIs)
 * - instrument: which saved pay instrument the rail uses (card | bank)
 * - feeKind: which TransactionFeeSettings bucket applies (card | bankTransfer)
 * - description: short help copy under the method label in pay dialogs
 */
const PAYMENT_MASTER_RECORDS = [
  {
    type: 'Payment',
    key: MASTER_DATA_KEYS.PAYMENT_METHODS,
    data: [
      {
        label: 'Credit / Debit Card',
        value: 'card',
        instrument: 'card',
        feeKind: 'card',
        description: 'Pay using a Credit or Debit Card',
        missingTitle: 'Credit / debit card not added',
        missingDescription: 'Add a card in Settings before paying with Credit / Debit Card.',
        addActionLabel: 'Add Card',
      },
      {
        label: 'eCheck',
        value: 'echeck',
        instrument: 'bank',
        feeKind: 'bankTransfer',
        description: 'Pay directly from a checking or savings account',
        missingTitle: 'Bank account not added',
        missingDescription: 'Add a bank account in Settings before paying with eCheck.',
        addActionLabel: 'Add Bank',
      },
    ],
  },
  {
    type: 'Payment',
    key: MASTER_DATA_KEYS.MANUAL_PAYMENT_METHODS,
    data: [
      { label: 'Cash', value: 'Cash' },
      { label: 'Check', value: 'Check' },
      { label: 'Money Order', value: 'Money Order' },
      { label: 'Other', value: 'Other' },
    ],
  },
  {
    type: 'Payment',
    key: MASTER_DATA_KEYS.PAYMENT_STATUSES,
    data: [
      { label: 'Paid', value: 'Paid' },
      { label: 'Pending', value: 'Pending' },
      { label: 'Processing', value: 'Processing' },
      { label: 'Failed', value: 'Failed' },
      { label: 'Overdue', value: 'Overdue' },
      { label: 'Partially Paid', value: 'Partially Paid' },
      { label: 'Cancelled', value: 'Cancelled' },
    ],
  },
  {
    type: 'Payment',
    key: MASTER_DATA_KEYS.ACCOUNT_TYPES,
    data: [
      { label: 'Checking', value: 'checking' },
      { label: 'Savings', value: 'savings' },
    ],
  },
  {
    type: 'Payment',
    key: MASTER_DATA_KEYS.CARD_TYPES,
    data: [
      { label: 'Visa', value: 'visa' },
      { label: 'Mastercard', value: 'mastercard' },
      { label: 'American Express', value: 'amex' },
      { label: 'Discover', value: 'discover' },
      { label: 'Other', value: 'other' },
    ],
  },
  // Legacy key still referenced by older landlord bank-account master lookups
  {
    type: 'Landlord_Property',
    key: 'Landlord_Account_Types',
    data: [
      { label: 'Checking', value: 'checking' },
      { label: 'Savings', value: 'savings' },
    ],
  },
];

function buildMongoConnectOptions() {
  // Keep options aligned with src/config/db.config.js (mongoose 8.x - no legacy parser flags).
  const options = {
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000),
  };
  if (process.env.DB_NAME) {
    options.dbName = process.env.DB_NAME;
  }
  if (process.env.DB_USER && process.env.DB_PASS) {
    options.user = process.env.DB_USER;
    options.pass = process.env.DB_PASS;
  }
  if (process.env.DB_SSL === 'true') {
    options.ssl = true;
  }
  if (process.env.DB_REPLICA_SET) {
    options.replicaSet = process.env.DB_REPLICA_SET;
  }
  return options;
}

async function seedPaymentMasterData() {
  const uri = process.env.DB_URL || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('DB_URL (or MONGO_URI) is not set');
  }

  const options = buildMongoConnectOptions();
  await mongoose.connect(uri, options);
  console.log(
    `Connected to MongoDB${options.dbName ? ` (database: ${options.dbName})` : ''}`,
  );

  for (const record of PAYMENT_MASTER_RECORDS) {
    const existing = await MasterData.findOne({ key: record.key });
    if (existing) {
      await MasterData.updateOne({ key: record.key }, { $set: record });
      console.log(`Updated ${record.key} (${record.data.length} items)`);
    } else {
      await MasterData.create(record);
      console.log(`Created ${record.key} (${record.data.length} items)`);
    }
  }

  await mongoose.disconnect();
  console.log('Payment master data seed complete');
}

if (require.main === module) {
  seedPaymentMasterData()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err.message);
      process.exit(1);
    });
}

module.exports = { seedPaymentMasterData, PAYMENT_MASTER_RECORDS };

/**
 * ------------------------------------------------------------------
 * File: transactionHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for transactionHelper.
 *
 * Used By:
 * auth.service, application.service, depositRefundInvoice.service, invoice.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

let transactionSupportChecked = false;
let transactionsSupported = false;

async function checkTransactionSupport() {
  if (transactionSupportChecked) return transactionsSupported;
  try {
    const admin = mongoose.connection.db.admin();
    const info = await admin.command({ isMaster: 1 });
    transactionsSupported = !!(info.setName || info.msg === 'isdbgrid');
    transactionSupportChecked = true;
    return transactionsSupported;
  } catch (err) {
    transactionSupportChecked = true;
    transactionsSupported = false;
    return false;
  }
}

/**
 * Run work inside a MongoDB transaction when the deployment supports it.
 * @param {function(import('mongoose').ClientSession|null): Promise<*>} fn
 * @param {{ session?: import('mongoose').ClientSession }} [options]
 * @returns {Promise<*>}
 */
async function runInTransaction(fn, options = {}) {
  if (options.session) {
    return fn(options.session);
  }

  const transactionsSupported = await checkTransactionSupport();
  if (!transactionsSupported) {
    return fn(null);
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

module.exports = { checkTransactionSupport, runInTransaction };
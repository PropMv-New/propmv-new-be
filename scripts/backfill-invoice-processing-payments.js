/**
 * Backfill processing payment transactions for legacy HOA invoices.
 *
 * Before the processingAmount workflow, ACH initiation only set invoice.status = Processing
 * without creating embedded paymentTransactions or adjusting balanceDue/processingAmount.
 *
 * This script:
 * 1. Finds invoices with status Processing and no active processing payment tx
 * 2. Links the latest Straddle charge for each invoice
 * 3. Creates a processing paymentTransactions row and recalculates totals
 * 4. Optionally auto-settles charges already marked paid/completed on Straddle
 *
 * Safe to re-run - skips invoices that already have processing txs.
 *
 * Usage:
 *   cd propmv && node scripts/backfill-invoice-processing-payments.js
 *   node scripts/backfill-invoice-processing-payments.js --dry-run
 *   node scripts/backfill-invoice-processing-payments.js --auto-settle
 *
 * Requires: MONGO_URI or DATABASE_URL (see .env)
 */

require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');

const Invoice = require(path.join(
  __dirname,
  '../src/portals/hoa-board/modules/invoice/model/invoice.model.js'
));
const StraddleTransaction = require(path.join(
  __dirname,
  '../src/shared/modules/payment/model/straddleTransaction.model.js'
));
const {
  backfillLegacyProcessingPayment,
  hasActiveProcessingPayment,
  settleInvoiceGatewayPayment,
  isGatewayPaymentSettledStatus,
} = require(path.join(
  __dirname,
  '../src/portals/hoa-board/modules/invoice/helpers/invoiceProcessingPayment.helper.js'
));
const { INVOICE_STATUS } = require(path.join(__dirname, '../src/common/constants/invoice.js'));

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL;
const dryRun = process.argv.includes('--dry-run');
const autoSettle = process.argv.includes('--auto-settle');

if (!MONGO_URI) {
  console.error('MONGO_URI / DATABASE_URL env var is required');
  process.exit(1);
}

async function findLatestChargeForInvoice(invoiceId) {
  const idStr = String(invoiceId);
  return StraddleTransaction.findOne({
    type: 'charge',
    $or: [
      { invoiceId },
      { 'metadata.invoiceId': idStr },
      { 'metadata.invoice_id': idStr },
    ],
  })
    .sort({ createdAt: -1 })
    .lean();
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected. dryRun=${dryRun} autoSettle=${autoSettle}`);

  const cursor = Invoice.find({
    status: INVOICE_STATUS.PROCESSING,
    isDeleted: { $ne: true },
  }).cursor();

  let scanned = 0;
  let backfilled = 0;
  let settled = 0;
  let skippedHasTx = 0;
  let skippedNoCharge = 0;
  let errors = 0;

  for await (const doc of cursor) {
    scanned++;
    const invoice = await Invoice.findById(doc._id);
    if (!invoice) continue;

    if (hasActiveProcessingPayment(invoice)) {
      skippedHasTx++;
      continue;
    }

    const charge = await findLatestChargeForInvoice(invoice._id);
    if (!charge) {
      skippedNoCharge++;
      console.warn(`  [skip] invoice ${invoice.invoiceId} (${invoice._id}) - no Straddle charge found`);
      continue;
    }

    if (dryRun) {
      console.log(
        `  [dry-run] would backfill invoice ${invoice.invoiceId} from charge ${charge.straddleId} amount=${charge.amount}`
      );
      backfilled++;
      continue;
    }

    try {
      const result = await backfillLegacyProcessingPayment(invoice, charge);
      if (result.backfilled) {
        backfilled++;
        console.log(`  [backfill] ${invoice.invoiceId}: processing $${result.amount}`);

        if (autoSettle && isGatewayPaymentSettledStatus(charge.status)) {
          const settleResult = await settleInvoiceGatewayPayment({
            straddleId: charge.straddleId,
            status: charge.status,
            invoiceId: invoice._id,
            gatewayTransactionId: charge._id,
            completedAt: charge.updatedAt,
          });
          if (settleResult.settled) {
            settled++;
            console.log(`  [settle] ${invoice.invoiceId}: $${settleResult.amount} → ${settleResult.status}`);
          }
        }
      } else {
        console.warn(`  [skip] invoice ${invoice.invoiceId}: ${result.reason}`);
      }
    } catch (err) {
      errors++;
      console.error(`  [error] invoice ${invoice.invoiceId}: ${err.message}`);
    }
  }

  console.log('\n--- Backfill summary ---');
  console.log(`  scanned: ${scanned}`);
  console.log(`  backfilled: ${backfilled}`);
  console.log(`  auto-settled: ${settled}`);
  console.log(`  skipped (already has processing tx): ${skippedHasTx}`);
  console.log(`  skipped (no charge): ${skippedNoCharge}`);
  console.log(`  errors: ${errors}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

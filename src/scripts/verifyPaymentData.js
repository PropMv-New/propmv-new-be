/**
 * ------------------------------------------------------------------
 * File: verifyPaymentData.js
 * Module: Src Scripts
 *
 * Purpose:
 * Backend utility/module providing helper functions for verifyPaymentData.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
require('dotenv').config();

const PaymentStatus = require('../shared/modules/payment/model/paymentStatus.model');
const StraddleTransaction = require('../shared/modules/payment/model/straddleTransaction.model');
const StraddleWebhookEventResponse = require('../shared/modules/payment/model/straddleWebhookEventResponse.model');

async function verifyPaymentData() {
  try {
    await mongoose.connect(process.env.DB_URL.replace('/?', '/PropMv?'), {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('✓ Connected to MongoDB\n');
    console.log('✓ Database:', mongoose.connection.db.databaseName);
    console.log('='.repeat(60));
    console.log('Payment Transaction Data Verification');
    console.log('='.repeat(60));

    // Check PaymentStatus
    const paymentStatuses = await PaymentStatus.find({ account_id: 'acc_sandbox_123' })
      .sort({ createdAt: -1 })
      .lean();

    console.log(`\n📊 PaymentStatus Records: ${paymentStatuses.length}`);

    // Group by payout ID
    const byPayoutId = {};
    paymentStatuses.forEach(ps => {
      const payoutId = ps.data?.id;
      if (!byPayoutId[payoutId]) {
        byPayoutId[payoutId] = [];
      }
      byPayoutId[payoutId].push(ps);
    });

    console.log(`   Unique Payments: ${Object.keys(byPayoutId).length}`);

    // Check StraddleTransaction
    const straddleTransactions = await StraddleTransaction.find({ accountId: 'acc_sandbox_123' })
      .sort({ createdAt: -1 })
      .lean();

    console.log(`\n💳 StraddleTransaction Records: ${straddleTransactions.length}`);

    // Status breakdown
    const statusCount = {};
    straddleTransactions.forEach(tx => {
      statusCount[tx.status] = (statusCount[tx.status] || 0) + 1;
    });

    console.log('   Status Breakdown:');
    Object.entries(statusCount).forEach(([status, count]) => {
      const emoji = status === 'paid' ? '✓' : status === 'failed' ? '✗' : '⏳';
      console.log(`     ${emoji} ${status}: ${count}`);
    });

    // Check StraddleWebhookEventResponse
    const webhookEvents = await StraddleWebhookEventResponse.find({ account_id: 'acc_sandbox_123' })
      .sort({ createdAt: -1 })
      .lean();

    console.log(`\n📡 Webhook Event Records: ${webhookEvents.length}`);

    // Event type breakdown
    const eventTypeCount = {};
    webhookEvents.forEach(evt => {
      eventTypeCount[evt.event_type] = (eventTypeCount[evt.event_type] || 0) + 1;
    });

    console.log('   Event Types:');
    Object.entries(eventTypeCount).forEach(([type, count]) => {
      console.log(`     • ${type}: ${count}`);
    });

    // Detailed transaction view
    console.log('\n' + '='.repeat(60));
    console.log('Detailed Transaction View');
    console.log('='.repeat(60));

    for (const [payoutId, events] of Object.entries(byPayoutId)) {
      const transaction = straddleTransactions.find(tx => tx.straddleId === payoutId);
      if (!transaction) continue;

      const latestEvent = events[0];
      const statusHistory = latestEvent.data?.status_history || [];

      console.log(`\n💰 Payment: ${payoutId}`);
      console.log(`   Amount: $${(transaction.amount / 100).toFixed(2)}`);
      console.log(`   Status: ${transaction.status.toUpperCase()}`);
      console.log(`   Invoice: ${transaction.invoiceId || 'N/A'}`);
      console.log(`   Webhook Events: ${events.length}`);

      if (statusHistory.length > 0) {
        console.log(`   Status Progression:`);
        statusHistory.forEach((history, idx) => {
          const emoji = history.status === 'paid' ? '✓' :
            history.status === 'failed' ? '✗' :
              history.status === 'pending' ? '⏳' : '○';
          const timestamp = new Date(history.timestamp).toLocaleString();
          console.log(`     ${idx + 1}. ${emoji} ${history.status} - ${timestamp}`);
          if (history.status_details?.reason) {
            console.log(`        "${history.status_details.reason}"`);
          }
        });
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('Summary');
    console.log('='.repeat(60));

    const completedCount = straddleTransactions.filter(tx => tx.status === 'paid').length;
    const pendingCount = straddleTransactions.filter(tx => tx.status === 'pending').length;
    const failedCount = straddleTransactions.filter(tx => tx.status === 'failed').length;

    console.log(`✓ Completed Payments: ${completedCount}`);
    console.log(`⏳ In-Process Payments: ${pendingCount}`);
    console.log(`✗ Failed Payments: ${failedCount}`);
    console.log(`\n📋 Total Transactions: ${straddleTransactions.length}`);
    console.log(`📨 Total Webhook Events: ${webhookEvents.length}`);
    console.log(`📊 Total Payment Status Records: ${paymentStatuses.length}`);

    console.log('\n' + '='.repeat(60));
    console.log('Verification Complete!');
    console.log('='.repeat(60));

    // Check if data exists
    if (straddleTransactions.length === 0) {
      console.log('\n⚠️  No test data found!');
      console.log('   Run the seeder first: node seedPaymentTransactions.js');
    } else {
      console.log('\n✓ Test data is ready for UI testing!');
      console.log('  Navigate to an invoice detail page to see payment transactions.');
    }

  } catch (error) {
    console.error(' Error verifying data:', error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('\n✓ Database connection closed');
  }
}

// Run verification
if (require.main === module) {
  verifyPaymentData()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { verifyPaymentData };

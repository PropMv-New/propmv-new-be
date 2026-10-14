/**
 * ------------------------------------------------------------------
 * File: seedPaymentTransactions.js
 * Module: Src Scripts
 *
 * Purpose:
 * Backend utility/module providing helper functions for seedPaymentTransactions.
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
const Invoice = require('../portals/hoa-board/modules/invoice/model/invoice.model');

// Sample invoice IDs - replace with actual invoice IDs from your database
const SAMPLE_INVOICE_IDS = [
  '67917a0f2d8d5b4e8c123456', // Replace with actual invoice ID
  '67917a0f2d8d5b4e8c123457', // Replace with actual invoice ID
];

// Generate complete payment transaction with all webhook events
const generateCompletePayment = (invoiceId, index) => {
  const payoutId = `py_complete_${index}_${Date.now()}`;
  const eventIdBase = `evt_complete_${index}_${Date.now()}`;
  const paykeyId = `pk_complete_${index}`;
  const customerId = `cus_complete_${index}`;
  const amount = 15000 + (index * 1000); // $150.00, $160.00, etc.

  const baseTime = new Date(Date.now() - (index * 86400000)); // Stagger by days

  // Status history showing complete lifecycle
  const statusHistory = [
    {
      status: 'created',
      status_details: { reason: 'Payment initiated by customer' },
      timestamp: new Date(baseTime.getTime()).toISOString()
    },
    {
      status: 'scheduled',
      status_details: { reason: 'Payment scheduled for processing' },
      timestamp: new Date(baseTime.getTime() + 5000).toISOString()
    },
    {
      status: 'pending',
      status_details: { reason: 'Payment submitted to bank' },
      timestamp: new Date(baseTime.getTime() + 10000).toISOString()
    },
    {
      status: 'paid',
      status_details: { reason: 'Payment successfully completed' },
      timestamp: new Date(baseTime.getTime() + 300000).toISOString()
    }
  ];

  // Webhook event for payout.created.v1
  const createdEvent = {
    event_id: `${eventIdBase}_created`,
    event_type: 'payout.created.v1',
    account_id: 'acc_sandbox_123',
    data: {
      id: payoutId,
      amount: amount,
      currency: 'usd',
      description: `Payment for Invoice #INV-${index + 1001}`,
      status: 'created',
      paykey: paykeyId,
      paykey_details: {
        id: paykeyId,
        type: 'ACH',
        status: 'active'
      },
      customer_details: {
        id: customerId,
        name: `Test Customer ${index + 1}`,
        email: `customer${index + 1}@example.com`
      },
      status_details: {
        reason: 'Payment initiated by customer'
      },
      status_history: [statusHistory[0]],
      payment_rail: 'ACH',
      consent_type: 'online',
      effective_at: baseTime.toISOString(),
      payment_date: baseTime.toISOString().split('T')[0],
      created_at: baseTime.toISOString(),
      updated_at: baseTime.toISOString(),
      metadata: {
        invoiceId: invoiceId,
        invoice_id: invoiceId,
        source: 'hoa_board'
      }
    }
  };

  // Webhook event for payout.event.v1 (status updates)
  const statusUpdateEvents = statusHistory.slice(1).map((statusEntry, idx) => ({
    event_id: `${eventIdBase}_update_${idx + 1}`,
    event_type: 'payout.event.v1',
    account_id: 'acc_sandbox_123',
    data: {
      ...createdEvent.data,
      status: statusEntry.status,
      status_details: statusEntry.status_details,
      status_history: statusHistory.slice(0, idx + 2),
      processed_at: statusEntry.status === 'paid' ? statusEntry.timestamp : null,
      updated_at: statusEntry.timestamp
    }
  }));

  return {
    payoutId,
    invoiceId,
    events: [createdEvent, ...statusUpdateEvents],
    finalStatus: 'paid'
  };
};

// Generate in-process payment transaction (stuck at pending)
const generateInProcessPayment = (invoiceId, index) => {
  const payoutId = `py_inprocess_${index}_${Date.now()}`;
  const eventIdBase = `evt_inprocess_${index}_${Date.now()}`;
  const paykeyId = `pk_inprocess_${index}`;
  const customerId = `cus_inprocess_${index}`;
  const amount = 20000 + (index * 1000); // $200.00, $210.00, etc.

  const baseTime = new Date(Date.now() - (index * 43200000)); // Stagger by half days

  // Status history showing payment stuck at pending
  const statusHistory = [
    {
      status: 'created',
      status_details: { reason: 'Payment initiated by customer' },
      timestamp: new Date(baseTime.getTime()).toISOString()
    },
    {
      status: 'scheduled',
      status_details: { reason: 'Payment scheduled for processing' },
      timestamp: new Date(baseTime.getTime() + 5000).toISOString()
    },
    {
      status: 'pending',
      status_details: { reason: 'Payment submitted to bank, awaiting confirmation' },
      timestamp: new Date(baseTime.getTime() + 10000).toISOString()
    }
  ];

  const createdEvent = {
    event_id: `${eventIdBase}_created`,
    event_type: 'payout.created.v1',
    account_id: 'acc_sandbox_123',
    data: {
      id: payoutId,
      amount: amount,
      currency: 'usd',
      description: `Payment for Invoice #INV-${index + 2001}`,
      status: 'created',
      paykey: paykeyId,
      paykey_details: {
        id: paykeyId,
        type: 'ACH',
        status: 'active'
      },
      customer_details: {
        id: customerId,
        name: `Test Customer ${index + 10}`,
        email: `customer${index + 10}@example.com`
      },
      status_details: {
        reason: 'Payment initiated by customer'
      },
      status_history: [statusHistory[0]],
      payment_rail: 'ACH',
      consent_type: 'online',
      effective_at: baseTime.toISOString(),
      payment_date: baseTime.toISOString().split('T')[0],
      created_at: baseTime.toISOString(),
      updated_at: baseTime.toISOString(),
      metadata: {
        invoiceId: invoiceId,
        invoice_id: invoiceId,
        source: 'hoa_board'
      }
    }
  };

  const statusUpdateEvents = statusHistory.slice(1).map((statusEntry, idx) => ({
    event_id: `${eventIdBase}_update_${idx + 1}`,
    event_type: 'payout.event.v1',
    account_id: 'acc_sandbox_123',
    data: {
      ...createdEvent.data,
      status: statusEntry.status,
      status_details: statusEntry.status_details,
      status_history: statusHistory.slice(0, idx + 2),
      updated_at: statusEntry.timestamp
    }
  }));

  return {
    payoutId,
    invoiceId,
    events: [createdEvent, ...statusUpdateEvents],
    finalStatus: 'pending'
  };
};

// Generate failed payment transaction
const generateFailedPayment = (invoiceId, index) => {
  const payoutId = `py_failed_${index}_${Date.now()}`;
  const eventIdBase = `evt_failed_${index}_${Date.now()}`;
  const paykeyId = `pk_failed_${index}`;
  const customerId = `cus_failed_${index}`;
  const amount = 12000 + (index * 1000);

  const baseTime = new Date(Date.now() - (index * 172800000)); // Stagger by 2 days

  const statusHistory = [
    {
      status: 'created',
      status_details: { reason: 'Payment initiated by customer' },
      timestamp: new Date(baseTime.getTime()).toISOString()
    },
    {
      status: 'scheduled',
      status_details: { reason: 'Payment scheduled for processing' },
      timestamp: new Date(baseTime.getTime() + 5000).toISOString()
    },
    {
      status: 'pending',
      status_details: { reason: 'Payment submitted to bank' },
      timestamp: new Date(baseTime.getTime() + 10000).toISOString()
    },
    {
      status: 'failed',
      status_details: { reason: 'Insufficient funds', code: 'R01' },
      timestamp: new Date(baseTime.getTime() + 120000).toISOString()
    }
  ];

  const createdEvent = {
    event_id: `${eventIdBase}_created`,
    event_type: 'payout.created.v1',
    account_id: 'acc_sandbox_123',
    data: {
      id: payoutId,
      amount: amount,
      currency: 'usd',
      description: `Payment for Invoice #INV-${index + 3001}`,
      status: 'created',
      paykey: paykeyId,
      paykey_details: {
        id: paykeyId,
        type: 'ACH',
        status: 'active'
      },
      customer_details: {
        id: customerId,
        name: `Test Customer ${index + 20}`,
        email: `customer${index + 20}@example.com`
      },
      status_details: {
        reason: 'Payment initiated by customer'
      },
      status_history: [statusHistory[0]],
      payment_rail: 'ACH',
      consent_type: 'online',
      effective_at: baseTime.toISOString(),
      payment_date: baseTime.toISOString().split('T')[0],
      created_at: baseTime.toISOString(),
      updated_at: baseTime.toISOString(),
      metadata: {
        invoiceId: invoiceId,
        invoice_id: invoiceId,
        source: 'hoa_board'
      }
    }
  };

  const statusUpdateEvents = statusHistory.slice(1).map((statusEntry, idx) => ({
    event_id: `${eventIdBase}_update_${idx + 1}`,
    event_type: 'payout.event.v1',
    account_id: 'acc_sandbox_123',
    data: {
      ...createdEvent.data,
      status: statusEntry.status,
      status_details: statusEntry.status_details,
      status_history: statusHistory.slice(0, idx + 2),
      updated_at: statusEntry.timestamp
    }
  }));

  return {
    payoutId,
    invoiceId,
    events: [createdEvent, ...statusUpdateEvents],
    finalStatus: 'failed'
  };
};

async function seedPaymentTransactions() {
  try {
    await mongoose.connect(process.env.DB_URL.replace('/?', '/PropMv?'), {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('Connected to MongoDB');
    console.log('Database:', mongoose.connection.db.databaseName);

    // Clear existing test data
    console.log('Clearing existing test payment data...');
    await PaymentStatus.deleteMany({ account_id: 'acc_sandbox_123' });
    await StraddleTransaction.deleteMany({ accountId: 'acc_sandbox_123' });
    await StraddleWebhookEventResponse.deleteMany({ account_id: 'acc_sandbox_123' });

    // Get actual invoices or use sample IDs
    const invoices = await Invoice.find({ isDeleted: { $ne: true } })
      .limit(10)
      .select('_id invoiceId')
      .lean();

    const invoiceIds = invoices.length > 0
      ? invoices.map(inv => inv._id.toString())
      : SAMPLE_INVOICE_IDS;

    console.log(`Found ${invoiceIds.length} invoices to seed payment data`);

    // Generate complete payments (3 transactions)
    console.log('Creating completed payment transactions...');
    for (let i = 0; i < Math.min(3, invoiceIds.length); i++) {
      const payment = generateCompletePayment(invoiceIds[i], i);

      // Create webhook event responses
      for (const event of payment.events) {
        await StraddleWebhookEventResponse.create({
          event: event.event_id,
          account_id: event.account_id,
          event_type: event.event_type,
          response: event
        });

        // Create payment status
        await PaymentStatus.create({
          event_id: event.event_id,
          eventId: event.event_id,
          event_type: event.event_type,
          account_id: event.account_id,
          data: event.data,
          rawPayload: event
        });
      }

      // Create Straddle transaction
      const finalEvent = payment.events[payment.events.length - 1];
      await StraddleTransaction.create({
        straddleId: payment.payoutId,
        type: 'payout',
        amount: finalEvent.data.amount,
        currency: finalEvent.data.currency,
        paykeyId: finalEvent.data.paykey,
        accountId: finalEvent.account_id,
        invoiceId: payment.invoiceId,
        description: finalEvent.data.description,
        status: payment.finalStatus,
        metadata: finalEvent.data.metadata,
        raw: finalEvent
      });

      console.log(`  ✓ Created completed payment ${i + 1}: ${payment.payoutId}`);
    }

    // Generate in-process payments (2 transactions)
    console.log('Creating in-process payment transactions...');
    for (let i = 0; i < Math.min(2, Math.max(0, invoiceIds.length - 3)); i++) {
      const payment = generateInProcessPayment(invoiceIds[i + 3] || invoiceIds[0], i);

      for (const event of payment.events) {
        await StraddleWebhookEventResponse.create({
          event: event.event_id,
          account_id: event.account_id,
          event_type: event.event_type,
          response: event
        });

        await PaymentStatus.create({
          event_id: event.event_id,
          eventId: event.event_id,
          event_type: event.event_type,
          account_id: event.account_id,
          data: event.data,
          rawPayload: event
        });
      }

      const finalEvent = payment.events[payment.events.length - 1];
      await StraddleTransaction.create({
        straddleId: payment.payoutId,
        type: 'payout',
        amount: finalEvent.data.amount,
        currency: finalEvent.data.currency,
        paykeyId: finalEvent.data.paykey,
        accountId: finalEvent.account_id,
        invoiceId: payment.invoiceId,
        description: finalEvent.data.description,
        status: payment.finalStatus,
        metadata: finalEvent.data.metadata,
        raw: finalEvent
      });

      console.log(`  ✓ Created in-process payment ${i + 1}: ${payment.payoutId}`);
    }

    // Generate failed payment (1 transaction)
    console.log('Creating failed payment transaction...');
    const failedPayment = generateFailedPayment(invoiceIds[0], 0);

    for (const event of failedPayment.events) {
      await StraddleWebhookEventResponse.create({
        event: event.event_id,
        account_id: event.account_id,
        event_type: event.event_type,
        response: event
      });

      await PaymentStatus.create({
        event_id: event.event_id,
        eventId: event.event_id,
        event_type: event.event_type,
        account_id: event.account_id,
        data: event.data,
        rawPayload: event
      });
    }

    const finalEvent = failedPayment.events[failedPayment.events.length - 1];
    await StraddleTransaction.create({
      straddleId: failedPayment.payoutId,
      type: 'payout',
      amount: finalEvent.data.amount,
      currency: finalEvent.data.currency,
      paykeyId: finalEvent.data.paykey,
      accountId: finalEvent.account_id,
      invoiceId: failedPayment.invoiceId,
      description: finalEvent.data.description,
      status: failedPayment.finalStatus,
      metadata: finalEvent.data.metadata,
      raw: finalEvent
    });

    console.log(`  ✓ Created failed payment: ${failedPayment.payoutId}`);

    console.log('\nPayment transaction seeding completed successfully!');
    console.log('\nSummary:');
    console.log(`  - 3 completed payments`);
    console.log(`  - 2 in-process payments (pending)`);
    console.log(`  - 1 failed payment`);
    console.log(`  - Total: 6 payment transactions with full webhook history`);

  } catch (error) {
    console.error('Error seeding payment transactions:', error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  }
}

// Run seeder
if (require.main === module) {
  seedPaymentTransactions()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { seedPaymentTransactions };

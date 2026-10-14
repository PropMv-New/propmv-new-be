/**
 * ------------------------------------------------------------------
 * File: seedLeaseInvoicePayments.js
 * Module: Src Scripts
 *
 * Purpose:
 * Backend utility/module providing helper functions for seedLeaseInvoicePayments.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Invoice = require('../portals/hoa-board/modules/invoice/model/invoice.model');
const PaymentStatus = require('../shared/modules/payment/model/paymentStatus.model');
const StraddleTransaction = require('../shared/modules/payment/model/straddleTransaction.model');
const StraddleWebhookEventResponse = require('../shared/modules/payment/model/straddleWebhookEventResponse.model');

const TARGET_LEASE_ID = '6a2e824cc7d47a5ab43768ea';

// Generate payment with status history
function generatePaymentData(invoiceId, type, index) {
  const payoutId = `py_${type}_${index}_${Date.now()}`;
  const eventIdBase = `evt_${type}_${index}_${Date.now()}`;
  const paykeyId = `pk_${type}_${index}`;
  const customerId = `cus_${type}_${index}`;

  const amounts = {
    complete: 25000, // $250.00
    inprocess: 15000, // $150.00
    failed: 10000 // $100.00
  };
  const amount = amounts[type] || 20000;

  const baseTime = new Date();

  let statusHistory;
  let finalStatus;

  if (type === 'complete') {
    statusHistory = [
      {
        status: 'created',
        status_details: { reason: 'Payment initiated by tenant' },
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
    finalStatus = 'paid';
  } else if (type === 'inprocess') {
    statusHistory = [
      {
        status: 'created',
        status_details: { reason: 'Payment initiated by tenant' },
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
    finalStatus = 'pending';
  } else { // failed
    statusHistory = [
      {
        status: 'created',
        status_details: { reason: 'Payment initiated by tenant' },
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
    finalStatus = 'failed';
  }

  const createdEvent = {
    event_id: `${eventIdBase}_created`,
    event_type: 'payout.created.v1',
    account_id: 'acc_sandbox_123',
    data: {
      id: payoutId,
      amount: amount,
      currency: 'usd',
      description: `Payment for Invoice - Lease ${TARGET_LEASE_ID}`,
      status: 'created',
      paykey: paykeyId,
      paykey_details: {
        id: paykeyId,
        type: 'ACH',
        status: 'active'
      },
      customer_details: {
        id: customerId,
        name: `Tenant ${index + 1}`,
        email: `tenant${index + 1}@example.com`
      },
      status_details: statusHistory[0].status_details,
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
        leaseId: TARGET_LEASE_ID,
        lease_id: TARGET_LEASE_ID,
        source: 'tenant_portal'
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
      processed_at: statusEntry.status === 'paid' ? statusEntry.timestamp : null,
      updated_at: statusEntry.timestamp
    }
  }));

  return {
    payoutId,
    invoiceId,
    events: [createdEvent, ...statusUpdateEvents],
    finalStatus,
    amount
  };
}

async function seedLeaseInvoicePayments() {
  try {
    await mongoose.connect(process.env.DB_URL.replace('/?', '/PropMv?'), {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('✓ Connected to MongoDB');
    console.log('✓ Database:', mongoose.connection.db.databaseName);
    console.log('\n' + '='.repeat(60));

    // Check if lease exists
    const Lease = require('../portals/hoa-board/modules/leasing/model/lease.model');
    const lease = await Lease.findById(TARGET_LEASE_ID).lean();

    if (!lease) {
      console.log(` Lease with ID ${TARGET_LEASE_ID} not found!`);
      console.log('   Please verify the lease ID is correct.');
      return;
    }

    console.log(`✓ Found Lease: ${lease._id}`);
    console.log(`  Property: ${lease.propertyId || 'N/A'}`);
    console.log(`  Tenant(s): ${lease.tenants?.length || 0}`);

    // Create or find invoice for this lease
    let invoice = await Invoice.findOne({
      lease_id: new mongoose.Types.ObjectId(TARGET_LEASE_ID),
      isDeleted: { $ne: true }
    }).lean();

    if (!invoice) {
      console.log('\n📝 Creating new invoice for lease...');

      // Create invoice
      const newInvoice = await Invoice.create({
        invoiceId: `INV-TEST-${Date.now()}`,
        type: 'Rent',
        status: 'Pending',
        lease_id: new mongoose.Types.ObjectId(TARGET_LEASE_ID),
        propertyId: lease.propertyId,
        propertyName: lease.propertyName || 'Test Property',
        unit: lease.unit || 'Unit 101',
        term: new Date().toISOString().split('T')[0],
        tenants: lease.tenants || [],
        invoiceItemDetails: [
          {
            invoiceItem: 'Monthly Rent',
            description: 'Rent payment for the month',
            quantity: 1,
            rate: 500.00,
            amount: 500.00
          }
        ],
        subAmount: 500.00,
        alreadyPaid: 0,
        balanceDue: 500.00,
        isPartialPaymentAllowed: true,
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
        isAllTenantSelected: true,
        generatedFrom: 'manual'
      });

      invoice = newInvoice.toObject();
      console.log(`✓ Created Invoice: ${invoice.invoiceId}`);
    } else {
      console.log(`\n✓ Found existing Invoice: ${invoice.invoiceId}`);
    }

    console.log(`  Invoice ID: ${invoice._id}`);
    console.log(`  Amount Due: $${invoice.balanceDue.toFixed(2)}`);

    // Clear existing test payment data for this invoice
    console.log('\n🗑️  Clearing existing test payment data...');
    await PaymentStatus.deleteMany({
      'data.metadata.invoiceId': invoice._id.toString()
    });
    await StraddleTransaction.deleteMany({
      invoiceId: invoice._id.toString()
    });
    await StraddleWebhookEventResponse.deleteMany({
      'response.data.metadata.invoiceId': invoice._id.toString()
    });

    console.log('\n💳 Creating payment transactions...');

    // Create 2 completed payments
    for (let i = 0; i < 2; i++) {
      const payment = generatePaymentData(invoice._id.toString(), 'complete', i);

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
        amount: payment.amount,
        currency: finalEvent.data.currency,
        paykeyId: finalEvent.data.paykey,
        accountId: finalEvent.account_id,
        invoiceId: payment.invoiceId,
        leaseId: TARGET_LEASE_ID,
        description: finalEvent.data.description,
        status: payment.finalStatus,
        metadata: finalEvent.data.metadata,
        raw: finalEvent
      });

      console.log(`  ✓ Created completed payment ${i + 1}: $${(payment.amount / 100).toFixed(2)}`);
    }

    // Create 1 in-process payment
    const inprocessPayment = generatePaymentData(invoice._id.toString(), 'inprocess', 0);

    for (const event of inprocessPayment.events) {
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

    const inprocessFinalEvent = inprocessPayment.events[inprocessPayment.events.length - 1];
    await StraddleTransaction.create({
      straddleId: inprocessPayment.payoutId,
      type: 'payout',
      amount: inprocessPayment.amount,
      currency: inprocessFinalEvent.data.currency,
      paykeyId: inprocessFinalEvent.data.paykey,
      accountId: inprocessFinalEvent.account_id,
      invoiceId: inprocessPayment.invoiceId,
      leaseId: TARGET_LEASE_ID,
      description: inprocessFinalEvent.data.description,
      status: inprocessPayment.finalStatus,
      metadata: inprocessFinalEvent.data.metadata,
      raw: inprocessFinalEvent
    });

    console.log(`  ⏳ Created in-process payment: $${(inprocessPayment.amount / 100).toFixed(2)}`);

    // Create 1 failed payment
    const failedPayment = generatePaymentData(invoice._id.toString(), 'failed', 0);

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

    const failedFinalEvent = failedPayment.events[failedPayment.events.length - 1];
    await StraddleTransaction.create({
      straddleId: failedPayment.payoutId,
      type: 'payout',
      amount: failedPayment.amount,
      currency: failedFinalEvent.data.currency,
      paykeyId: failedFinalEvent.data.paykey,
      accountId: failedFinalEvent.account_id,
      invoiceId: failedPayment.invoiceId,
      leaseId: TARGET_LEASE_ID,
      description: failedFinalEvent.data.description,
      status: failedPayment.finalStatus,
      metadata: failedFinalEvent.data.metadata,
      raw: failedFinalEvent
    });

    console.log(`   Created failed payment: $${(failedPayment.amount / 100).toFixed(2)}`);

    console.log('\n' + '='.repeat(60));
    console.log('Successfully created payment data!');
    console.log('='.repeat(60));
    console.log(`\nSummary:`);
    console.log(`  Lease ID: ${TARGET_LEASE_ID}`);
    console.log(`  Invoice ID: ${invoice._id}`);
    console.log(`  Invoice Number: ${invoice.invoiceId}`);
    console.log(`  Total Payments: 4`);
    console.log(`    - 2 Completed ($250.00, $250.00)`);
    console.log(`    - 1 In-Process ($150.00)`);
    console.log(`    - 1 Failed ($100.00)`);

    console.log(`\n🎯 Next Steps:`);
    console.log(`  1. Navigate to invoice: ${invoice._id}`);
    console.log(`  2. View the Payment Transactions section`);
    console.log(`  3. See real status progression from webhook events`);

  } catch (error) {
    console.error(' Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n✓ Database connection closed');
  }
}

if (require.main === module) {
  seedLeaseInvoicePayments()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { seedLeaseInvoicePayments };

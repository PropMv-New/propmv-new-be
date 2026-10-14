/**
 * ------------------------------------------------------------------
 * File: test-webhook.js
 * Module: Payment Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for test-webhook.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Test script for Straddle Payment Status Webhook
 * Using actual Straddle API payload structure
 * 
 * Usage: node test-webhook.js
 */

const axios = require('axios');
const logger = require('../../../../common/logger');

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3000/api/webhooks/straddle/payment-status';

const testPayloads = [
  {
    name: 'Payment Created',
    payload: {
      account_id: '857c679a-8e80-47f1-9334-39dd08ea801f',
      event_id: 'evt_test_created_001',
      event_type: 'payout.event.v1',
      data: {
        id: 'payout_test_001',
        status: 'created',
        amount: 50000,
        currency: 'usd',
        description: 'Rent payment',
        paykey: 'pk_test_123',
        paykey_details: {
          id: '033de251-fda3-4f86-90d7-2ce4000b2d51',
          customer_id: 'a773843f-e6f0-4ac0-b3df-b1dc720a4d57',
          label: 'Primary Account',
          balance: 50000
        },
        customer_details: {
          id: '03ece916-5d0e-46f7-a28a-e7f1aab1dbc3',
          name: 'John Doe',
          email: 'john@example.com',
          phone: '+1234567890',
          customer_type: 'individual'
        },
        payment_rail: 'ACH',
        consent_type: 'web',
        created_at: '2026-06-10T09:30:17.124288070',
        updated_at: '2026-06-10T09:30:17.124327198',
        metadata: {
          tenantId: 'tenant_123',
          propertyId: 'prop_456'
        }
      }
    }
  },
  {
    name: 'Payment Paid with Status Details',
    payload: {
      account_id: '857c679a-8e80-47f1-9334-39dd08ea801f',
      event_id: 'evt_test_paid_001',
      event_type: 'payout.event.v1',
      data: {
        id: 'payout_test_001',
        status: 'paid',
        amount: 50000,
        currency: 'usd',
        description: 'Rent payment completed',
        paykey: 'pk_test_123',
        payment_rail: 'ACH',
        processed_at: '2026-06-10T09:30:17.124311905',
        status_details: {
          changed_at: '2026-06-10T09:30:17.124318848',
          code: 'payment_completed',
          message: 'Payment processed successfully',
          source: 'straddle'
        },
        status_history: [
          {
            status: 'created',
            changed_at: '2026-06-10T09:30:17.124323176',
            code: 'payment_initiated'
          },
          {
            status: 'pending',
            changed_at: '2026-06-10T09:30:17.124323176',
            code: 'payment_processing'
          },
          {
            status: 'paid',
            changed_at: '2026-06-10T09:30:17.124323176',
            code: 'payment_completed'
          }
        ]
      }
    }
  },
  {
    name: 'Payment Failed',
    payload: {
      account_id: '857c679a-8e80-47f1-9334-39dd08ea801f',
      event_id: 'evt_test_failed_001',
      event_type: 'payout.event.v1',
      data: {
        id: 'payout_test_002',
        status: 'failed',
        amount: 30000,
        currency: 'usd',
        description: 'Failed payment',
        paykey: 'pk_test_456',
        payment_rail: 'ACH',
        status_details: {
          changed_at: '2026-06-10T09:30:17.124318848',
          code: 'insufficient_funds',
          message: 'Payment failed due to insufficient funds',
          reason: 'NSF',
          source: 'bank'
        }
      }
    }
  },
  {
    name: 'Payment with Related Payments (Refund)',
    payload: {
      account_id: '857c679a-8e80-47f1-9334-39dd08ea801f',
      event_id: 'evt_test_refund_001',
      event_type: 'payout.event.v1',
      data: {
        id: 'payout_test_003',
        status: 'paid',
        amount: 10000,
        currency: 'usd',
        description: 'Refund payment',
        is_refund: true,
        paykey: 'pk_test_789',
        related_payments: [
          {
            id: '614c06b0-05cc-4d48-b4cb-a2badfb2d182',
            payment_type: 'charge',
            relationship: 'refund_of'
          }
        ]
      }
    }
  },
  {
    name: 'Duplicate Event Test',
    payload: {
      account_id: '857c679a-8e80-47f1-9334-39dd08ea801f',
      event_id: 'evt_test_created_001',
      event_type: 'payout.event.v1',
      data: {
        id: 'payout_test_001',
        status: 'created',
        amount: 50000,
        currency: 'usd'
      }
    }
  }
];

async function testWebhook() {
  logger.info(`Testing webhook: ${WEBHOOK_URL}\n`);

  for (const test of testPayloads) {
    logger.info(`Testing: ${test.name}`);
    try {
      const response = await axios.post(WEBHOOK_URL, test.payload, {
        headers: { 'Content-Type': 'application/json' }
      });
      logger.info(`Success:`, response.data);
    } catch (error) {
      logger.info(` Error:`, error.response?.data || error.message);
    }
    logger.info('---\n');
  }
}

testWebhook();

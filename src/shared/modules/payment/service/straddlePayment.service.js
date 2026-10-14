/**
 * ------------------------------------------------------------------
 * File: straddlePayment.service.js
 * Module: Payment Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * invoice.service
 * ------------------------------------------------------------------
 */

const StraddleTransaction = require('../model/straddleTransaction.model');
const StraddleWebhookEventResponse = require('../model/straddleWebhookEventResponse.model');
const logger = require('../../../../common/logger');
const { ClockService, DateUtil } = require('../../../../common/date');

/**
 * Service for fetching and managing Straddle payment data linked to invoices and leases
 */
class StraddlePaymentService {
  /**
   * Fetch all Straddle transactions for a given invoice ID
   * @param {String} invoiceId - Invoice ObjectId
   * @returns {Promise<Array>} Array of Straddle transactions
   */
  async getTransactionsByInvoice(invoiceId) {
    try {
      const transactions = await StraddleTransaction.find({
        invoiceId,
        isDeleted: { $ne: true }
      })
        .sort({ createdAt: -1 })
        .lean();

      return transactions || [];
    } catch (err) {
      logger.error('[StraddlePayment] Failed to fetch transactions by invoice', {
        invoiceId,
        error: err.message
      });
      return [];
    }
  }

  /**
   * Fetch all Straddle transactions for a given lease ID
   * @param {String} leaseId - Lease ObjectId
   * @returns {Promise<Array>} Array of Straddle transactions
   */
  async getTransactionsByLease(leaseId) {
    try {
      const transactions = await StraddleTransaction.find({
        leaseId,
        isDeleted: { $ne: true }
      })
        .sort({ createdAt: -1 })
        .lean();

      return transactions || [];
    } catch (err) {
      logger.error('[StraddlePayment] Failed to fetch transactions by lease', {
        leaseId,
        error: err.message
      });
      return [];
    }
  }

  /**
   * Fetch all Straddle transactions for a given account_id
   * @param {String} accountId - Straddle account_id
   * @returns {Promise<Array>} Array of Straddle transactions
   */
  async getTransactionsByAccountId(accountId) {
    try {
      const transactions = await StraddleTransaction.find({
        accountId,
        isDeleted: { $ne: true }
      })
        .sort({ createdAt: -1 })
        .lean();

      return transactions || [];
    } catch (err) {
      logger.error('[StraddlePayment] Failed to fetch transactions by accountId', {
        accountId,
        error: err.message
      });
      return [];
    }
  }

  /**
   * Fetch webhook event responses for given transaction IDs
   * @param {Array<String>} straddleIds - Array of Straddle transaction IDs
   * @returns {Promise<Array>} Array of webhook responses
   */
  async getWebhookResponsesByTransactionIds(straddleIds) {
    if (!Array.isArray(straddleIds) || straddleIds.length === 0) {
      return [];
    }

    try {
      // Webhook responses store straddleId in data.id field of response object
      const responses = await StraddleWebhookEventResponse.find({
        'response.data.id': { $in: straddleIds }
      })
        .sort({ createdAt: -1 })
        .lean();

      return responses || [];
    } catch (err) {
      logger.error('[StraddlePayment] Failed to fetch webhook responses', {
        straddleIds,
        error: err.message
      });
      return [];
    }
  }

  /**
   * Fetch webhook event responses for a specific account_id and event_type
   * @param {String} accountId - Straddle account_id
   * @param {String} eventType - Event type (default: 'payout.event.v1')
   * @returns {Promise<Array>} Array of webhook responses
   */
  async getWebhookResponsesByAccountAndType(accountId, eventType = 'payout.event.v1') {
    try {
      const filter = { account_id: accountId };
      if (eventType) {
        filter.event_type = eventType;
      }

      const responses = await StraddleWebhookEventResponse.find(filter)
        .sort({ createdAt: -1 })
        .lean();

      return responses || [];
    } catch (err) {
      logger.error('[StraddlePayment] Failed to fetch webhook responses by account', {
        accountId,
        eventType,
        error: err.message
      });
      return [];
    }
  }

  /**
   * Fetch payout.event.v1 webhook responses only (Straddle payment status updates)
   * @param {Array<String>} straddleIds - Array of Straddle transaction IDs
   * @returns {Promise<Array>} Array of payout webhook responses
   */
  async getPayoutEventsByTransactionIds(straddleIds) {
    if (!Array.isArray(straddleIds) || straddleIds.length === 0) {
      return [];
    }

    try {
      // Filter only payout.event.v1 events
      const responses = await StraddleWebhookEventResponse.find({
        'response.data.id': { $in: straddleIds },
        event_type: 'payout.event.v1'
      })
        .sort({ createdAt: -1 })
        .lean();

      return responses || [];
    } catch (err) {
      logger.error('[StraddlePayment] Failed to fetch payout events', {
        straddleIds,
        error: err.message
      });
      return [];
    }
  }

  /**
   * Get complete payment data for an invoice including transactions and webhook responses
   * ONLY fetches payout.event.v1 webhook events for payment status tracking
   * @param {String} invoiceId - Invoice ObjectId
   * @returns {Promise<Object>} Payment data with transactions and webhook responses
   */
  async getInvoicePaymentData(invoiceId) {
    try {
      const transactions = await this.getTransactionsByInvoice(invoiceId);
      
      if (transactions.length === 0) {
        return {
          transactions: [],
          webhookResponses: [],
          paymentStatuses: []
        };
      }

      const straddleIds = transactions.map(t => t.straddleId).filter(Boolean);
      // ONLY fetch payout.event.v1 events for payment status
      const webhookResponses = await this.getPayoutEventsByTransactionIds(straddleIds);

      // Map payment statuses from webhook responses
      const paymentStatuses = this.extractPaymentStatuses(webhookResponses);

      return {
        transactions,
        webhookResponses,
        paymentStatuses
      };
    } catch (err) {
      logger.error('[StraddlePayment] Failed to get invoice payment data', {
        invoiceId,
        error: err.message
      });
      return {
        transactions: [],
        webhookResponses: [],
        paymentStatuses: []
      };
    }
  }

  /**
   * Get complete payment data for a lease including transactions and webhook responses
   * ONLY fetches payout.event.v1 webhook events for payment status tracking
   * @param {String} leaseId - Lease ObjectId
   * @returns {Promise<Object>} Payment data with transactions and webhook responses
   */
  async getLeasePaymentData(leaseId) {
    try {
      const transactions = await this.getTransactionsByLease(leaseId);
      
      if (transactions.length === 0) {
        return {
          transactions: [],
          webhookResponses: [],
          paymentStatuses: []
        };
      }

      const straddleIds = transactions.map(t => t.straddleId).filter(Boolean);
      // ONLY fetch payout.event.v1 events for payment status
      const webhookResponses = await this.getPayoutEventsByTransactionIds(straddleIds);

      // Map payment statuses from webhook responses
      const paymentStatuses = this.extractPaymentStatuses(webhookResponses);

      return {
        transactions,
        webhookResponses,
        paymentStatuses
      };
    } catch (err) {
      logger.error('[StraddlePayment] Failed to get lease payment data', {
        leaseId,
        error: err.message
      });
      return {
        transactions: [],
        webhookResponses: [],
        paymentStatuses: []
      };
    }
  }

  /**
   * Extract payment statuses from webhook responses
   * Returns ONLY actual statuses received from Straddle, not predetermined stages
   * @param {Array} webhookResponses - Array of webhook event responses
   * @returns {Array} Array of payment status objects
   */
  extractPaymentStatuses(webhookResponses) {
    if (!Array.isArray(webhookResponses)) {
      return [];
    }

    return webhookResponses.map(response => {
      const data = response.response?.data || {};
      const statusDetails = data.status_details || {};
      
      return {
        eventId: response.event_id || response.event,
        eventType: response.event_type,
        transactionId: data.id,
        status: data.status, // Actual status from Straddle
        statusCode: statusDetails.code,
        statusMessage: statusDetails.message,
        statusReason: statusDetails.reason,
        statusSource: statusDetails.source,
        amount: data.amount,
        currency: data.currency,
        paymentDate: data.payment_date,
        processedAt: data.processed_at || statusDetails.changed_at,
        statusHistory: data.status_history || [], // Full history from Straddle
        externalId: data.external_id,
        paymentRail: data.payment_rail,
        customerDetails: data.customer_details,
        paykeyDetails: data.paykey_details,
        accountId: response.account_id,
        createdAt: response.createdAt
      };
    }).filter(status => status.transactionId);
  }

  /**
   * Get payment status summary for display
   * @param {Array} paymentStatuses - Array of payment status objects
   * @returns {Object} Summary of payment statuses
   */
  getPaymentStatusSummary(paymentStatuses) {
    if (!Array.isArray(paymentStatuses) || paymentStatuses.length === 0) {
      return {
        totalTransactions: 0,
        latestStatus: null,
        allStatuses: []
      };
    }

    const sortedStatuses = [...paymentStatuses].sort((a, b) =>
      (DateUtil.toEpoch(b.createdAt) ?? 0) - (DateUtil.toEpoch(a.createdAt) ?? 0)
    );

    return {
      totalTransactions: paymentStatuses.length,
      latestStatus: sortedStatuses[0],
      allStatuses: sortedStatuses
    };
  }
}

module.exports = { StraddlePaymentService };

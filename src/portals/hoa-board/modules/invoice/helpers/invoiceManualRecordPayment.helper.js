'use strict';

const PayloadPayin = require('../../../../../shared/modules/payment/providers/payload/model/payloadPayin.model');
const {
  resolveActiveLifecyclePhase,
  LIFECYCLE_PHASE,
} = require('../../../../../shared/modules/payment/providers/payload/utils/payloadPayinLifecycle.util');
const {
  activePaymentTransactions,
  isProcessingPaymentTransaction,
  isElectronicPaymentTransaction,
  getInvoiceCollectableBalance,
} = require('./invoicePaymentTransactions.helper');

const EARLY_GATEWAY_PHASES = new Set([
  LIFECYCLE_PHASE.INITIATE,
  LIFECYCLE_PHASE.VERIFY,
]);

const RECORD_ALLOWED_GATEWAY_PHASES = new Set([
  LIFECYCLE_PHASE.PROCESS,
  LIFECYCLE_PHASE.DEPOSIT,
]);

function roundMoney(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function isManualRecordGatewayProcessingTx(tx) {
  if (!tx || tx.isDeleted === true) return false;
  if (!isProcessingPaymentTransaction(tx)) return false;
  if (tx.isManual === true) return false;
  return isElectronicPaymentTransaction(tx) || !!tx.gatewayTransactionId || !!tx.gatewayExternalId;
}

async function resolveGatewayLifecyclePhaseForTransaction(tx) {
  const gatewayId = tx.gatewayTransactionId ? String(tx.gatewayTransactionId) : '';
  if (!gatewayId) return null;

  const payin = await PayloadPayin.findOne({
    _id: gatewayId,
    isDeleted: { $ne: true },
  }).lean();
  if (!payin) return null;

  const history = payin.metadata?.payloadLifecycleHistory;
  return resolveActiveLifecyclePhase(
    Array.isArray(history) ? history : [],
    payin.status,
  );
}

function evaluateManualRecordAgainstGatewayPhases({
  collectableBalance,
  paymentAmount,
  processingGatewayTxs = [],
  phases = [],
}) {
  const amount = roundMoney(paymentAmount);
  const collectable = roundMoney(collectableBalance);
  if (collectable <= 0) {
    return {
      ok: false,
      code: 'NO_COLLECTABLE_BALANCE',
      message: 'Invoice has no remaining balance',
    };
  }

  if (!processingGatewayTxs.length) {
    return { ok: true, collectableBalance: collectable };
  }

  for (const phase of phases) {
    if (!phase || EARLY_GATEWAY_PHASES.has(phase)) {
      const processingTotal = roundMoney(
        processingGatewayTxs.reduce((sum, tx) => sum + Number(tx.amount || 0), 0),
      );
      return {
        ok: false,
        code: 'GATEWAY_PAYMENT_VERIFYING',
        message:
          `A $${processingTotal.toFixed(2)} payment is still being verified for this invoice. ` +
          'You can record another payment once it reaches processing or deposit.',
      };
    }
    if (!RECORD_ALLOWED_GATEWAY_PHASES.has(phase)) {
      const processingTotal = roundMoney(
        processingGatewayTxs.reduce((sum, tx) => sum + Number(tx.amount || 0), 0),
      );
      return {
        ok: false,
        code: 'GATEWAY_PAYMENT_NOT_READY',
        message:
          `A $${processingTotal.toFixed(2)} payment is currently being processed for this invoice. ` +
          'You can record another payment once the existing payment has completed.',
      };
    }
  }

  if (amount > collectable + 0.009) {
    return {
      ok: false,
      code: 'PAYMENT_EXCEEDS_COLLECTABLE_BALANCE',
      message:
        `Payment amount cannot exceed the remaining balance of $${collectable.toFixed(2)} ` +
        'while another payment is still processing.',
    };
  }

  return { ok: true, collectableBalance: collectable };
}

/**
 * Board manual Record Payment while owner/gateway pay-in is in flight.
 * Blocks Initiate/Verify; allows Process/Deposit up to collectable balance.
 */
async function assertManualRecordPaymentAllowed(invoice, paymentAmount) {
  const collectable = roundMoney(getInvoiceCollectableBalance(invoice));
  const processingGatewayTxs = activePaymentTransactions(invoice).filter(isManualRecordGatewayProcessingTx);
  const phases = processingGatewayTxs.length
    ? await Promise.all(processingGatewayTxs.map((tx) => resolveGatewayLifecyclePhaseForTransaction(tx)))
    : [];

  const evaluation = evaluateManualRecordAgainstGatewayPhases({
    collectableBalance: collectable,
    paymentAmount,
    processingGatewayTxs,
    phases,
  });

  if (!evaluation.ok) {
    throw Object.assign(new Error(evaluation.message), {
      status: 400,
      code: evaluation.code,
    });
  }

  return { allowed: true, collectableBalance: evaluation.collectableBalance };
}

module.exports = {
  assertManualRecordPaymentAllowed,
  evaluateManualRecordAgainstGatewayPhases,
  EARLY_GATEWAY_PHASES,
  RECORD_ALLOWED_GATEWAY_PHASES,
  isManualRecordGatewayProcessingTx,
};

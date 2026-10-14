'use strict';

const { PAYIN_STATUS } = require('../constants/payload.constants');
const { normalizePayinStatus } = require('./payloadPayinSettlement.util');
const {
  isAchLikeMethodType,
  isInstantSettleMethodType,
} = require('./payloadPaymentMethodType.util');

const LIFECYCLE_PHASE = {
  INITIATE: 'initiate',
  VERIFY: 'verify',
  PROCESS: 'process',
  DEPOSIT: 'deposit',
  COMPLETE: 'complete',
};

const PHASE_ORDER = [
  LIFECYCLE_PHASE.INITIATE,
  LIFECYCLE_PHASE.VERIFY,
  LIFECYCLE_PHASE.PROCESS,
  LIFECYCLE_PHASE.DEPOSIT,
  LIFECYCLE_PHASE.COMPLETE,
];

const PHASE_LABELS = {
  [LIFECYCLE_PHASE.INITIATE]: { label: 'Initiate', details: 'Start payment' },
  [LIFECYCLE_PHASE.VERIFY]: { label: 'Verify', details: 'Verify details' },
  [LIFECYCLE_PHASE.PROCESS]: { label: 'Process', details: 'Process payment' },
  [LIFECYCLE_PHASE.DEPOSIT]: { label: 'Deposit', details: 'Deposit funds' },
  [LIFECYCLE_PHASE.COMPLETE]: { label: 'Complete', details: 'Payment completed' },
};

function phaseIndex(phase) {
  const idx = PHASE_ORDER.indexOf(phase);
  return idx === -1 ? 0 : idx;
}

function normalizeEventType(eventType) {
  return String(eventType || '')
    .trim()
    .toLowerCase()
    .replace(/^payin\./, '');
}

function inferLifecyclePhaseFromSignals({
  remote = {},
  eventType = '',
  methodType = '',
  payinStatus = '',
} = {}) {
  const evt = normalizeEventType(eventType);
  const statusRaw = String(remote?.status || remote?.value || payinStatus || '').trim();
  const normalizedPayinStatus = normalizePayinStatus(statusRaw || payinStatus);
  const funding = String(remote?.funding_status || remote?.fundingStatus || '').toLowerCase();
  const risk = String(remote?.risk_flag || remote?.riskFlag || '').toLowerCase();

  if (normalizedPayinStatus === PAYIN_STATUS.FAILED
    || normalizedPayinStatus === PAYIN_STATUS.RETURNED
    || normalizedPayinStatus === PAYIN_STATUS.CANCELED) {
    return null;
  }
  if (['decline', 'void', 'reject'].includes(evt)) return null;

  if (normalizedPayinStatus === PAYIN_STATUS.SUCCEEDED) {
    if (funding && funding !== 'settled' && funding !== 'completed' && isAchLikeMethodType(methodType)) {
      return LIFECYCLE_PHASE.DEPOSIT;
    }
    return LIFECYCLE_PHASE.COMPLETE;
  }

  if (evt === 'authorized' || risk === 'in_review' || normalizedPayinStatus === PAYIN_STATUS.IN_REVIEW) {
    return LIFECYCLE_PHASE.VERIFY;
  }

  if (evt === 'processed' || String(statusRaw).toUpperCase() === 'PROCESSED') {
    if (funding === 'settled' || funding === 'completed') {
      return LIFECYCLE_PHASE.COMPLETE;
    }
    if (funding === 'pending' || funding === 'processing' || isAchLikeMethodType(methodType)) {
      return LIFECYCLE_PHASE.DEPOSIT;
    }
    return isInstantSettleMethodType(methodType)
      ? LIFECYCLE_PHASE.COMPLETE
      : LIFECYCLE_PHASE.DEPOSIT;
  }

  if (evt === 'processing' || normalizedPayinStatus === PAYIN_STATUS.PROCESSING) {
    return LIFECYCLE_PHASE.PROCESS;
  }

  if (evt === 'payment' || evt === 'created') {
    const upper = String(statusRaw).toUpperCase();
    if (upper === 'AUTHORIZED') return LIFECYCLE_PHASE.VERIFY;
    if (upper === 'PROCESSING' || upper === 'PENDING') return LIFECYCLE_PHASE.PROCESS;
    if (upper === 'PROCESSED') return LIFECYCLE_PHASE.DEPOSIT;
    return LIFECYCLE_PHASE.INITIATE;
  }

  if (normalizedPayinStatus === PAYIN_STATUS.CREATED) {
    return LIFECYCLE_PHASE.INITIATE;
  }

  return LIFECYCLE_PHASE.PROCESS;
}

function appendPayloadPayinLifecycleFromRemote(
  history = [],
  {
    remote = {},
    eventType = '',
    methodType = '',
    payinStatus = '',
    at = null,
  } = {},
) {
  const rows = Array.isArray(history) ? [...history] : [];
  const timestamp = at || remote?.updated_at || remote?.updatedAt || new Date().toISOString();
  const phase = inferLifecyclePhaseFromSignals({
    remote,
    eventType,
    methodType,
    payinStatus,
  });

  const pushPhase = (targetPhase, details) => {
    if (!targetPhase) return;
    const last = rows[rows.length - 1];
    if (last?.phase === targetPhase) return;
    rows.push({
      phase: targetPhase,
      timestamp,
      details: details || PHASE_LABELS[targetPhase]?.details || '',
      eventType: normalizeEventType(eventType) || undefined,
    });
  };

  if (rows.length === 0) {
    pushPhase(LIFECYCLE_PHASE.INITIATE, PHASE_LABELS[LIFECYCLE_PHASE.INITIATE].details);
  }

  if (phase) {
    pushPhase(phase, PHASE_LABELS[phase]?.details);
  }

  // Ensure monotonic progression (never go backwards).
  rows.sort((a, b) => phaseIndex(a.phase) - phaseIndex(b.phase));
  const deduped = [];
  for (const row of rows) {
    const prev = deduped[deduped.length - 1];
    if (prev?.phase === row.phase) continue;
    deduped.push(row);
  }
  return deduped;
}

function resolveActiveLifecyclePhase(history = [], payinStatus = '') {
  const normalized = normalizePayinStatus(payinStatus);
  if (normalized === PAYIN_STATUS.SUCCEEDED) return LIFECYCLE_PHASE.COMPLETE;
  if (normalized === PAYIN_STATUS.FAILED
    || normalized === PAYIN_STATUS.RETURNED
    || normalized === PAYIN_STATUS.CANCELED) {
    return history[history.length - 1]?.phase || LIFECYCLE_PHASE.PROCESS;
  }
  if (history.length === 0) return LIFECYCLE_PHASE.INITIATE;
  return history[history.length - 1].phase;
}

/**
 * Build invoice Payment Transactions stepper stages from Payload lifecycle history.
 */
function buildPayloadLifecycleStages(history = [], payinStatus = '') {
  const activePhase = resolveActiveLifecyclePhase(history, payinStatus);
  const activeIdx = phaseIndex(activePhase);
  const reached = new Set(history.map((row) => row.phase));

  return PHASE_ORDER.map((phase, idx) => {
    const meta = PHASE_LABELS[phase];
    const historyRow = history.find((row) => row.phase === phase);
    let status = 'pending';
    if (phaseIndex(phase) < activeIdx || (reached.has(phase) && phase !== activePhase)) {
      status = 'completed';
    } else if (phase === activePhase) {
      status = activePhase === LIFECYCLE_PHASE.COMPLETE ? 'completed' : 'active';
    } else if (normalizePayinStatus(payinStatus) === PAYIN_STATUS.SUCCEEDED && phase === LIFECYCLE_PHASE.COMPLETE) {
      status = 'completed';
    }

    return {
      id: phase,
      phase,
      label: meta.label,
      details: historyRow?.details || meta.details,
      timestamp: historyRow?.timestamp || undefined,
      status,
    };
  });
}

module.exports = {
  LIFECYCLE_PHASE,
  PHASE_ORDER,
  inferLifecyclePhaseFromSignals,
  appendPayloadPayinLifecycleFromRemote,
  resolveActiveLifecyclePhase,
  buildPayloadLifecycleStages,
};

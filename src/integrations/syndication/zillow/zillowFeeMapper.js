/**
 * ------------------------------------------------------------------
 * File: zillowFeeMapper.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillowFeeMapper.
 *
 * Used By:
 * zillowXmlBuilder
 * ------------------------------------------------------------------
 */

const {
  ZILLOW_FEE_CALCULATION_TYPE,
  ZILLOW_FEE_TYPE,
  ZILLOW_FEE_TIMING_TYPE,
  ZILLOW_FEE_REQUIREMENT_TYPE,
  ZILLOW_FEE_REFUNDABLE_TYPE,
} = require('./zillow.constants');

/**
 * Maps internal listing pricing fields to Zillow <fees> XML blocks (HotPads v2.1).
 */
function mapListingFeesToZillow(listing, config = {}) {
  const fees = [];
  const rent = Number(listing.rentalAmount || listing.price || 0);
  const deposit = Number(listing.securityDeposit || 0);
  const applicationFee = Number(
    listing.applicationFee ?? config.applicationFee ?? 50
  );

  if (deposit > 0) {
    const useMultiplier = rent > 0 && deposit === rent;
    fees.push({
      feeType: ZILLOW_FEE_TYPE.SECURITY_DEPOSIT,
      feeCalculationType: useMultiplier
        ? ZILLOW_FEE_CALCULATION_TYPE.MULTIPLIER
        : ZILLOW_FEE_CALCULATION_TYPE.FLAT_FEE,
      value: useMultiplier ? '1.0' : String(deposit),
      valueType: useMultiplier ? 'multiplier' : 'flatFee',
      operandType: useMultiplier ? 'rent' : undefined,
      detailedCalculation: useMultiplier ? '1x rent' : undefined,
      feeTimingType: ZILLOW_FEE_TIMING_TYPE.MOVE_IN,
      feeRequirementType: ZILLOW_FEE_REQUIREMENT_TYPE.MANDATORY,
      feeRefundableType: ZILLOW_FEE_REFUNDABLE_TYPE.REFUNDABLE,
    });
  }

  if (applicationFee > 0) {
    fees.push({
      feeType: ZILLOW_FEE_TYPE.APPLICATION_FEE,
      feeCalculationType: ZILLOW_FEE_CALCULATION_TYPE.FLAT_FEE,
      value: String(applicationFee),
      valueType: 'flatFee',
      feeTimingType: 'atApplication',
      feeRequirementType: ZILLOW_FEE_REQUIREMENT_TYPE.MANDATORY,
      feeRefundableType: ZILLOW_FEE_REFUNDABLE_TYPE.NON_REFUNDABLE,
    });
  }

  if (listing.fees && Array.isArray(listing.fees)) {
    listing.fees.forEach((fee) => {
      if (!fee || typeof fee !== 'object') return;
      fees.push({
        feeType: String(fee.feeType || ''),
        feeCalculationType: String(fee.feeCalculationType || ''),
        value: String(fee.value ?? fee.feeAmount ?? ''),
        valueType: String(fee.valueType || fee.feeCalculationType || 'flatFee'),
        operandType: fee.operandType != null ? String(fee.operandType) : undefined,
        detailedCalculation: fee.detailedCalculation != null ? String(fee.detailedCalculation) : undefined,
        feeTimingType: String(fee.feeTimingType || ''),
        feeRequirementType: String(fee.feeRequirementType || ''),
        feeRefundableType: fee.feeRefundableType != null ? String(fee.feeRefundableType) : undefined,
      });
    });
  }

  return fees;
}

/**
 * build Fee Calculation Type Xml
 *
 * Performs logic operations for buildFeeCalculationTypeXml.
 *
 * @param fee - Request/input argument
 * @param escapeXmlText - Request/input argument
 * @returns Operations result
 */
function buildFeeCalculationTypeXml(fee, escapeXmlText) {
  const attrs = [
    `value="${escapeXmlText(fee.value ?? fee.feeAmount ?? '')}"`,
    `valueType="${escapeXmlText(fee.valueType || fee.feeCalculationType || 'flatFee')}"`,
  ];
  if (fee.operandType) {
    attrs.push(`operandType="${escapeXmlText(fee.operandType)}"`);
  }

  const detailed = fee.detailedCalculation
    ? `\n        <detailedCalculation>${escapeXmlText(fee.detailedCalculation)}</detailedCalculation>`
    : '';

  return `        <feeCalculationType ${attrs.join(' ')}>${detailed}\n        </feeCalculationType>`;
}

/**
 * Builds XML string for a <fees> block (HotPads v2.1 nested structure).
 */
function buildFeesXml(fees, escapeXmlText) {
  if (!fees || fees.length === 0) return '';

  const feeXml = fees.map((fee) => {
    const lines = [
      '      <fee>',
      buildFeeCalculationTypeXml(fee, escapeXmlText),
      `        <feeType>${escapeXmlText(fee.feeType)}</feeType>`,
      `        <feeTimingType>${escapeXmlText(fee.feeTimingType)}</feeTimingType>`,
      `        <feeRequirementType>${escapeXmlText(fee.feeRequirementType)}</feeRequirementType>`,
    ];
    if (fee.feeRefundableType) {
      lines.push(`        <feeRefundableType>${escapeXmlText(fee.feeRefundableType)}</feeRefundableType>`);
    }
    lines.push('      </fee>');
    return lines.join('\n');
  }).join('\n');

  return `    <fees>\n${feeXml}\n    </fees>`;
}

module.exports = {
  mapListingFeesToZillow,
  buildFeesXml,
};

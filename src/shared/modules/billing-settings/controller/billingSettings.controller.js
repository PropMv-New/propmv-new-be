/**
 * ------------------------------------------------------------------
 * File: billingSettings.controller.js
 * Module: Billing Settings Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * billingSettings.routes
 * ------------------------------------------------------------------
 */

const responseHelper = require('../../../../common/helpers/responseHelper');
const billingSettingsService = require('../service/billingSettings.service');

/**
 * map Paid By From Client
 *
 * Performs logic operations for mapPaidByFromClient.
 *
 * @param fees - Request/input argument
 * @returns Operations result
 */
function mapPaidByFromClient(fees = {}) {
  const mapValue = (value) => {
    if (value === 'charge_me' || value === 'operator') return 'operator';
    if (value === 'charge_tenant' || value === 'charge_owner' || value === 'payer') return 'payer';
    return value;
  };

  return {
    bankTransfer: fees.bankTransfer
      ? {
          ...fees.bankTransfer,
          paidBy: mapValue(fees.bankTransfer.paidBy),
        }
      : undefined,
    card: fees.card
      ? {
          ...fees.card,
          paidBy: mapValue(fees.card.paidBy),
        }
      : undefined,
  };
}

const getHoaBillingSettings = async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const data = await billingSettingsService.getHoaBillingSettings(userId, req.hoaContext || null);
    return responseHelper.success(res, data, 'Billing settings fetched', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to fetch billing settings', err.status || 400);
  }
};

const upsertHoaBillingSettings = async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const payload = {
      ...req.body,
      transactionFees: mapPaidByFromClient(req.body?.transactionFees),
    };
    const data = await billingSettingsService.upsertHoaBillingSettings(
      userId,
      req.hoaContext || null,
      payload,
    );
    return responseHelper.success(res, data, 'Billing settings saved', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to save billing settings', err.status || 400);
  }
};

const getOperatorBillingSettings = async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const data = await billingSettingsService.getOperatorBillingSettings(userId);
    return responseHelper.success(res, data, 'Billing settings fetched', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to fetch billing settings', err.status || 400);
  }
};

const upsertOperatorBillingSettings = async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const payload = {
      ...req.body,
      transactionFees: mapPaidByFromClient(req.body?.transactionFees),
    };
    const data = await billingSettingsService.upsertOperatorBillingSettings(userId, payload);
    return responseHelper.success(res, data, 'Billing settings saved', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to save billing settings', err.status || 400);
  }
};

const getEffectiveBillingSettings = async (req, res) => {
  try {
    const { propertyId } = req.query;
    const data = await billingSettingsService.getEffectiveBillingSettingsForProperty(propertyId);
    return responseHelper.success(res, data, 'Effective billing settings fetched', 200);
  } catch (err) {
    return responseHelper.error(res, err.message || 'Failed to fetch billing settings', err.status || 400);
  }
};

module.exports = {
  getHoaBillingSettings,
  upsertHoaBillingSettings,
  getOperatorBillingSettings,
  upsertOperatorBillingSettings,
  getEffectiveBillingSettings,
};

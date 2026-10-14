/**
 * ------------------------------------------------------------------
 * File: paymentManagement.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * landlord
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const paymentManagementController = require('../controller/paymentManagement.controller');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const {
  validateGetPaymentManagement,
  validateGetPaymentSummary,
  validateAssignLandlord,
  validateUpsertPaymentSettings,
} = require('../validators/paymentManagement.validator');

/**
 * @route GET /api/landlord/payment-management/settings
 * @desc Get payment settings for all properties
 * @access Private
 */
router.get(
  '/settings',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  paymentManagementController.getPaymentSettings
);

/**
 * @route POST /api/landlord/payment-management/settings
 * @desc Create or update payment settings for a property
 * @access Private
 */
router.post(
  '/settings',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateUpsertPaymentSettings,
  paymentManagementController.upsertPaymentSettings
);

/**
 * @route GET /api/landlord/payment-management
 * @desc Get payment management data for all properties
 * @access Private - Requires VIEW_PAYMENT_MANAGEMENT privilege
 */
router.get(
  '/',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateGetPaymentManagement,
  paymentManagementController.getPaymentManagement
);

/**
 * @route GET /api/landlord/payment-management/summary
 * @desc Get payment summary/overview
 * @access Private - Requires VIEW_PAYMENT_MANAGEMENT privilege
 */
router.get(
  '/summary',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateGetPaymentSummary,
  paymentManagementController.getPaymentSummary
);

/**
 * @route GET /api/landlord/payment-management/:propertyId
 * @desc Get payment details for a specific property
 * @access Private - Requires VIEW_PAYMENT_MANAGEMENT privilege
 */
router.get(
  '/:propertyId',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  paymentManagementController.getPaymentManagementDetail
);

/**
 * @route PUT /api/landlord/payment-management/:propertyId/assign-landlord
 * @desc Assign or update landlord for a property
 * @access Private - Requires VIEW_PAYMENT_MANAGEMENT privilege
 */
router.put(
  '/:propertyId/assign-landlord',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateAssignLandlord,
  paymentManagementController.assignLandlord
);

/**
 * @route POST /api/landlord/payment-management/:propertyId/record-payment
 * @desc Record a payment made to landlord
 * @access Private - Requires VIEW_PAYMENT_MANAGEMENT privilege
 */
router.post(
  '/:propertyId/record-payment',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  paymentManagementController.recordPaymentToLandlord
);

/**
 * @route GET /api/landlord/payment-management/:propertyId/payment-history
 * @desc Get payment history for a property
 * @access Private - Requires VIEW_PAYMENT_MANAGEMENT privilege
 */
router.get(
  '/:propertyId/payment-history',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  paymentManagementController.getPaymentHistoryForProperty
);

module.exports = router;

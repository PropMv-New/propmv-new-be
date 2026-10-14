/**
 * ------------------------------------------------------------------
 * File: activityLogger.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for activityLogger.
 *
 * Used By:
 * invoice.routes, owner.routes, property.routes
 * ------------------------------------------------------------------
 */

// Dynamic service loading based on portal context
const getActivityService = (req) => {
  const portal = req.baseUrl?.includes('/hoa-board') ? 'hoa-board' : 'landlord';
  return require(`../portals/${portal}/modules/dashboard/service/dashboard.service`);
};

/**
 * Activity Logger Middleware
 * 
 * This middleware automatically logs user activities across the application by:
 * 1. Intercepting successful HTTP responses (200-299 status codes)
 * 2. Extracting user information from the request (userId, role)
 * 3. Creating activity records with configurable titles, descriptions, and metadata
 * 4. Supporting dynamic content generation through function-based configuration
 * 
 * Features:
 * - Automatic activity logging on successful operations
 * - Role-based activity categorization
 * - Support for property-specific activities
 * - Configurable activity patterns for common operations
 * - Non-blocking logging (uses setImmediate to avoid response delays)
 * 
 * Usage:
 * ```javascript
 * router.post('/invoice', activityLogger({
 *   type: 'invoice',
 *   title: 'Invoice Created',
 *   description: (req, res, data) => `Invoice for $${data.amount} created`
 * }), createInvoice);
 * ```
 */
const activityLogger = (activityConfig) => {
  return async (req, res, next) => {
    const originalJson = res.json;
    
    res.json = function(data) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        setImmediate(async () => {
          try {
            const userId = req.userId || req.user?._id;
            const userRole = req.user?.role?.name || req.user?.role || 'user';
            
            if (!userId) return;

            const activityData = {
              performedBy: userId,
              performedByRole: userRole.toLowerCase(),
              ...activityConfig
            };

            if (typeof activityConfig.title === 'function') {
              activityData.title = activityConfig.title(req, res, data);
            }
            if (typeof activityConfig.description === 'function') {
              activityData.description = activityConfig.description(req, res, data);
            }
            if (typeof activityConfig.propertyId === 'function') {
              activityData.propertyId = activityConfig.propertyId(req, res, data);
            }
            if (typeof activityConfig.amount === 'function') {
              activityData.amount = activityConfig.amount(req, res, data);
            }

            const { logActivity } = getActivityService(req);
            await logActivity(activityData);
          } catch (error) {
            const logger = require('../common/logger');
            logger.error('Error logging activity', { error: error.message });
          }
        });
      }
      
      return originalJson.call(this, data);
    };
    
    next();
  };
};

/**
 * Pre-built Activity Patterns for Common Operations
 * 
 * This object provides reusable activity logging configurations for common
 * business operations. Each pattern includes:
 * - Standardized activity type and title
 * - Dynamic description generation based on request/response data
 * - Property and amount extraction for financial activities
 * - HOA-specific activity flagging
 * 
 * Available Patterns:
 * - invoiceCreated: For invoice creation activities with amount tracking
 * 
 * Usage:
 * ```javascript
 * router.post('/invoice', 
 *   activityLogger(ActivityPatterns.invoiceCreated(
 *     (req) => req.body.propertyId,
 *     (req) => req.body.amount
 *   )), 
 *   createInvoice
 * );
 * ```
 */
const ActivityPatterns = {
  invoiceCreated: (propertyIdExtractor, amountExtractor) => ({
    type: 'invoice',
    title: 'Invoice Created',
    description: (req, res, data) => {
      const amount = typeof amountExtractor === 'function' ? amountExtractor(req, res, data) : amountExtractor;
      return `Invoice for $${amount} created`;
    },
    propertyId: propertyIdExtractor,
    amount: amountExtractor,
    invoiceId: (req, res, data) => data.data?._id || data._id,
    isHOAActivity: true
  })
};

module.exports = {
  activityLogger,
  ActivityPatterns
};
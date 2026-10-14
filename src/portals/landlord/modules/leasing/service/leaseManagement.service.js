/**
 * ------------------------------------------------------------------
 * File: leaseManagement.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * lease.controller
 * ------------------------------------------------------------------
 */

const Lease = require('../model/lease.model');
const { LEASE_STATUSES } = require('../../../../../common/constants/lease');
const { activateLeaseService } = require('./leaseActivation.service');
const { renewLeaseService } = require('./lease.service');
const logger = require('../../../../../common/logger');
const { ClockService } = require('../../../../../common/date');
const { getTodayStartAndTomorrowStart } = require('../../../../../common/helpers/hoaBillingDates');
const { computeRenewalDates } = require('../helpers/leaseDate.helpers');

function getTodayRange() {
  const { todayStart, tomorrowStart } = getTodayStartAndTomorrowStart();
  if (!todayStart || !tomorrowStart) {
    throw new Error('Unable to resolve business timezone day boundaries');
  }
  return { todayStart, tomorrowStart };
}

/**
 * Step 1: Activate leases that are approved and have start date as today
 */
async function activateLeasesStep() {
  logger.info('Step 1 - Activate lease step: Starting');
  
  const { todayStart, tomorrowStart } = getTodayRange();
  
  try {
    // Fetch all leases where status is Approved and start_date is today
    const leasesToActivate = await Lease.find({
      status: LEASE_STATUSES.APPROVED,
      start_date: { $gte: todayStart, $lt: tomorrowStart },
      isDeleted: { $ne: true }
    }).lean();
    
    logger.info(`Step 1 - Found ${leasesToActivate.length} leases to activate`);
    
    const results = {
      total: leasesToActivate.length,
      activated: [],
      failed: []
    };
    
    // Activate each lease
    for (const lease of leasesToActivate) {
      try {
        await activateLeaseService(lease._id);
        results.activated.push({
          leaseId: lease._id,
          message: 'Lease activated successfully'
        });
        logger.info(`Step 1 - Lease activated successfully: ${lease._id}`);
      } catch (error) {
        results.failed.push({
          leaseId: lease._id,
          error: error.message
        });
        logger.error(`Step 1 - Failed to activate lease: ${lease._id}`, { error: error.message });
      }
    }
    
    logger.info(`Step 1 - Activate lease step completed: ${results.activated.length} activated, ${results.failed.length} failed`);
    
    return results;
  } catch (error) {
    logger.error('Step 1 - Activate lease step failed', { error: error.message });
    throw error;
  }
}

/**
 * Step 2: Expire leases that are active, have end date as today, and auto_renew is false
 */
async function expireLeasesStep() {
  logger.info('Step 2 - Expire lease step: Starting');
  
  const { todayStart, tomorrowStart } = getTodayRange();
  
  try {
    // Fetch all leases where status is Active, end_date is today, and auto_renew is false
    const leasesToExpire = await Lease.find({
      status: LEASE_STATUSES.ACTIVE,
      end_date: { $gte: todayStart, $lt: tomorrowStart },
      auto_renew: { $ne: true },
      isDeleted: { $ne: true }
    }).lean();
    
    logger.info(`Step 2 - Found ${leasesToExpire.length} leases to expire`);
    
    const results = {
      total: leasesToExpire.length,
      expired: [],
      failed: []
    };
    
    // Mark each lease as expired
    for (const lease of leasesToExpire) {
      try {
        await Lease.findByIdAndUpdate(
          lease._id,
          { status: LEASE_STATUSES.EXPIRED },
          { new: true }
        );
        results.expired.push({
          leaseId: lease._id,
          message: 'Lease expired successfully'
        });
        logger.info(`Step 2 - Lease expired successfully: ${lease._id}`);
      } catch (error) {
        results.failed.push({
          leaseId: lease._id,
          error: error.message
        });
        logger.error(`Step 2 - Failed to expire lease: ${lease._id}`, { error: error.message });
      }
    }
    
    logger.info(`Step 2 - Expire lease step completed: ${results.expired.length} expired, ${results.failed.length} failed`);
    
    return results;
  } catch (error) {
    logger.error('Step 2 - Expire lease step failed', { error: error.message });
    throw error;
  }
}

/**
 * Step 3: Renew leases that are active, have end date as today, and auto_renew is true
 */
async function renewLeasesStep() {
  logger.info('Step 3 - Renew lease step: Starting');
  
  const { todayStart, tomorrowStart } = getTodayRange();
  
  try {
    // Fetch all leases where status is Active, end_date is today, and auto_renew is true
    const leasesToRenew = await Lease.find({
      status: LEASE_STATUSES.ACTIVE,
      end_date: { $gte: todayStart, $lt: tomorrowStart },
      auto_renew: true,
      isDeleted: { $ne: true }
    }).lean();
    
    logger.info(`Step 3 - Found ${leasesToRenew.length} leases to renew`);
    
    const results = {
      total: leasesToRenew.length,
      renewed: [],
      failed: []
    };
    
    // Renew each lease
    for (const lease of leasesToRenew) {
      try {
        const { newStartDate, newEndDate, previousEndDate } = computeRenewalDates(lease);
        
        const renewalData = {
          start_date: newStartDate,
          end_date: newEndDate,
          rentDetails: lease.rentDetails,
          depositDetails: lease.depositDetails,
          additionalFees: lease.additionalFees,
          rentAndDepositDestribution: lease.rentAndDepositDestribution,
          property_id: lease.property_id,
          unitId: lease.unitId,
          unitName: lease.unitName,
          leaseTerm: lease.leaseTerm,
          lease_type: lease.lease_type,
          auto_renew: lease.auto_renew,
          requireInsurance: lease.requireInsurance,
          insuranceTenantsIds: lease.insuranceTenantsIds,
        };
        
        // Use 'Renew And Extend' to extend the existing lease
        await renewLeaseService(lease._id, { 
          type: 'Renew And Extend', 
          leaseData: renewalData 
        });
        
        results.renewed.push({
          leaseId: lease._id,
          message: 'Lease renewed successfully',
          newStartDate: newStartDate,
          newEndDate: newEndDate
        });
        logger.info(`Step 3 - Lease renewed successfully: ${lease._id}`, {
          oldEndDate: previousEndDate,
          newStartDate: newStartDate,
          newEndDate: newEndDate
        });
      } catch (error) {
        results.failed.push({
          leaseId: lease._id,
          error: error.message
        });
        logger.error(`Step 3 - Failed to renew lease: ${lease._id}`, { error: error.message });
      }
    }
    
    logger.info(`Step 3 - Renew lease step completed: ${results.renewed.length} renewed, ${results.failed.length} failed`);
    
    return results;
  } catch (error) {
    logger.error('Step 3 - Renew lease step failed', { error: error.message });
    throw error;
  }
}

/**
 * Process complete lease lifecycle: activate, expire, and renew leases
 */
async function processLeaseLifecycleService() {
  logger.info('Starting lease lifecycle processing');
  
  const results = {
    activateStep: null,
    expireStep: null,
    renewStep: null,
    timestamp: ClockService.now()
  };
  
  try {
    // Step 1: Activate leases
    results.activateStep = await activateLeasesStep();
    
    // Step 2: Expire leases
    results.expireStep = await expireLeasesStep();
    
    // Step 3: Renew leases
    results.renewStep = await renewLeasesStep();
    
    logger.info('Lease lifecycle processing completed successfully', {
      activated: results.activateStep.activated.length,
      expired: results.expireStep.expired.length,
      renewed: results.renewStep.renewed.length
    });
    
    return results;
  } catch (error) {
    logger.error('Lease lifecycle processing failed', { error: error.message });
    throw error;
  }
}

module.exports = {
  processLeaseLifecycleService,
  activateLeasesStep,
  expireLeasesStep,
  renewLeasesStep
};

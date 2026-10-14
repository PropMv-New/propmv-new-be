'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const { ClockService } = require('../date');
const { dailySchedule } = require('../../config/dailySchedule.config');
const SchedulerLock = require('./schedulerLock.model');

function getSchedulerWorkerId() {
  return `${process.pid}-${uuidv4().slice(0, 8)}`;
}

/**
 * Try to acquire a MongoDB-backed leader lock for a scheduler run.
 * Prevents duplicate daily triggers when multiple API instances are running.
 */
async function tryAcquireSchedulerLeaderLock(lockKey, options = {}) {
  if (options.enabled === false || dailySchedule.leaderLockEnabled === false) {
    return { acquired: true, skippedLock: true };
  }

  const workerId = options.workerId || getSchedulerWorkerId();
  const lockMs = options.lockMs || dailySchedule.leaderLockMs;
  const now = ClockService.now();
  const lockedUntil = new Date(now.getTime() + lockMs);

  try {
    await SchedulerLock.create({
      lockKey,
      lockedBy: workerId,
      lockedAt: now,
      lockedUntil,
    });
    return { acquired: true, workerId, lockKey };
  } catch (err) {
    if (!err || err.code !== 11000) {
      logger.warn('[SchedulerLeaderLock] Lock create failed', {
        lockKey,
        error: err?.message || err,
      });
      return { acquired: false, reason: 'error', workerId, lockKey };
    }
  }

  const stolen = await SchedulerLock.findOneAndUpdate(
    {
      lockKey,
      lockedUntil: { $lte: now },
    },
    {
      $set: {
        lockedBy: workerId,
        lockedAt: now,
        lockedUntil,
      },
    },
    { new: true }
  ).lean();

  if (stolen) {
    return { acquired: true, workerId, lockKey, reclaimed: true };
  }

  return { acquired: false, reason: 'held_by_peer', workerId, lockKey };
}

async function releaseSchedulerLeaderLock(lockKey, workerId) {
  if (!lockKey || !workerId) return;
  try {
    await SchedulerLock.deleteOne({ lockKey, lockedBy: workerId });
  } catch (err) {
    logger.warn('[SchedulerLeaderLock] Release failed', {
      lockKey,
      error: err?.message || err,
    });
  }
}

/**
 * Wrap a scheduler callback with leader-lock acquisition.
 */
async function withSchedulerLeaderLock(name, dateKey, fn, options = {}) {
  const lockKey = `scheduler:${name}:${dateKey}`;
  const lock = await tryAcquireSchedulerLeaderLock(lockKey, options);
  if (!lock.acquired) {
    logger.info(`[${name}] Skipping run - leader lock held by another instance`, {
      lockKey,
      reason: lock.reason,
    });
    return { skipped: true, reason: 'leader_lock', lockKey };
  }

  try {
    return await fn();
  } finally {
    if (!lock.skippedLock) {
      await releaseSchedulerLeaderLock(lockKey, lock.workerId);
    }
  }
}

module.exports = {
  getSchedulerWorkerId,
  tryAcquireSchedulerLeaderLock,
  releaseSchedulerLeaderLock,
  withSchedulerLeaderLock,
};

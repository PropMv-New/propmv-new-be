'use strict';

/**
 * Injectable clock for production code and unit tests.
 * Replace `new Date()` / `Date.now()` with ClockService so time can be frozen in tests.
 */
let fixedInstant = null;

const ClockService = {
  /**
   * Current instant as a Date (always UTC internally).
   * @returns {Date}
   */
  now() {
    return fixedInstant != null ? new Date(fixedInstant) : new Date();
  },

  /** @returns {number} Epoch milliseconds. */
  nowEpoch() {
    return this.now().getTime();
  },

  /**
   * Freeze time for tests. Pass ISO string, epoch ms, or Date.
   * @param {string|number|Date|null} instant
   */
  setFixedTime(instant) {
    if (instant == null) {
      fixedInstant = null;
      return;
    }
    fixedInstant = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  },

  /** Restore live system clock. */
  reset() {
    fixedInstant = null;
  },

  /** @returns {boolean} */
  isFixed() {
    return fixedInstant != null;
  },
};

module.exports = ClockService;

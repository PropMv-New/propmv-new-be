'use strict';

/**
 * Central date/time constants for PropMv.
 * MongoDB stores UTC Date objects; HOA business logic uses America/New_York.
 */
const TIMEZONE = Object.freeze({
  UTC: 'UTC',
  EST: 'America/New_York',
  /** Canonical business timezone (Richmond, VA / US East). */
  BUSINESS: process.env.APP_TIMEZONE || 'America/New_York',
});

const TIMEZONE_LABEL = Object.freeze({
  BUSINESS: process.env.APP_TIMEZONE_LABEL || 'US Eastern (America/New_York)',
});

/** Mongo $dateToString timezone (IANA casing required). */
const MONGO_DATE_EXPR_TIMEZONE =
  process.env.HOA_MONGO_TIMEZONE || TIMEZONE.BUSINESS;

const FORMAT = Object.freeze({
  ISO: 'iso',
  EPOCH: 'epoch',
  DATE_ONLY: 'yyyy-MM-dd',
  /** Default UI date: "Jul 25, 2026" */
  DEFAULT_UI_DATE: Object.freeze({
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  }),
  /** Default UI datetime: "Jul 25, 2026, 02:30 PM" */
  DEFAULT_UI_DATETIME: Object.freeze({
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }),
  /** Default UI time: "2:30 PM" */
  DEFAULT_UI_TIME: Object.freeze({
    hour: 'numeric',
    minute: '2-digit',
  }),
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

module.exports = {
  TIMEZONE,
  TIMEZONE_LABEL,
  MONGO_DATE_EXPR_TIMEZONE,
  FORMAT,
  MS_PER_DAY,
};

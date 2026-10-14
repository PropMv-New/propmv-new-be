const Joi = require('joi');
const { moneyAmountOptional } = require('../../../../../common/validators/money.schema');

/** Aligns with HOA starting-balance due limit and Manage HOA Fee UI. */
const MAX_RECURRING_FEE_AMOUNT = 1_000_000;

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const hoaIdParamSchema = Joi.object({
  hoaId: Joi.string().pattern(objectIdRegex).required(),
});

const lateFeeRuleSchema = Joi.object({
  lateFeeType: Joi.string().trim().allow('', null),
  feeAmount: moneyAmountOptional({ min: 0, preserveNull: true }),
  gracePeriod: Joi.number().integer().min(0).allow(null),
  isRepeat: Joi.boolean(),
  repeatEvery: Joi.number().integer().min(1).allow(null),
  repeatEndAfter: Joi.number().integer().min(1).allow(null),
  applicableScope: Joi.string().valid('none', 'all', 'specific'),
  applicableUnits: Joi.array().items(Joi.string()),
  chargeEachUnpaidTenat: Joi.boolean(),
}).unknown(true);

const reminderIntervalSchema = Joi.object({
  daysBefore: Joi.number().integer().min(1).max(90),
  daysAfter: Joi.number().integer().min(1).max(365),
  enabled: Joi.boolean(),
}).or('daysBefore', 'daysAfter');

const paymentRemindersSchema = Joi.object({
  enabled: Joi.boolean(),
  timezone: Joi.string().trim().allow('', null),
  channels: Joi.object({
    email: Joi.boolean(),
    inApp: Joi.boolean(),
    push: Joi.boolean(),
  }).unknown(true),
  beforeDueDate: Joi.object({
    enabled: Joi.boolean(),
    intervals: Joi.array().items(
      Joi.object({
        daysBefore: Joi.number().integer().min(1).max(90).required(),
        enabled: Joi.boolean(),
      })
    ),
  }).unknown(true),
  onDueDate: Joi.boolean(),
  afterDueDate: Joi.object({
    enabled: Joi.boolean(),
    intervals: Joi.array().items(
      Joi.object({
        daysAfter: Joi.number().integer().min(1).max(365).required(),
        enabled: Joi.boolean(),
      })
    ),
    continueOverdueReminders: Joi.boolean(),
    overdueFrequencyDays: Joi.number().integer().min(1).max(30),
    maxOverdueReminders: Joi.number().integer().min(1).max(52),
  }).unknown(true),
  respectGracePeriod: Joi.boolean(),
  templates: Joi.object({
    beforeDue: Joi.object({ subject: Joi.string().allow(''), body: Joi.string().allow('') }),
    onDueDate: Joi.object({ subject: Joi.string().allow(''), body: Joi.string().allow('') }),
    overdue: Joi.object({ subject: Joi.string().allow(''), body: Joi.string().allow('') }),
  }).unknown(true),
}).unknown(true);

const upsertHoaSettingsSchema = Joi.object({
  recurringFee: Joi.object({
    enabled: Joi.boolean(),
    amount: moneyAmountOptional({ min: 0, max: MAX_RECURRING_FEE_AMOUNT }),
    frequency: Joi.string().valid('monthly', 'quarterly', 'annually'),
    tenure: Joi.number().integer().min(1).max(5),
  }).unknown(true),
  paymentTerm: Joi.object({
    dueDay: Joi.number().integer().min(1).max(28),
    gracePeriodDays: Joi.number().integer().min(0).max(365),
    acceptPartialPayments: Joi.boolean(),
  }).unknown(true),
  paymentReminders: paymentRemindersSchema,
  lateFees: Joi.array().items(lateFeeRuleSchema),
  lateFee: Joi.object({
    enabled: Joi.boolean(),
    applyAfterDays: Joi.number().integer().min(0),
    initialType: Joi.string().valid('flat', 'percentage'),
    initialAmount: moneyAmountOptional({ min: 0 }),
    initialPercentage: Joi.number().min(0).max(100),
    dailyEnabled: Joi.boolean(),
    dailyType: Joi.string().valid('flat', 'percentage'),
    dailyAmount: moneyAmountOptional({ min: 0 }),
    dailyPercentage: Joi.number().min(0).max(100),
    maxAmount: moneyAmountOptional({ min: 0, preserveNull: true }),
  }).unknown(true),
})
  .or('recurringFee', 'paymentTerm', 'lateFee', 'lateFees', 'paymentReminders')
  .unknown(true);

module.exports = {
  MAX_RECURRING_FEE_AMOUNT,
  hoaIdParamSchema,
  upsertHoaSettingsSchema,
};

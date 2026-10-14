'use strict';

/** System/default expense categories (shared HOA + landlord). */
const SYSTEM_EXPENSE_CATEGORIES = Object.freeze([
  'Advertising',
  'Appliance',
  'Bank Fees',
  'Capital Improvements',
  'Cleaning',
  'Commissions',
  'Depreciation',
  'Eviction',
  'Insurance',
  'Legal and Professional Fees',
  'Licenses and Permits',
  'Maintenance and Repairs',
  'Management Fees',
  'Mortgage and Loans',
  'Mortgage Interest',
  'Office',
  'Other Expense',
  'Other Interest',
  'Repairs',
  'Supplies',
  'Taxes',
  'Travel and Transportation',
  'Utilities',
  'Vehicles',
  'Wages and Salaries',
]);

const EXPENSE_CUSTOM_CATEGORY_TYPE = 'Expense_Custom_Category';
const EXPENSE_CUSTOM_CATEGORY_KEY = 'Expense_Custom_Categories';

module.exports = {
  SYSTEM_EXPENSE_CATEGORIES,
  EXPENSE_CUSTOM_CATEGORY_TYPE,
  EXPENSE_CUSTOM_CATEGORY_KEY,
};

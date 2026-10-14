const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  consolidateLateFeeLineItems,
  upsertLateFeeLineItem,
} = require('./lateFeeLineItems.helper');

describe('lateFeeLineItems.helper', () => {
  it('consolidates duplicate late fee rows into one row with quantity', () => {
    const items = [
      { invoiceItem: 'Monthly Fee', description: 'Fee', quantity: 1, rate: 110, amount: 110 },
      { invoiceItem: 'Late Fee', description: 'Late fee #1', quantity: 1, rate: 11, amount: 11 },
      { invoiceItem: 'Late Fee', description: 'Late fee #2', quantity: 1, rate: 11, amount: 11 },
      { invoiceItem: 'Late Fee', description: 'Late fee #3', quantity: 1, rate: 11, amount: 11 },
      { invoiceItem: 'Late Fee', description: 'Late fee #4', quantity: 1, rate: 11, amount: 11 },
      { invoiceItem: 'Late Fee', description: 'Late fee #5', quantity: 1, rate: 11, amount: 11 },
    ];

    const consolidated = consolidateLateFeeLineItems(items);

    assert.equal(consolidated.length, 2);
    const lateFee = consolidated.find((row) => row.invoiceItem === 'Late Fee');
    assert.ok(lateFee);
    assert.equal(lateFee.quantity, 5);
    assert.equal(lateFee.rate, 11);
    assert.equal(lateFee.amount, 55);
  });

  it('keeps initial and daily late fees separate when labels differ', () => {
    const items = [
      { invoiceItem: 'Initial Late Fee', description: 'Initial', quantity: 1, rate: 11, amount: 11 },
      { invoiceItem: 'Daily Late Fee', description: 'Day 2', quantity: 1, rate: 11, amount: 11 },
      { invoiceItem: 'Daily Late Fee', description: 'Day 3', quantity: 1, rate: 11, amount: 11 },
    ];

    const consolidated = consolidateLateFeeLineItems(items);
    assert.equal(consolidated.length, 2);
    const daily = consolidated.find((row) => row.invoiceItem === 'Daily Late Fee');
    assert.equal(daily.quantity, 2);
    assert.equal(daily.amount, 22);
  });

  it('upserts late fee line items by label and rate', () => {
    let details = [{ invoiceItem: 'Late Fee', description: 'First', quantity: 1, rate: 11, amount: 11 }];
    details = upsertLateFeeLineItem(details, {
      lineItemLabel: 'Late Fee',
      description: 'Second',
      amount: 11,
    });

    assert.equal(details.length, 1);
    assert.equal(details[0].quantity, 2);
    assert.equal(details[0].amount, 22);
  });
});

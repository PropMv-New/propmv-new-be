'use strict';

const {
  buildPayloadTransactionChargeBody,
  resolvePayloadChargeCustomerId,
  validateRemotePaymentMethodForCharge,
} = require('./payloadPayinCharge.util');

describe('payloadPayinCharge.util', () => {
  describe('buildPayloadTransactionChargeBody', () => {
    it('includes payer fee in amount and never sends conv_fee', () => {
      const body = buildPayloadTransactionChargeBody({
        netAmount: 100,
        totalCharge: 103.5,
        amountValidation: {
          processingFeePaidBy: 'payer',
          processingFeeAmount: 3.5,
        },
        customerId: 'acct_cust',
        paymentMethodId: 'pm_abc',
        merchantId: 'acct_merch',
        settlementBankId: 'pm_deposit',
        description: 'Invoice 1',
        metadata: { invoiceId: 'inv1' },
        clientIp: '127.0.0.1',
      });

      expect(body.amount).toBe(103.5);
      expect(body.conv_fee).toBeUndefined();
      expect(body.customer_id).toBe('acct_cust');
      expect(body.payment_method_id).toBe('pm_abc');
      expect(body.processing_method_id).toBe('pm_deposit');
      expect(body.initiator).toEqual({ ip: '127.0.0.1' });
    });

    it('charges net only when operator pays fees', () => {
      const body = buildPayloadTransactionChargeBody({
        netAmount: 50,
        totalCharge: 50,
        amountValidation: {
          processingFeePaidBy: 'operator',
          processingFeeAmount: 0,
        },
        customerId: 'acct_cust',
        paymentMethodId: 'pm_abc',
        merchantId: 'acct_merch',
        metadata: {},
      });

      expect(body.amount).toBe(50);
      expect(body.processing_method_id).toBeUndefined();
    });
  });

  describe('resolvePayloadChargeCustomerId', () => {
    it('prefers remote customer_id over local', () => {
      expect(resolvePayloadChargeCustomerId({
        localCustomerId: 'acct_local',
        remotePaymentMethod: { customer_id: 'acct_remote' },
        processingAccountId: 'acct_merch',
      })).toBe('acct_remote');
    });

    it('does not treat account_id as customer when only processing account is set', () => {
      expect(resolvePayloadChargeCustomerId({
        localCustomerId: 'acct_owner',
        remotePaymentMethod: { account_id: 'acct_merch', status: 'active' },
        processingAccountId: 'acct_merch',
      })).toBe('acct_owner');
    });
  });

  describe('validateRemotePaymentMethodForCharge', () => {
    it('throws when status is inactive', () => {
      expect(() => validateRemotePaymentMethodForCharge({ status: 'inactive' })).toThrow(/not active/);
    });
  });
});

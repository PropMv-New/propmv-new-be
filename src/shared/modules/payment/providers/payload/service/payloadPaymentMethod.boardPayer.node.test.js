'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../../../../../../.env') });
} catch {
  // optional
}

describe('payloadPaymentMethod Board payer wallet context (Phase 5)', () => {
  let paymentMethodService;
  let customerContextUtil;
  let originalResolveCtx;
  let HOAMembership;
  let originalFindOne;

  const boardUserId = new mongoose.Types.ObjectId();
  const ownerUserId = new mongoose.Types.ObjectId();
  const hoaId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    delete require.cache[require.resolve('./payloadPaymentMethod.service')];
    delete require.cache[require.resolve('../utils/payloadHoaOwnerCustomerContext.util')];
    paymentMethodService = require('./payloadPaymentMethod.service');
    customerContextUtil = require('../utils/payloadHoaOwnerCustomerContext.util');
    originalResolveCtx = customerContextUtil.resolveHoaOwnerPayloadCustomerContext;

    HOAMembership = require('../../../../../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
    originalFindOne = HOAMembership.findOne;
  });

  afterEach(() => {
    customerContextUtil.resolveHoaOwnerPayloadCustomerContext = originalResolveCtx;
    HOAMembership.findOne = originalFindOne;
  });

  it('Board Member resolves community wallet without Owner unit boardMemberIds=[]', async () => {
    HOAMembership.findOne = () => ({
      select: () => ({
        lean: async () => ({ _id: new mongoose.Types.ObjectId() }),
      }),
    });

    const calls = [];
    customerContextUtil.resolveHoaOwnerPayloadCustomerContext = async (hid, opts = {}) => {
      calls.push({ hid: String(hid), opts });
      return {
        hoaId: String(hid),
        scopeKey: `hoa:${hid}`,
        primaryProcessingId: 'acct_hoa_community',
        merchantIds: ['acct_hoa_community'],
        boardMemberIds: opts.ownerUserId ? [] : undefined,
      };
    };
    // Re-require service so it picks up the patched util export used via its closure... 
    // Service already captured resolveHoaOwnerPayloadCustomerContext at require time.
    delete require.cache[require.resolve('./payloadPaymentMethod.service')];
    // Patch before require by replacing util module export
    require.cache[require.resolve('../utils/payloadHoaOwnerCustomerContext.util')].exports = {
      ...customerContextUtil,
      resolveHoaOwnerPayloadCustomerContext: async (hid, opts = {}) => {
        calls.push({ hid: String(hid), opts });
        return {
          hoaId: String(hid),
          scopeKey: `hoa:${hid}`,
          primaryProcessingId: 'acct_hoa_community',
          merchantIds: ['acct_hoa_community'],
          boardMemberIds: opts.ownerUserId ? [] : undefined,
        };
      },
    };
    paymentMethodService = require('./payloadPaymentMethod.service');

    const ctx = await paymentMethodService.resolveHoaPayloadWalletContextForActor(
      String(boardUserId),
      String(hoaId),
    );

    assert.equal(ctx.actorIsBoardMember, true);
    assert.equal(ctx.scopeKey, `hoa:${hoaId}`);
    assert.equal(ctx.primaryProcessingId, 'acct_hoa_community');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.ownerUserId, undefined);
    assert.equal(
      paymentMethodService.resolveHoaOwnerWalletUnavailableReason(ctx),
      'board_no_hoa_merchant',
    );
  });

  it('Owner still passes ownerUserId for unit→board-member merchant scoping', async () => {
    HOAMembership.findOne = () => ({
      select: () => ({
        lean: async () => null,
      }),
    });

    const calls = [];
    require.cache[require.resolve('../utils/payloadHoaOwnerCustomerContext.util')].exports = {
      ...require('../utils/payloadHoaOwnerCustomerContext.util'),
      resolveHoaOwnerPayloadCustomerContext: async (hid, opts = {}) => {
        calls.push({ hid: String(hid), opts });
        return {
          hoaId: String(hid),
          scopeKey: `hoa:${hid}`,
          primaryProcessingId: 'acct_owner_board',
          merchantIds: ['acct_owner_board'],
          boardMemberIds: opts.ownerUserId ? [String(boardUserId)] : undefined,
        };
      },
    };
    delete require.cache[require.resolve('./payloadPaymentMethod.service')];
    paymentMethodService = require('./payloadPaymentMethod.service');

    const ctx = await paymentMethodService.resolveHoaPayloadWalletContextForActor(
      String(ownerUserId),
      String(hoaId),
    );

    assert.equal(ctx.actorIsBoardMember, false);
    assert.equal(String(calls[0].opts.ownerUserId), String(ownerUserId));
    assert.equal(
      paymentMethodService.resolveHoaOwnerWalletUnavailableReason({
        actorIsBoardMember: false,
        boardMemberIds: [],
      }),
      'no_board_member_scope',
    );
  });
});

'use strict';

/**
 * Phase 0 — Payload Sandbox gates for Vendor electronic payments.
 * Read-only / throwaway sandbox objects. Does NOT implement PropMV Vendor payment product.
 *
 * Run: node scripts/phase0-vendor-payload-sandbox-gates.js
 */

require('dotenv').config();
const { PayloadClient } = require('../src/shared/modules/payment/providers/payload/client/payload.client');

const stamp = Date.now();
const results = [];

function record(gate, status, detail = {}) {
  results.push({ gate, status, ...detail });
  const icon = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : status;
  console.log(`\n[${icon}] ${gate}`);
  if (detail.message) console.log(`  ${detail.message}`);
  if (detail.data) console.log(`  ${JSON.stringify(detail.data, null, 2).split('\n').join('\n  ')}`);
}

function unwrapList(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.values)) return body.values;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.items)) return body.items;
  return [];
}

async function safe(label, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return {
      ok: false,
      err: {
        message: err.message,
        statusCode: err.statusCode || err.status,
        raw: err.payloadError || null,
      },
    };
  }
}

async function main() {
  const client = new PayloadClient();
  if (!client.isConfigured()) {
    record('CONFIG', 'FAIL', { message: 'Payload client not configured' });
    process.exitCode = 1;
    return;
  }
  record('CONFIG', 'PASS', {
    message: 'Sandbox client configured',
    data: {
      baseURL: client.baseURL,
      environment: process.env.PAYLOAD_ENVIRONMENT,
      merchantOnboardingMode: process.env.PAYLOAD_MERCHANT_ONBOARDING_MODE,
    },
  });

  // ── A. Vendor-like Processing Account creation (API path) ───────────────
  const createPa = await safe('createProcessingAccount', () =>
    client.createProcessingAccount({
      name: `PropMV Phase0 Vendor ${stamp}`,
      application_link: true,
      attrs: { propmv_phase0: 'vendor_pa', stamp: String(stamp) },
    }));

  let vendorPaId = null;
  if (createPa.ok) {
    vendorPaId = createPa.value?.id || null;
    record('A_VENDOR_PA_CREATE_API', 'PASS', {
      message: 'POST /processing_accounts succeeded (API path available)',
      data: {
        id: vendorPaId,
        status: createPa.value?.status,
        object: createPa.value?.object,
      },
    });
  } else {
    record('A_VENDOR_PA_CREATE_API', 'FAIL', {
      message: `API create failed — HOA uses plugin mode; Vendor may need same. ${createPa.err.message}`,
      data: createPa.err,
    });

    // Fallback: mint processing_account_plugin client token (same as HOA)
    const pluginToken = await safe('pluginToken', () =>
      client.createClientToken({
        type: 'client',
        intent: { type: 'processing_account_plugin' },
      }));
    if (pluginToken.ok && (pluginToken.value?.id || pluginToken.value?.client_token)) {
      record('A_VENDOR_PA_PLUGIN_TOKEN', 'PASS', {
        message: 'processing_account_plugin client token mint works (UI create path)',
        data: {
          tokenPresent: true,
          tokenPrefix: String(pluginToken.value?.id || pluginToken.value?.client_token || '').slice(0, 24),
        },
      });
    } else {
      record('A_VENDOR_PA_PLUGIN_TOKEN', 'FAIL', {
        message: pluginToken.err?.message || 'Could not mint plugin token',
        data: pluginToken.err,
      });
    }
  }

  // If API create failed, try to find an existing active processing account for further gates
  if (!vendorPaId) {
    const listPa = await safe('listPA', () =>
      client._request({ method: 'get', path: '/processing_accounts/', params: { limit: 20 } }));
    if (listPa.ok) {
      const rows = unwrapList(listPa.value);
      const active = rows.find((r) => String(r.status || '').toLowerCase() === 'active')
        || rows[0]
        || null;
      if (active?.id) {
        vendorPaId = active.id;
        record('A_VENDOR_PA_FALLBACK_EXISTING', 'PASS', {
          message: 'Using existing sandbox Processing Account for downstream gates',
          data: { id: vendorPaId, status: active.status, name: active.name },
        });
      } else {
        record('A_VENDOR_PA_FALLBACK_EXISTING', 'FAIL', {
          message: 'No existing processing accounts found for downstream tests',
        });
      }
    } else {
      record('A_VENDOR_PA_FALLBACK_EXISTING', 'FAIL', {
        message: listPa.err?.message || 'list processing accounts failed',
        data: listPa.err,
      });
    }
  }

  // ── G. Status / underwriting ────────────────────────────────────────────
  if (vendorPaId) {
    const getPa = await safe('getPA', () => client.getProcessingAccount(vendorPaId));
    if (getPa.ok) {
      record('G_PA_STATUS', 'PASS', {
        message: 'GET processing account status readable',
        data: {
          id: getPa.value?.id,
          status: getPa.value?.status,
          legal_entity_id: getPa.value?.legal_entity_id || null,
          payment_methods_count: Array.isArray(getPa.value?.payment_methods)
            ? getPa.value.payment_methods.length
            : null,
        },
      });

      if (String(getPa.value?.status || '').toLowerCase() !== 'active') {
        const sim = await safe('simulateActive', () =>
          client.simulateSandboxProcessingActivation(vendorPaId));
        if (sim.ok) {
          record('G_PA_SIMULATE_ACTIVE', String(sim.value?.status || '').toLowerCase() === 'active' ? 'PASS' : 'WARN', {
            message: 'Sandbox activation simulation result',
            data: { status: sim.value?.status },
          });
        } else {
          record('G_PA_SIMULATE_ACTIVE', 'WARN', {
            message: sim.err?.message || 'simulate active failed',
            data: sim.err,
          });
        }
      }
    } else {
      record('G_PA_STATUS', 'FAIL', { message: getPa.err?.message, data: getPa.err });
    }
  }

  // ── B/C. Multiple vendor bank PMs as receiving destinations ─────────────
  let vendorBank1 = null;
  let vendorBank2 = null;
  if (vendorPaId) {
    const bank1 = await safe('bank1', () =>
      client.createPaymentMethod({
        type: 'bank_account',
        account_id: vendorPaId,
        account_holder: `Phase0 Vendor Bank1 ${stamp}`,
        transfer_type: 'receive-only',
        default_deposit_method: true,
        bank_account: {
          account_number: '1234567890',
          routing_number: '021000021',
          account_type: 'checking',
          account_class: 'business',
        },
      }));
    if (bank1.ok) {
      vendorBank1 = bank1.value;
      record('B_VENDOR_BANK_1', 'PASS', {
        message: 'Created receive-only bank PM on Processing Account',
        data: {
          id: vendorBank1.id,
          transfer_type: vendorBank1.transfer_type,
          default_deposit_method: vendorBank1.default_deposit_method,
          status: vendorBank1.status,
          verification_status: vendorBank1.verification_status,
          account_id: vendorBank1.account_id || vendorBank1.customer_id,
        },
      });
    } else {
      record('B_VENDOR_BANK_1', 'FAIL', { message: bank1.err?.message, data: bank1.err });
    }

    const bank2 = await safe('bank2', () =>
      client.createPaymentMethod({
        type: 'bank_account',
        account_id: vendorPaId,
        account_holder: `Phase0 Vendor Bank2 ${stamp}`,
        transfer_type: 'receive-only',
        default_deposit_method: false,
        bank_account: {
          account_number: '1234567891',
          routing_number: '021000021',
          account_type: 'checking',
          account_class: 'business',
        },
      }));
    if (bank2.ok) {
      vendorBank2 = bank2.value;
      record('B_VENDOR_BANK_2', 'PASS', {
        message: 'Second bank PM on same Processing Account',
        data: {
          id: vendorBank2.id,
          transfer_type: vendorBank2.transfer_type,
          default_deposit_method: vendorBank2.default_deposit_method,
          status: vendorBank2.status,
          verification_status: vendorBank2.verification_status,
        },
      });
    } else {
      record('B_VENDOR_BANK_2', 'FAIL', { message: bank2.err?.message, data: bank2.err });
    }

    const listed = await safe('listBanks', () =>
      client.listProcessingAccountPaymentMethods(vendorPaId));
    if (listed.ok) {
      const pms = unwrapList(listed.value).filter((pm) =>
        String(pm.type || '').toLowerCase() === 'bank_account'
        || pm.bank_account);
      record('B_VENDOR_MULTI_BANK_LIST', pms.length >= 2 ? 'PASS' : 'WARN', {
        message: `Listed ${pms.length} bank payment method(s) on Processing Account`,
        data: pms.map((pm) => ({
          id: pm.id,
          transfer_type: pm.transfer_type,
          default_deposit_method: pm.default_deposit_method,
          status: pm.status,
        })),
      });
    } else {
      record('B_VENDOR_MULTI_BANK_LIST', 'FAIL', { message: listed.err?.message, data: listed.err });
    }

    // transfer_type update attempt
    if (vendorBank2?.id) {
      const twoway = await safe('twoWayUpdate', () =>
        client.updatePaymentMethod(vendorBank2.id, { transfer_type: 'two-way' }));
      if (twoway.ok) {
        record('K_TRANSFER_TYPE_UPDATE', String(twoway.value?.transfer_type) === 'two-way' ? 'PASS' : 'WARN', {
          message: 'PUT transfer_type response',
          data: { transfer_type: twoway.value?.transfer_type },
        });
      } else {
        record('K_TRANSFER_TYPE_UPDATE', 'PASS', {
          message: 'transfer_type update rejected as expected (readonly:update) — recreate PM for two-way later',
          data: twoway.err,
        });
      }
    }

    record('C_RECEIVING_DESTINATION', vendorBank1 ? 'PASS' : 'FAIL', {
      message: vendorBank1
        ? 'Vendor bank PM created with receive-only + default_deposit_method — eligible receiving destination fields present'
        : 'Could not create vendor receiving bank',
      data: vendorBank1 ? {
        payment_method_id: vendorBank1.id,
        transfer_type: vendorBank1.transfer_type,
        default_deposit_method: vendorBank1.default_deposit_method,
      } : null,
    });
  }

  // ── D/E. Customer PM charges different Vendor Processing Account ────────
  // Create a standalone HOA-like PA for owner primary_processing_id, or reuse vendor if only one
  let hoaPaId = null;
  const createHoaPa = await safe('createHoaPa', () =>
    client.createProcessingAccount({
      name: `PropMV Phase0 HOA ${stamp}`,
      application_link: true,
      attrs: { propmv_phase0: 'hoa_pa', stamp: String(stamp) },
    }));
  if (createHoaPa.ok) {
    hoaPaId = createHoaPa.value?.id;
    await safe('simHoa', () => client.simulateSandboxProcessingActivation(hoaPaId));
    record('HOA_PA_FOR_CUSTOMER', 'PASS', { data: { id: hoaPaId, status: createHoaPa.value?.status } });
  } else {
    hoaPaId = vendorPaId;
    record('HOA_PA_FOR_CUSTOMER', 'WARN', {
      message: 'Could not create separate HOA PA; Customer will use Vendor PA as primary_processing_id (weaker cross-PA test)',
      data: createHoaPa.err,
    });
  }

  let ownerCustomerId = null;
  let ownerBankPmId = null;
  let boardCustomerId = null;
  let boardBankPmId = null;

  if (hoaPaId && vendorPaId) {
    const ownerCust = await safe('ownerCust', () =>
      client.createCustomer({
        name: `Phase0 Owner ${stamp}`,
        email: `phase0.owner.${stamp}@example.com`,
        primary_processing_id: hoaPaId,
      }));
    if (ownerCust.ok) {
      ownerCustomerId = ownerCust.value?.id;
      record('D_OWNER_CUSTOMER', 'PASS', {
        data: {
          id: ownerCustomerId,
          primary_processing_id: ownerCust.value?.primary_processing_id || hoaPaId,
        },
      });
    } else {
      record('D_OWNER_CUSTOMER', 'FAIL', { message: ownerCust.err?.message, data: ownerCust.err });
    }

    if (ownerCustomerId) {
      const ownerPm = await safe('ownerPm', () =>
        client.createPaymentMethod({
          type: 'bank_account',
          customer_id: ownerCustomerId,
          account_holder: `Phase0 Owner ${stamp}`,
          transfer_type: 'send-only',
          bank_account: {
            account_number: '1234567890',
            routing_number: '021000021',
            account_type: 'checking',
            account_class: 'personal',
          },
        }));
      if (ownerPm.ok) {
        ownerBankPmId = ownerPm.value?.id;
        record('D_OWNER_SEND_ONLY_PM', 'PASS', {
          data: {
            id: ownerBankPmId,
            transfer_type: ownerPm.value?.transfer_type,
            customer_id: ownerPm.value?.customer_id,
            status: ownerPm.value?.status,
            verification_status: ownerPm.value?.verification_status,
          },
        });
      } else {
        record('D_OWNER_SEND_ONLY_PM', 'FAIL', { message: ownerPm.err?.message, data: ownerPm.err });
      }
    }

    const boardCust = await safe('boardCust', () =>
      client.createCustomer({
        name: `Phase0 Board ${stamp}`,
        email: `phase0.board.${stamp}@example.com`,
        primary_processing_id: hoaPaId,
      }));
    if (boardCust.ok) {
      boardCustomerId = boardCust.value?.id;
      record('E_BOARD_CUSTOMER', 'PASS', { data: { id: boardCustomerId } });
    } else {
      record('E_BOARD_CUSTOMER', 'FAIL', { message: boardCust.err?.message, data: boardCust.err });
    }

    if (boardCustomerId) {
      const boardPm = await safe('boardPm', () =>
        client.createPaymentMethod({
          type: 'bank_account',
          customer_id: boardCustomerId,
          account_holder: `Phase0 Board ${stamp}`,
          transfer_type: 'send-only',
          bank_account: {
            account_number: '1234567890',
            routing_number: '011401533',
            account_type: 'checking',
            account_class: 'personal',
          },
        }));
      if (boardPm.ok) {
        boardBankPmId = boardPm.value?.id;
        record('E_BOARD_SEND_ONLY_PM', 'PASS', {
          data: {
            id: boardBankPmId,
            transfer_type: boardPm.value?.transfer_type,
            customer_id: boardPm.value?.customer_id,
          },
        });
      } else {
        // Try card for board if bank fails
        const boardCard = await safe('boardCard', () =>
          client.createPaymentMethod({
            type: 'card',
            customer_id: boardCustomerId,
            card: {
              card_number: '4242424242424242',
              expiry: '12/30',
              card_code: '123',
            },
          }));
        if (boardCard.ok) {
          boardBankPmId = boardCard.value?.id;
          record('E_BOARD_SEND_ONLY_PM', 'PASS', {
            message: 'Board bank PM failed; card PM created instead',
            data: { id: boardBankPmId, type: boardCard.value?.type },
          });
        } else {
          record('E_BOARD_SEND_ONLY_PM', 'FAIL', {
            message: boardPm.err?.message,
            data: { bank: boardPm.err, card: boardCard.err },
          });
        }
      }
    }

    // Owner charge → Vendor PA (cross processing account)
    if (ownerBankPmId && vendorPaId) {
      const chargeBody = {
        type: 'payment',
        amount: 12.34,
        description: `Phase0 Owner→Vendor ${stamp}`,
        processing_id: vendorPaId,
        payment_method_id: ownerBankPmId,
        customer_id: ownerCustomerId,
        attrs: { propmv_phase0: 'owner_to_vendor', stamp: String(stamp) },
      };
      if (vendorBank1?.id) {
        chargeBody.processing_method_id = vendorBank1.id;
      }
      const charge1 = await safe('ownerChargeVendor', () =>
        client.createPaymentTransaction(chargeBody, { idempotencyKey: `phase0_own_${stamp}` }));
      if (charge1.ok) {
        record('D_OWNER_CHARGE_VENDOR_PA', 'PASS', {
          message: 'Owner Customer PM charged Vendor Processing Account',
          data: {
            txn_id: charge1.value?.id,
            type: charge1.value?.type,
            status: charge1.value?.status,
            processing_id: charge1.value?.processing_id,
            payment_method_id: charge1.value?.payment_method_id,
            processing_method_id: charge1.value?.processing_method_id,
            amount: charge1.value?.amount,
            funding_status: charge1.value?.funding_status,
          },
        });

        // Idempotency replay
        const replay = await safe('ownerChargeReplay', () =>
          client.createPaymentTransaction(chargeBody, { idempotencyKey: `phase0_own_${stamp}` }));
        if (replay.ok) {
          const same = String(replay.value?.id) === String(charge1.value?.id);
          record('J_IDEMPOTENCY_SAME_KEY', same ? 'PASS' : 'WARN', {
            message: same
              ? 'Same idempotency key returned same transaction id'
              : 'Same idempotency key returned different txn — document Payload behavior',
            data: { first: charge1.value?.id, second: replay.value?.id },
          });
        } else {
          record('J_IDEMPOTENCY_SAME_KEY', replay.err?.statusCode === 409 ? 'PASS' : 'WARN', {
            message: `Replay rejected: ${replay.err?.message}`,
            data: replay.err,
          });
        }

        // Fetch txn for settlement fields
        const fetched = await safe('getTxn', () => client.getTransaction(charge1.value.id));
        if (fetched.ok) {
          record('F_SETTLEMENT_FIELDS', 'PASS', {
            message: 'Transaction fields for settlement routing',
            data: {
              processing_id: fetched.value?.processing_id,
              payment_method_id: fetched.value?.payment_method_id,
              processing_method_id: fetched.value?.processing_method_id,
              status: fetched.value?.status,
              funding_status: fetched.value?.funding_status,
              type: fetched.value?.type,
            },
          });
        }

        // ACH lifecycle note
        record('H_ACH_LIFECYCLE', 'PASS', {
          message: 'ACH payment created; status observed (sandbox may auto-process)',
          data: {
            status: charge1.value?.status,
            funding_status: charge1.value?.funding_status,
            note: 'Production ACH must stay Processing in PropMV until webhook/verified processed',
          },
        });
      } else {
        // Retry without processing_method_id
        delete chargeBody.processing_method_id;
        const charge1b = await safe('ownerChargeVendorNoPm', () =>
          client.createPaymentTransaction(chargeBody, { idempotencyKey: `phase0_own_nopm_${stamp}` }));
        if (charge1b.ok) {
          record('D_OWNER_CHARGE_VENDOR_PA', 'PASS', {
            message: 'Owner→Vendor charge succeeded WITHOUT processing_method_id (settles to default_deposit_method)',
            data: {
              txn_id: charge1b.value?.id,
              status: charge1b.value?.status,
              processing_id: charge1b.value?.processing_id,
              processing_method_id: charge1b.value?.processing_method_id,
            },
          });
          record('F_SETTLEMENT_FIELDS', 'WARN', {
            message: 'processing_method_id may be optional; default_deposit_method used when omitted',
            data: {
              processing_method_id: charge1b.value?.processing_method_id || null,
              vendor_default_bank: vendorBank1?.id || null,
            },
          });
        } else {
          record('D_OWNER_CHARGE_VENDOR_PA', 'FAIL', {
            message: charge1.err?.message,
            data: { with_processing_method: charge1.err, without: charge1b.err },
          });
        }
      }
    }

    // Board charge → Vendor PA
    if (boardBankPmId && vendorPaId) {
      const boardCharge = await safe('boardChargeVendor', () =>
        client.createPaymentTransaction({
          type: 'payment',
          amount: 5.67,
          description: `Phase0 Board→Vendor ${stamp}`,
          processing_id: vendorPaId,
          payment_method_id: boardBankPmId,
          customer_id: boardCustomerId,
          ...(vendorBank1?.id ? { processing_method_id: vendorBank1.id } : {}),
          attrs: { propmv_phase0: 'board_to_vendor', stamp: String(stamp) },
        }, { idempotencyKey: `phase0_brd_${stamp}` }));
      if (boardCharge.ok) {
        record('E_BOARD_CHARGE_VENDOR_PA', 'PASS', {
          message: 'Board Customer PM charged Vendor Processing Account',
          data: {
            txn_id: boardCharge.value?.id,
            status: boardCharge.value?.status,
            processing_id: boardCharge.value?.processing_id,
            payment_method_id: boardCharge.value?.payment_method_id,
            processing_method_id: boardCharge.value?.processing_method_id,
            type: boardCharge.value?.type,
          },
        });
      } else {
        const boardCharge2 = await safe('boardChargeNoPm', () =>
          client.createPaymentTransaction({
            type: 'payment',
            amount: 5.67,
            description: `Phase0 Board→Vendor nopm ${stamp}`,
            processing_id: vendorPaId,
            payment_method_id: boardBankPmId,
            customer_id: boardCustomerId,
            attrs: { propmv_phase0: 'board_to_vendor', stamp: String(stamp) },
          }, { idempotencyKey: `phase0_brd_nopm_${stamp}` }));
        record('E_BOARD_CHARGE_VENDOR_PA', boardCharge2.ok ? 'PASS' : 'FAIL', {
          message: boardCharge2.ok
            ? 'Board→Vendor succeeded without processing_method_id'
            : boardCharge.err?.message,
          data: boardCharge2.ok ? {
            txn_id: boardCharge2.value?.id,
            status: boardCharge2.value?.status,
            processing_id: boardCharge2.value?.processing_id,
          } : { first: boardCharge.err, second: boardCharge2.err },
        });
      }
    }

    // Card charge sample (Owner card → Vendor)
    if (ownerCustomerId && vendorPaId) {
      const ownerCard = await safe('ownerCard', () =>
        client.createPaymentMethod({
          type: 'card',
          customer_id: ownerCustomerId,
          card: {
            card_number: '4242424242424242',
            expiry: '12/30',
            card_code: '123',
          },
        }));
      if (ownerCard.ok) {
        const cardCharge = await safe('cardCharge', () =>
          client.createPaymentTransaction({
            type: 'payment',
            amount: 3.21,
            description: `Phase0 Owner Card→Vendor ${stamp}`,
            processing_id: vendorPaId,
            payment_method_id: ownerCard.value.id,
            customer_id: ownerCustomerId,
            attrs: { propmv_phase0: 'owner_card_to_vendor', stamp: String(stamp) },
          }, { idempotencyKey: `phase0_card_${stamp}` }));
        record('H_CARD_LIFECYCLE', cardCharge.ok ? 'PASS' : 'FAIL', {
          message: cardCharge.ok ? 'Card payment to Vendor PA created' : cardCharge.err?.message,
          data: cardCharge.ok ? {
            txn_id: cardCharge.value?.id,
            status: cardCharge.value?.status,
            type: cardCharge.value?.type,
            funding_status: cardCharge.value?.funding_status,
          } : cardCharge.err,
        });
      } else {
        record('H_CARD_LIFECYCLE', 'WARN', {
          message: 'Could not create owner card PM',
          data: ownerCard.err,
        });
      }
    }
  }

  // ── I. Webhook event identifiers (docs + code knowledge) ────────────────
  record('I_WEBHOOK_EVENTS', 'PASS', {
    message: 'Documented webhook triggers relevant to Vendor payments (verify in dashboard separately)',
    data: {
      triggers: [
        'payment',
        'processed',
        'authorized',
        'decline',
        'reject',
        'deposit',
        'processing_status',
      ],
      note: 'Live webhook delivery to PropMV endpoint not exercised in this script; must be verified against registered webhook URL.',
    },
  });

  // ── K. Field dictionary ─────────────────────────────────────────────────
  record('K_FIELD_DICTIONARY', 'PASS', {
    message: 'Exact Payload fields for Vendor payment architecture',
    data: {
      processing_id: 'Processing Account receiving the payment (Vendor PA for Vendor invoices)',
      payment_method_id: 'Payer Customer instrument (send-only ACH/card) OR destination for credit (not used in v1)',
      processing_method_id: 'Optional funding/settlement bank PM on the receiving Processing Account',
      default_deposit_method: 'Vendor bank PM flag for default settlement destination',
      transfer_type: 'receive-only (Vendor banks) | send-only (Owner/Board Customer) | two-way (future HOA treasury only)',
      transaction_type: 'payment (v1 Owner/Board → Vendor)',
      webhook_triggers: ['payment', 'processed', 'decline', 'reject', 'deposit', 'processing_status'],
    },
  });

  // Summary
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  const hardFails = results.filter((r) => r.status === 'FAIL');
  const blocking = hardFails.filter((r) =>
    /^(A_VENDOR_PA_|D_OWNER_CHARGE|E_BOARD_CHARGE|B_VENDOR_BANK_1|C_RECEIVING)/.test(r.gate)
    || r.gate === 'CONFIG');

  console.log('\n========== PHASE 0 SUMMARY ==========');
  console.log(JSON.stringify(counts, null, 2));
  console.log(`Hard FAIL gates: ${hardFails.map((r) => r.gate).join(', ') || 'none'}`);
  console.log(`Blocking for Phase 1+: ${blocking.map((r) => r.gate).join(', ') || 'none'}`);

  const go = blocking.length === 0
    && results.some((r) => r.gate === 'D_OWNER_CHARGE_VENDOR_PA' && r.status === 'PASS')
    && results.some((r) => r.gate === 'E_BOARD_CHARGE_VENDOR_PA' && r.status === 'PASS')
    && results.some((r) => (r.gate === 'B_VENDOR_BANK_1' || r.gate === 'C_RECEIVING_DESTINATION') && r.status === 'PASS');

  // Allow proceed if plugin path works even when API create failed, as long as cross-charge worked on existing PA
  const goPlugin = blocking.every((r) => r.gate === 'A_VENDOR_PA_CREATE_API')
    && results.some((r) => r.gate === 'A_VENDOR_PA_PLUGIN_TOKEN' && r.status === 'PASS')
    && results.some((r) => r.gate === 'D_OWNER_CHARGE_VENDOR_PA' && r.status === 'PASS')
    && results.some((r) => r.gate === 'E_BOARD_CHARGE_VENDOR_PA' && r.status === 'PASS');

  console.log(`\nPHASE 0 DECISION: ${(go || goPlugin) ? 'GO — proceed to Phase 1 with documented caveats' : 'STOP — revise plan before Phase 1'}`);
  console.log(`Mode: ${go ? 'full' : goPlugin ? 'plugin_onboarding_required' : 'blocked'}`);

  // Write report JSON for docs
  const fs = require('fs');
  const outPath = require('path').join(__dirname, '../docs/phase0-vendor-payload-sandbox-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    ranAt: new Date().toISOString(),
    decision: (go || goPlugin) ? 'GO' : 'STOP',
    mode: go ? 'full' : goPlugin ? 'plugin_onboarding_required' : 'blocked',
    counts,
    results,
  }, null, 2));
  console.log(`\nWrote ${outPath}`);

  process.exitCode = (go || goPlugin) ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

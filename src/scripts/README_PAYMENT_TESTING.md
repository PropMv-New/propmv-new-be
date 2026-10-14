# Payment Transaction Status Testing

This guide explains how to test the payment transaction status feature with dummy data that accurately reflects the Straddle webhook API flow.

## Overview

The payment transaction status tracker now shows actual status stages received from Straddle webhook events instead of hardcoded stages. This ensures accurate visibility of payment progress.

## What Changed

### Before
- Transaction stages were hardcoded (Initiated → Verified → Processing → Deposited → Completed)
- All completed payments showed the same generic flow
- No support for in-process or failed payments

### After
- Transaction stages are derived from actual Straddle webhook `status_history`
- Each payment shows its real progression through the payment gateway
- Supports all payment states: completed, pending, failed, cancelled, reversed
- Displays actual timestamps and status details from webhook events

## Running the Seeder

### Step 1: Navigate to the scripts directory
```bash
cd d:\propmv\propmv\src\scripts
```

### Step 2: Run the seeder
```bash
node seedPaymentTransactions.js
```

### What the Seeder Creates

The seeder generates **6 payment transactions** with complete webhook event history:

#### 1. Completed Payments (3 transactions)
- Full status progression: `created → scheduled → pending → paid`
- Each status has timestamp and details
- Shows successful payment flow

#### 2. In-Process Payments (2 transactions)
- Stuck at `pending` status
- Status progression: `created → scheduled → pending`
- Simulates payments awaiting bank confirmation

#### 3. Failed Payment (1 transaction)
- Failed after pending: `created → scheduled → pending → failed`
- Includes failure reason (e.g., "Insufficient funds")
- Shows what happens when payment fails

## Data Structure

### Collections Populated

1. **PaymentStatus** - Full webhook payloads with status history
2. **StraddleTransaction** - Transaction records linked to invoices
3. **StraddleWebhookEventResponse** - Raw webhook events for audit

### Sample Status History Structure
```json
{
  "status_history": [
    {
      "status": "created",
      "status_details": { "reason": "Payment initiated by customer" },
      "timestamp": "2025-01-20T10:00:00.000Z"
    },
    {
      "status": "scheduled",
      "status_details": { "reason": "Payment scheduled for processing" },
      "timestamp": "2025-01-20T10:00:05.000Z"
    },
    {
      "status": "pending",
      "status_details": { "reason": "Payment submitted to bank" },
      "timestamp": "2025-01-20T10:00:10.000Z"
    },
    {
      "status": "paid",
      "status_details": { "reason": "Payment successfully completed" },
      "timestamp": "2025-01-20T10:05:00.000Z"
    }
  ]
}
```

## Testing the UI

### Step 1: Find an Invoice with Test Data
After running the seeder, you'll have test payments linked to existing invoices. The seeder uses:
- The first 3 invoices for completed payments
- The next 2 invoices for in-process payments
- The first invoice again for the failed payment

### Step 2: View Invoice Details
Navigate to the invoice detail page to see the **Payment Transactions** panel with the new status tracker.

### Step 3: What You Should See

#### For Completed Payments
- All stages marked as ✓ (green checkmark)
- Full timeline from creation to completion
- Actual timestamps from webhook events
- Can collapse/expand to see full details

#### For In-Process Payments
- Earlier stages completed (green)
- Current stage active (blue, pulsing animation)
- Future stages pending (gray)
- Auto-expanded to show progress

#### For Failed Payments
- Stages up to failure point shown
- Failed stage marked with red X
- Failure reason displayed
- Shows incomplete transaction

## API Endpoint

### Get Invoice with Payment Transaction Details
```
GET /api/v1/income/:invoiceId/payment-transactions
```

This endpoint returns the invoice with payment transactions enriched with Straddle webhook data:

```json
{
  "invoiceId": "...",
  "paymentTransactions": [
    {
      "_id": "...",
      "amount": 150.00,
      "method": "ach",
      "paidAt": "2025-01-20T10:00:00.000Z",
      "straddleData": {
        "status": "paid",
        "status_history": [
          {
            "status": "created",
            "status_details": { "reason": "Payment initiated" },
            "timestamp": "2025-01-20T10:00:00.000Z"
          },
          // ... more stages
        ],
        "payment_rail": "ach",
        "customer_details": { ... }
      }
    }
  ]
}
```

## Status Mapping

The system maps Straddle statuses to display stages:

| Straddle Status | Display Label | Icon | Description |
|----------------|---------------|------|-------------|
| `created` | Created | CreditCard | Payment initiated |
| `scheduled` | Scheduled | Clock | Scheduled for processing |
| `pending` | Processing | Loader (spinning) | Processing payment |
| `paid` | Completed | CheckCircle | Payment successful |
| `failed` | Failed | XCircle | Payment failed |
| `cancelled` | Cancelled | XCircle | Payment cancelled |
| `on_hold` | On Hold | AlertCircle | Payment on hold |
| `reversed` | Reversed | XCircle | Payment reversed |

## Multiple Payments per Invoice

The seeder can add multiple payments to the same invoice. To test:

1. Run the seeder multiple times (it clears previous test data)
2. Manually trigger webhook events for the same invoice
3. The UI will show multiple transaction cards, each with its own status progression

## Troubleshooting

### No Status History Shown
- Check if `straddleData.status_history` exists in the payment transaction
- Verify the seeder ran successfully
- Check MongoDB collections: `paymentstatuses`, `straddletransactions`

### Stages Don't Update
- Ensure the frontend fetches from `/payment-transactions` endpoint
- Check browser console for API errors
- Verify the TransactionStatusTracker component is using the updated code

### Seeder Fails
- Check MongoDB connection string in `.env`
- Ensure you have invoices in the database
- Check console output for specific error messages

## Clean Up Test Data

To remove all test payment data:

```javascript
// In MongoDB shell or via script
db.paymentstatuses.deleteMany({ account_id: 'acc_sandbox_123' });
db.straddletransactions.deleteMany({ accountId: 'acc_sandbox_123' });
db.straddlewebhookeventresponses.deleteMany({ account_id: 'acc_sandbox_123' });
```

Or simply run the seeder again - it automatically clears previous test data.

## Production Considerations

### Real Webhook Integration
In production, the status history will come from actual Straddle webhook events:

1. Customer initiates payment
2. Straddle sends `payout.created.v1` webhook
3. Straddle sends `payout.event.v1` webhooks for each status change
4. Your webhook handler stores these in `PaymentStatus` collection
5. UI fetches and displays actual payment progression

### Status Updates
The status tracker automatically reflects real-time payment status as webhook events arrive.

### Historical Data
All webhook events are preserved in `StraddleWebhookEventResponse` for audit and debugging.

## Example Use Cases

### Use Case 1: Owner Checking Payment Status
An HOA owner wants to know if their payment went through:
- Navigate to invoice
- See payment transaction card
- Expand to view full status progression
- See exactly where payment is in the process

### Use Case 2: Board Member Investigating Delayed Payment
A board member notices a payment hasn't completed:
- View invoice with in-process payment
- See payment stuck at "pending" stage
- Check timestamp to determine how long it's been pending
- Contact payment processor if needed

### Use Case 3: Handling Failed Payment
A payment fails due to insufficient funds:
- System shows failed transaction with reason
- Board member can contact owner
- Owner can retry payment
- New transaction appears with fresh status progression

## Next Steps

1. Run the seeder to populate test data
2. Test the UI with different payment scenarios
3. Verify API responses include `straddleData`
4. Test with multiple payments per invoice
5. Integrate with real Straddle webhooks in production

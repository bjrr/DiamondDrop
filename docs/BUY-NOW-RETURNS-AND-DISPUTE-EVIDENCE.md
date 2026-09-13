# Buy Now Returns, RMA & Dispute Evidence — MVP1 LOCKED DECISION

This document is an authoritative CaratForUs MVP1 policy specification. Where this document conflicts with an older Buy Now return-policy summary in `README.md`, this document controls until the README is consolidated.

## 1. Scope

This policy applies to eligible **Buy Now** merchandise only. Group Buy and Custom Jewelry orders follow their separately defined cancellation/final-sale rules.

Defects, incorrect specifications, shipping damage, warranty claims, fulfillment errors, unauthorized-payment claims, duplicate charges, non-delivery claims, and merchandise materially not as described are handled separately from discretionary buyer-remorse returns. A discretionary return policy must not be used to deny rights that apply under law, card-network rules, or the applicable payment processor agreement.

## 2. RMA Required for Every Discretionary Return

No discretionary Buy Now return may be sent back without an approved CaratForUs **Return Merchandise Authorization (RMA)**.

The RMA process must:

- identify the order and exact item/line item being returned;
- retrieve or verify the carrier-confirmed delivery date;
- calculate the customer's eligibility window from that delivery date;
- record the RMA request timestamp;
- record the requested return reason;
- record the customer's requested remedy where more than one option is available;
- generate a unique RMA number when approved;
- provide return instructions and the applicable receipt deadline;
- record return tracking where supplied/available;
- record the date the item is physically received by CaratForUs;
- record inspection results and disposition;
- retain all dates, communications, policy versions, and refund/store-credit transaction references as part of the order evidence record.

Sending merchandise without an approved RMA does not create return eligibility.

## 3. Days 0–7: Standard Refund Window

The window begins on the **carrier-confirmed delivery date**.

For an otherwise eligible Buy Now item:

- the customer must submit the RMA request **within 7 calendar days of the carrier-confirmed delivery date**;
- the return must be approved before the customer sends the merchandise back;
- the merchandise must be **received by CaratForUs no later than 14 calendar days after the original carrier-confirmed delivery date**;
- if the return passes inspection and all eligibility requirements, the approved refund is issued to the **original payment method**.

An RMA requested after Day 7 does not qualify for the standard full-refund window.

A return received after Day 14 does not qualify for the standard full-refund window, even if the RMA was requested during Days 0–7, unless CaratForUs grants a documented exception or applicable law requires otherwise.

## 4. Days 8–30: Late Discretionary Return Options

For an otherwise eligible Buy Now item where the RMA request is submitted **after Day 7 but no later than Day 30 after the carrier-confirmed delivery date**, the customer may choose one of the following remedies:

1. **Refund to the original payment method, subject to a 50% restocking fee**, meaning the customer receives 50% of the eligible merchandise amount back to the original payment method; or
2. **100% merchandise credit** for the eligible merchandise amount.

The RMA must be requested **no later than Day 30**.

Once the RMA is approved, the returned merchandise must be **received by CaratForUs within 10 calendar days after the RMA approval date**.

If the return is not received within that 10-calendar-day period, the RMA expires and the discretionary return is no longer eligible unless CaratForUs grants a documented exception or applicable law requires otherwise.

For MVP1, merchandise credit should be represented by a traceable Shopify/store-credit mechanism supported by the approved architecture. The system must retain the amount, issue date, order/RMA reference, and redemption/transaction reference where available.

## 5. After Day 30

After 30 calendar days from carrier-confirmed delivery, there is **no discretionary Buy Now return**.

Covered warranty, defect, damage, fulfillment-error, or other non-discretionary claims remain subject to their applicable rules.

## 6. Item Eligibility / Condition

To qualify for a discretionary Buy Now return, merchandise must be:

- unworn beyond reasonable try-on/inspection;
- undamaged;
- unaltered after delivery;
- returned with original packaging, certificates, reports, accessories, and documentation where applicable;
- the same item and configuration originally shipped by CaratForUs.

CaratForUs should document the condition at receipt before issuing the final refund or merchandise credit.

Where appropriate, inspection evidence should include photographs/video, package condition, item condition, serial/certificate identifiers, stone/product identifiers, weight or measurements, and staff/reviewer identity.

## 7. Personalized / Altered Buy Now Merchandise

Engraved, resized, altered, personalized, or otherwise customized Buy Now merchandise is **not eligible for a discretionary return** unless a product-specific policy expressly says otherwise.

Because this is a material exception to the normal Buy Now return policy, the customer must be clearly informed before purchase. The transaction record must preserve the applicable disclosure/policy version and any required acknowledgment.

Defects, wrong specifications, shipping damage, warranty claims, and failure to deliver the ordered/presented product remain separate from discretionary-return eligibility.

## 8. RMA Form — Required MVP Fields

The customer-facing RMA form should capture or derive at least:

- Order number
- Purchaser email
- Customer/account ID when available
- Item/line item being returned
- Product/variant/configuration snapshot
- Carrier-confirmed delivery date
- RMA request date/time
- Number of calendar days since delivery
- Return reason category
- Customer explanation/details
- Requested remedy
- Required condition confirmations
- Confirmation that merchandise has not been altered after delivery
- Applicable return-policy acknowledgment
- RMA number/status
- RMA approval/denial timestamp and reason
- Return-by/receive-by deadline
- Customer-provided return tracking where applicable
- Actual CaratForUs received date/time
- Inspection outcome
- Photos/evidence references when collected
- Refund amount, restocking amount, or merchandise-credit amount
- Processor/store-credit transaction reference
- Staff/manual override and reason, if any
- Complete audit history

The customer's reason should distinguish at minimum:

- changed mind / buyer remorse;
- size/fit preference;
- style preference;
- alleged defect;
- wrong item/specification;
- damaged in transit;
- materially not as described;
- other.

Claims that indicate a defect, shipping damage, wrong item/specification, or materially-not-as-described issue should route into the applicable support/claim workflow rather than being automatically treated as a buyer-remorse return subject to a restocking fee.

## 9. Customer-Facing Disclosure

The return policy must be conspicuously available before purchase and not hidden solely inside long Terms & Conditions.

A compact Buy Now disclosure near the purchasing flow should communicate the substance of the policy, including:

- RMA required;
- RMA requested within 7 days for the normal refund window;
- item received by CaratForUs within 14 days of original delivery for the normal refund window;
- Days 8–30: choice of 50% restocking-fee refund or 100% merchandise credit;
- late-window RMA must be requested by Day 30 and received within 10 calendar days after RMA approval;
- after Day 30: no discretionary return;
- personalized/altered merchandise restrictions;
- defect/warranty/fulfillment issues handled separately.

Order confirmation should repeat the applicable return terms and the carrier-confirmed delivery date should later become the authoritative anchor for calculating deadlines.

## 10. Chargeback / Dispute Evidence Requirements

The objective is not to prevent customers from exercising legitimate card-dispute rights. The objective is to ensure CaratForUs does not lose an otherwise defensible dispute because required disclosures, fulfillment evidence, customer approvals, return records, or refund records were not preserved.

For every applicable transaction, preserve a versioned and timestamped evidence trail containing, as available/applicable:

### Purchase evidence
- Order ID and payment reference
- Customer/account reference
- Billing and shipping information supplied through the approved commerce/payment flow
- Exact product title and line-item configuration
- Product description/specification snapshot
- Product/media references shown at purchase
- Price, discounts, taxes, and shipping charged
- Policy version in effect at purchase
- Material acknowledgments and exact text/version where required
- Checkout/session reference and technical metadata available through Shopify/payment systems

### Fulfillment evidence
- QC record and photos when practical
- Carrier and service
- Tracking number
- Ship date
- Delivery address used
- Full insured value and insurance reference where available
- Signature-required flag
- Carrier-confirmed delivery status/date/time
- Signature/proof of delivery when applicable
- Address-change audit records

### Return / refund evidence
- RMA request and timestamp
- Carrier-confirmed delivery date used to calculate eligibility
- Policy window calculated by the system
- Customer's stated reason
- Customer's selected remedy
- RMA approval/denial and reason
- Return shipping/tracking records
- Date CaratForUs received the item
- Inspection record and photos where practical
- Any restocking fee calculation
- Merchandise-credit issue record, if selected
- Refund processor reference and timestamp, if selected
- Customer communications
- Manual exceptions/overrides and documented reason

### Dispute packet
The admin system must make it possible to assemble the above records into a coherent dispute-evidence packet. MVP1 may assemble the packet manually, but the underlying evidence must be retained in a retrievable form.

## 11. Operational Rules for Dispute Defensibility

- Do not promise that CaratForUs policies eliminate or override chargeback rights.
- Do not use language such as “no chargebacks” or claim that a final-sale policy defeats card-network protections.
- Make material restrictions conspicuous before payment.
- Preserve the exact policy/version that applied when the customer purchased.
- Preserve immutable product/configuration snapshots so later website edits cannot change the evidence.
- Keep refund/credit records linked to the original order and RMA.
- Use recognizable billing-statement descriptors where supported.
- Use Shopify/payment-platform fraud screening/risk tools available at launch.
- Review suspicious/high-risk orders before fulfillment where operationally practical.
- Verify webhook/event authenticity and make payment/refund event processing idempotent.
- Never collect or store sensitive payment-card data beyond what the approved processor/platform exposes and permits.
- Treat disputes involving unauthorized transactions, non-delivery, duplicate processing, wrong merchandise, defects, or materially-not-as-described claims according to their actual dispute category rather than relying solely on the return policy.

## 12. MVP Acceptance Criteria

The Buy Now returns/RMA implementation is not complete unless it can demonstrably handle and retain evidence for at least these cases:

1. RMA on Day 7, merchandise received on Day 14 — eligible for standard refund if condition requirements pass.
2. RMA on Day 8 — customer must choose 50% restocking-fee refund or 100% merchandise credit.
3. RMA on Day 30 — late-window option remains available; return must arrive within 10 calendar days after approval.
4. RMA on Day 31 — no discretionary return.
5. RMA requested Day 6 but merchandise received Day 15 — outside standard refund receipt deadline unless documented exception applies.
6. Late-window RMA approved but merchandise arrives after the 10-day approval-to-receipt deadline — RMA expired unless documented exception applies.
7. Personalized/altered Buy Now item — discretionary return denied according to preserved purchase disclosure/acknowledgment.
8. Customer alleges defect/wrong item/not-as-described — route to the appropriate claim workflow instead of automatically applying the restocking fee.
9. Refund/credit action is retried or receives a duplicate event — no duplicate refund/credit is issued.
10. A dispute-evidence packet can be assembled showing the purchase terms, fulfillment, delivery, RMA timeline, inspection, customer selection, and refund/credit result.

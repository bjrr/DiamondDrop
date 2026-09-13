# Buy Now Returns, RMA & Dispute Evidence — MVP1 LOCKED DECISION

This document is the authoritative CaratForUs MVP1 specification for discretionary Buy Now returns, RMAs, and related dispute evidence. Any older conflicting README summary is superseded by this document.

## 1. Scope
This policy applies to eligible **Buy Now** merchandise only. Group Buy, Custom Jewelry, and Luxury Steals follow their separately defined rules.

Defects, incorrect specifications, shipping damage, warranty claims, fulfillment errors, unauthorized-payment claims, duplicate charges, non-delivery claims, and merchandise materially not as described are handled separately from discretionary buyer-remorse returns. This policy does not eliminate rights required by applicable law, card-network rules, or payment-processor rules.

## 2. RMA Required
No discretionary Buy Now return may be sent without an approved CaratForUs **Return Merchandise Authorization (RMA)**. Sending merchandise without an approved RMA does not create return eligibility.

The RMA process must identify the order and exact line item, verify carrier-confirmed delivery date, calculate eligibility, record request timestamp/reason/remedy, generate an RMA number when approved, provide return instructions/deadline, record tracking, receipt, inspection and disposition, and retain policy/refund/credit evidence and audit history.

## 3. Days 0–7: Standard Refund Window
The window begins on the **carrier-confirmed delivery date**.

For an otherwise eligible Buy Now item:
- RMA request must be submitted within **7 calendar days** of carrier-confirmed delivery;
- return must be approved before shipment back;
- merchandise must be **received by CaratForUs no later than 14 calendar days after original carrier-confirmed delivery**;
- if inspection and eligibility pass, the eligible merchandise refund is issued to the **original payment method**.

An RMA requested after Day 7 does not qualify for the standard full-refund window. Receipt after Day 14 does not qualify for the standard full-refund window unless a documented exception or applicable law requires otherwise.

## 4. Days 8–30: Late Discretionary Return Options
For an otherwise eligible Buy Now item where the RMA request is submitted after Day 7 but no later than Day 30, the customer may choose:
1. **Refund to original payment method subject to a 50% restocking fee** — customer receives 50% of the eligible merchandise amount; or
2. **100% merchandise credit** for the eligible merchandise amount.

The RMA must be requested no later than Day 30. Once approved, merchandise must be **received by CaratForUs within 10 calendar days after RMA approval**. If not received within that period, the RMA expires unless a documented exception or applicable law requires otherwise.

Merchandise credit must use a traceable approved Shopify/store-credit mechanism and retain amount, issue date, order/RMA reference, status, and redemption/transaction references where available.

## 5. After Day 30
After 30 calendar days from carrier-confirmed delivery, there is **no discretionary Buy Now return**. Warranty, defect, damage, fulfillment-error and other non-discretionary claims remain separate.

## 6. Customer-Paid Return Shipping — LOCKED
For discretionary Buy Now returns:
- **the customer pays the cost of return shipping to CaratForUs**;
- the return shipment must include **tracking**;
- the return shipment must be **insured for the appropriate value of the merchandise being returned**;
- the customer must follow the approved RMA shipping instructions;
- the customer bears the risk of loss or damage in return transit until the merchandise is received by CaratForUs, subject to applicable law and carrier/insurance rights.

A discretionary-return RMA does not obligate CaratForUs to provide a prepaid return label.

If a return instead concerns a defect, wrong item/specification, shipping damage, materially-not-as-described merchandise, warranty, or another non-discretionary claim, use the applicable claim/warranty policy rather than automatically applying the discretionary-return shipping rule.

### Original/outbound shipping
Separately purchased expedited or optional outbound shipping charges are **not refundable for a discretionary return**. If the return results from a CaratForUs fulfillment error or another covered non-discretionary claim, shipping treatment is determined under that claim rather than this buyer-remorse rule.

## 7. Item Eligibility / Condition
To qualify for a discretionary Buy Now return, merchandise must be:
- unworn beyond reasonable try-on/inspection;
- undamaged;
- unaltered after delivery;
- returned with original packaging, certificates, reports, accessories, and documentation where applicable;
- the same item/configuration originally shipped.

CaratForUs must document condition at receipt before issuing a refund or merchandise credit. Inspection evidence may include photos/video, package/item condition, serial/certificate/product identifiers, weight/measurements, and reviewer identity.

## 8. Personalized / Altered Buy Now Merchandise
Engraved, resized, altered, personalized, or otherwise customized Buy Now merchandise is **not eligible for a discretionary return** unless a product-specific locked policy expressly says otherwise. This restriction must be clearly disclosed before purchase and the applicable disclosure/policy version and acknowledgment retained.

Defects, wrong specifications, shipping damage, warranty claims, and failure to deliver the ordered/presented product remain separate.

## 9. RMA Form — Required MVP Fields
Capture or derive at least:
- Order number
- Purchaser email
- Customer/account ID when available
- Item/line item
- Product/variant/configuration snapshot
- Carrier-confirmed delivery date
- RMA request date/time
- Calendar days since delivery
- Return reason category and explanation
- Requested remedy
- Condition confirmations
- Confirmation merchandise was not altered after delivery
- Applicable return-policy acknowledgment
- RMA number/status
- Approval/denial timestamp and reason
- Return-by/receive-by deadline
- Customer return tracking
- Confirmation of required return-shipment insurance / insurance reference where available
- Actual CaratForUs received date/time
- Inspection outcome and evidence references
- Refund/restocking/merchandise-credit amount
- Processor/store-credit transaction reference
- Manual override and reason
- Complete audit history

Reason categories must distinguish buyer remorse, size/fit, style preference, alleged defect, wrong item/specification, transit damage, materially not as described, and other. Defect/damage/wrong/not-as-described claims route to the applicable claim workflow rather than automatically receiving a restocking fee.

## 10. Customer-Facing Disclosure
The policy must be conspicuously available before purchase, not hidden solely in Terms & Conditions. Compact Buy Now disclosure should communicate:
- RMA required;
- RMA requested within 7 days for normal refund;
- item received within 14 days of original delivery for normal refund;
- Days 8–30: 50% restocking-fee refund or 100% merchandise credit;
- late RMA requested by Day 30 and received within 10 calendar days after approval;
- customer pays return shipping and must use tracked, appropriately insured return shipping;
- separately purchased expedited/optional outbound shipping is not refunded for discretionary returns;
- after Day 30 no discretionary return;
- personalized/altered restrictions;
- defect/warranty/fulfillment claims handled separately.

Order confirmation should repeat applicable terms. Carrier-confirmed delivery is the authoritative deadline anchor.

## 11. Chargeback / Dispute Evidence
Preserve a versioned/timestamped evidence trail sufficient to assemble a coherent dispute packet, including as applicable:

### Purchase evidence
Order/payment/customer references; billing/shipping information supplied through approved systems; exact product/configuration/specification/media snapshot; price/discount/tax/shipping; policy version; acknowledgments; checkout/session and permitted platform metadata.

### Fulfillment evidence
QC records/photos where practical; carrier/service/tracking/ship date; delivery address; insured value/insurance reference; signature-required flag; carrier-confirmed delivery; proof/signature where applicable; address-change audit history.

### Return/refund evidence
RMA request/timestamp; delivery date and calculated window; customer reason/remedy; approval/denial; return tracking and insurance evidence where available; receipt date; inspection/evidence; restocking calculation; credit/refund references/timestamps; communications; exceptions/overrides and reasons.

MVP1 may assemble dispute packets manually, but underlying records must be retrievable.

## 12. Operational Rules for Dispute Defensibility
- Do not claim CaratForUs policies eliminate chargeback or legally required rights.
- Make material restrictions conspicuous before payment.
- Preserve exact policy/version applicable at purchase.
- Preserve immutable product/configuration snapshots.
- Link refunds/credits to original order/RMA.
- Use recognizable billing descriptors where supported.
- Use available Shopify/payment fraud/risk tools.
- Review suspicious/high-risk orders where practical.
- Verify webhook/event authenticity and make processing idempotent.
- Never collect/store raw payment-card data beyond approved platform exposure.
- Treat unauthorized transaction, non-delivery, duplicate, wrong merchandise, defect and not-as-described disputes according to their actual category.

## 13. MVP Acceptance Criteria
1. Day 7 RMA + Day 14 receipt qualifies for standard refund if condition passes.
2. Day 8 RMA offers 50% restocking-fee refund or 100% merchandise credit.
3. Day 30 RMA remains late-window eligible and must arrive within 10 days after approval.
4. Day 31 is not discretionary-return eligible.
5. Day 6 request + Day 15 receipt is outside standard refund unless documented exception.
6. Late-window return received more than 10 days after approval is expired unless documented exception.
7. Personalized/altered item follows preserved final-sale disclosure.
8. Defect/wrong/not-as-described routes to claim workflow, not automatic restocking fee.
9. Discretionary return instructions require customer-paid tracked, appropriately insured return shipment.
10. Separately purchased expedited/optional outbound shipping is not refunded on a discretionary return.
11. Duplicate/retried refund or credit cannot create duplicate value.
12. Dispute packet can show purchase terms, fulfillment/delivery, RMA timeline, return tracking/insurance evidence where available, inspection, remedy selection, and refund/credit result.

## 14. Remaining Unsettled Buy Now Detail
Do not invent the following without owner approval:
- exact tax treatment of the 50% restocking-fee refund and merchandise credit;
- merchandise-credit expiration/transferability unless separately locked;
- holiday extensions or special-event exceptions.

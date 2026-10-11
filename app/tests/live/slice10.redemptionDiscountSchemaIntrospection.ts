/**
 * SLICE 10 LIVE GATE — schema introspection for the fallback-benefit
 * redemption draft order.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS BEFORE THE ADAPTER METHOD DOES
 * ============================================================================
 * The owner's decision is that the 10%-off fallback benefit must NOT be issued
 * as a generic Shopify discount code — the amount is calculated server-side
 * from the eligible merchandise subtotal and then put on a CaratForUs-created
 * draft order as an exact fixed amount. That requires knowing, for certain:
 *
 *   1. which field carries a fixed-amount discount on `DraftOrderInput`, and
 *      what shape its value takes (a bare decimal? a MoneyInput? both, with
 *      one deprecated?);
 *   2. whether the draft order can be told to REFUSE further discount codes at
 *      checkout — because "not stackable by default" is a policy promise, and
 *      a promise enforced only by our own arithmetic is not enforced at all if
 *      the customer can type a code into Shopify's checkout afterwards;
 *   3. what the resulting ORDER exposes, so order-time verification compares
 *      the discount Shopify actually applied against the one we reserved.
 *
 * `draftOrderAdapter.server.ts` already carries the scar that justifies asking
 * rather than assuming: it once sent `originalUnitPrice` on a variant line, a
 * field that does not exist on `DraftOrderLineItemInput` in 2026-07. Shopify
 * neither errored nor coerced — it ignored the field and charged the catalogue
 * price. No unit test could catch that, because a mocked client echoes back
 * whatever it is handed. A discount field guessed the same way would silently
 * discount nothing, or discount everything.
 *
 * SO THIS SCRIPT ASSERTS WHAT IT EXPECTS AND PRINTS WHAT IT FINDS. Where a
 * hypothesis is inference rather than knowledge it is labelled as such below,
 * and the check merely reports the real type instead of asserting a guess.
 *
 * RUN:  npx tsx tests/live/slice10.redemptionDiscountSchemaIntrospection.ts
 *
 * SIDE EFFECTS: NONE. Every query is `__type` introspection; this file
 * contains no mutation call at all, so running it cannot create a draft order,
 * a discount, or an order.
 */
import "dotenv/config";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

let failures = 0;
function check(condition: unknown, message: string): void {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) failures += 1;
}
/** Reports without asserting — for questions this script is discovering rather than confirming. */
function report(message: string): void {
  console.log(`  ----  ${message}`);
}

type AdminGraphql = (query: string, options?: { variables?: object }) => Promise<Response>;

interface TypeRef {
  name: string | null;
  kind: string;
  ofType: TypeRef | null;
}
interface IntrospectedInputField {
  name: string;
  type: TypeRef;
}
interface IntrospectedField {
  name: string;
  type: TypeRef;
}

const TYPE_REF_FRAGMENT = `
  name
  kind
  ofType {
    name
    kind
    ofType {
      name
      kind
      ofType { name kind }
    }
  }
`;

async function gql<T>(admin: { graphql: AdminGraphql }, document: string, variables?: object): Promise<T> {
  const resp = await admin.graphql(document, variables ? { variables } : undefined);
  const body = (await resp.json()) as { errors?: unknown; data?: T };
  if (body.errors) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

function namedTypeOf(type: TypeRef): string | null {
  let current: TypeRef | null = type;
  while (current && current.name === null && current.ofType) current = current.ofType;
  return current?.name ?? null;
}

function renderTypeRef(type: TypeRef): string {
  if (type.kind === "NON_NULL" && type.ofType) return `${renderTypeRef(type.ofType)}!`;
  if (type.kind === "LIST" && type.ofType) return `[${renderTypeRef(type.ofType)}]`;
  return type.name ?? "?";
}

async function introspectInputFields(
  admin: { graphql: AdminGraphql },
  typeName: string
): Promise<Map<string, IntrospectedInputField>> {
  const data = await gql<{ __type: { name: string; inputFields: IntrospectedInputField[] } | null }>(
    admin,
    `#graphql
      query CaratLiveGateIntrospectInputType($name: String!) {
        __type(name: $name) {
          name
          inputFields { name type { ${TYPE_REF_FRAGMENT} } }
        }
      }`,
    { name: typeName }
  );
  if (!data.__type) {
    throw new Error(
      `__type(name: "${typeName}") returned null — it does not exist as an INPUT type on this schema/API version`
    );
  }
  return new Map(data.__type.inputFields.map((f) => [f.name, f]));
}

async function introspectOutputFields(
  admin: { graphql: AdminGraphql },
  typeName: string
): Promise<Map<string, IntrospectedField>> {
  const data = await gql<{ __type: { name: string; fields: IntrospectedField[] } | null }>(
    admin,
    `#graphql
      query CaratLiveGateIntrospectOutputType($name: String!) {
        __type(name: $name) {
          name
          fields { name type { ${TYPE_REF_FRAGMENT} } }
        }
      }`,
    { name: typeName }
  );
  if (!data.__type) {
    throw new Error(
      `__type(name: "${typeName}") returned null — it does not exist as an OUTPUT type on this schema/API version`
    );
  }
  return new Map(data.__type.fields.map((f) => [f.name, f]));
}

async function introspectEnumValues(admin: { graphql: AdminGraphql }, typeName: string): Promise<Set<string>> {
  const data = await gql<{ __type: { name: string; enumValues: { name: string }[] } | null }>(
    admin,
    `#graphql
      query CaratLiveGateIntrospectEnumType($name: String!) {
        __type(name: $name) { name enumValues { name } }
      }`,
    { name: typeName }
  );
  if (!data.__type) throw new Error(`__type(name: "${typeName}") returned null — enum does not exist`);
  return new Set(data.__type.enumValues.map((v) => v.name));
}

function checkInputField(
  fields: Map<string, IntrospectedInputField>,
  typeLabel: string,
  fieldName: string,
  expectedNamedType?: string
): IntrospectedInputField | undefined {
  const field = fields.get(fieldName);
  check(field !== undefined, `${typeLabel}.${fieldName} exists`);
  if (field) {
    console.log(`         ${typeLabel}.${fieldName}: ${renderTypeRef(field.type)}`);
    if (expectedNamedType) {
      check(
        namedTypeOf(field.type) === expectedNamedType,
        `${typeLabel}.${fieldName}'s named type is ${expectedNamedType} (got ${namedTypeOf(field.type)})`
      );
    }
  }
  return field;
}

function isRequired(field: IntrospectedInputField | undefined): boolean {
  return field !== undefined && field.type.kind === "NON_NULL";
}

async function main() {
  console.log(
    `Slice 10 live gate — fallback-benefit redemption: the fixed-amount discount shape, against ${SHOP}\n`
  );

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  // --------------------------------------------------------------------------
  console.log("1. DraftOrderInput — how a discount attaches to the order at all");
  // --------------------------------------------------------------------------
  const draftOrderInput = await introspectInputFields(admin, "DraftOrderInput");
  const appliedDiscount = checkInputField(draftOrderInput, "DraftOrderInput", "appliedDiscount");
  const appliedDiscountTypeName = appliedDiscount ? namedTypeOf(appliedDiscount.type) : null;
  report(`the discount input type is named: ${appliedDiscountTypeName ?? "(absent)"}`);

  // THE STACKING QUESTION. Amendment §3 makes the benefit non-stackable unless
  // CaratForUs expressly authorizes a combination. Our calculation refuses to
  // compute on top of another promotion — but that only governs what WE put on
  // the order. If Shopify's checkout will still accept a typed discount code
  // on top of this draft order, the policy is enforced on one side only.
  //
  // INFERENCE, NOT KNOWLEDGE: `allowDiscountCodesInCheckout` is the field name
  // this is expected to be. If it is absent under a different name, this check
  // FAILS LOUDLY rather than quietly assuming the protection exists — and the
  // full field list printed below is how the right name gets found.
  const allowCodes = draftOrderInput.get("allowDiscountCodesInCheckout");
  check(
    allowCodes !== undefined,
    "DraftOrderInput.allowDiscountCodesInCheckout exists — the draft order can refuse further codes at checkout"
  );
  if (allowCodes) {
    report(`DraftOrderInput.allowDiscountCodesInCheckout: ${renderTypeRef(allowCodes.type)}`);
  } else {
    report("NOT FOUND. The complete DraftOrderInput field list follows; find the real name before relying on it:");
    report([...draftOrderInput.keys()].sort().join(", "));
  }

  // --------------------------------------------------------------------------
  console.log("\n2. The discount input type — which field carries an exact dollar amount");
  // --------------------------------------------------------------------------
  if (appliedDiscountTypeName) {
    const discountInput = await introspectInputFields(admin, appliedDiscountTypeName);
    report(`${appliedDiscountTypeName} fields: ${[...discountInput.keys()].sort().join(", ")}`);

    // `valueType` picks FIXED_AMOUNT vs PERCENTAGE. The benefit is calculated
    // as a percentage BUT applied as a fixed amount, deliberately: the $100 cap
    // and the merchandise-only exclusions mean a percentage Shopify computes
    // for itself would be a different number from the one we promised.
    const valueType = checkInputField(discountInput, appliedDiscountTypeName, "valueType");
    check(isRequired(valueType), `${appliedDiscountTypeName}.valueType is required`);

    const value = checkInputField(discountInput, appliedDiscountTypeName, "value");
    report(`${appliedDiscountTypeName}.value required: ${isRequired(value)}`);

    // Hypothesised sibling: a currency-carrying money input, as
    // `originalUnitPriceWithCurrency` is to `originalUnitPrice` on line items.
    // Discovered, not asserted — if it exists it is the one to send, for the
    // same reason the line-item adapter sends currency WITH the amount.
    const amountWithCurrency = discountInput.get("amountWithCurrency");
    if (amountWithCurrency) {
      report(
        `${appliedDiscountTypeName}.amountWithCurrency EXISTS: ${renderTypeRef(amountWithCurrency.type)} — prefer it over a bare decimal`
      );
    } else {
      report(`${appliedDiscountTypeName}.amountWithCurrency is absent; "value" is the only amount field`);
    }

    checkInputField(discountInput, appliedDiscountTypeName, "title");
    checkInputField(discountInput, appliedDiscountTypeName, "description");

    if (valueType) {
      const valueTypeEnum = namedTypeOf(valueType.type);
      if (valueTypeEnum) {
        const values = await introspectEnumValues(admin, valueTypeEnum);
        report(`${valueTypeEnum} values: ${[...values].sort().join(", ")}`);
        check(values.has("FIXED_AMOUNT"), `${valueTypeEnum} has FIXED_AMOUNT — an exact dollar discount is expressible`);
      }
    }
  }

  // --------------------------------------------------------------------------
  console.log("\n3. DraftOrder output — what the echo check can verify after creation");
  // --------------------------------------------------------------------------
  // Step 5 of the adapter's five-step check needs to read the discount back.
  // Without a readable field, creating the draft order and believing the
  // discount landed is exactly the `originalUnitPrice` failure again.
  const draftOrder = await introspectOutputFields(admin, "DraftOrder");
  const outAppliedDiscount = draftOrder.get("appliedDiscount");
  check(outAppliedDiscount !== undefined, "DraftOrder.appliedDiscount is readable for an echo check");
  if (outAppliedDiscount) report(`DraftOrder.appliedDiscount: ${renderTypeRef(outAppliedDiscount.type)}`);
  for (const name of ["totalDiscountsSet", "subtotalPriceSet", "totalPriceSet"]) {
    const f = draftOrder.get(name);
    if (f) report(`DraftOrder.${name}: ${renderTypeRef(f.type)}`);
    else report(`DraftOrder.${name} is ABSENT on this version`);
  }

  // SETTING allowDiscountCodesInCheckout:false IS NOT THE SAME AS KNOWING IT
  // TOOK. A write-only flag is a promise we cannot check, and this is the
  // promise that keeps the benefit non-stackable at Shopify's own checkout.
  const outAllowCodes = draftOrder.get("allowDiscountCodesInCheckout");
  check(
    outAllowCodes !== undefined,
    "DraftOrder.allowDiscountCodesInCheckout is READABLE — the no-further-codes promise can be echo-verified, not merely sent"
  );
  if (outAllowCodes) report(`DraftOrder.allowDiscountCodesInCheckout: ${renderTypeRef(outAllowCodes.type)}`);

  // The amount of the discount, as Shopify stored it. `value` on the INPUT is
  // a `Float!` — money as a float, which this codebase bans in arithmetic
  // (CLAUDE.md rule 6) and which is therefore the one number here that must be
  // read back rather than trusted. A 2-decimal amount round-trips a double
  // exactly, so the hazard is not representation; it is that `value` and
  // `amountWithCurrency` are two separate fields that could disagree, and only
  // the stored result settles which one Shopify honoured.
  if (outAppliedDiscount) {
    const discountOutTypeName = namedTypeOf(outAppliedDiscount.type);
    if (discountOutTypeName) {
      const discountOut = await introspectOutputFields(admin, discountOutTypeName);
      report(`${discountOutTypeName} fields: ${[...discountOut.keys()].sort().join(", ")}`);
      const amountSet = discountOut.get("amountSet");
      check(
        amountSet !== undefined,
        `${discountOutTypeName}.amountSet exists — the stored discount amount is readable as a MoneyBag, not a float`
      );
      if (amountSet) report(`${discountOutTypeName}.amountSet: ${renderTypeRef(amountSet.type)}`);
      for (const name of ["value", "valueType", "amount"]) {
        const f = discountOut.get(name);
        if (f) report(`${discountOutTypeName}.${name}: ${renderTypeRef(f.type)}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  console.log("\n4. Order output — what order-time verification can compare against");
  // --------------------------------------------------------------------------
  // The owner requires verification at order time that the discount actually
  // applied equals the one reserved, and that no unauthorized stacking
  // happened. Both questions have to be answerable from the real order.
  const order = await introspectOutputFields(admin, "Order");
  const totalDiscounts = order.get("totalDiscountsSet");
  check(totalDiscounts !== undefined, "Order.totalDiscountsSet exists — the applied discount is readable");
  if (totalDiscounts) report(`Order.totalDiscountsSet: ${renderTypeRef(totalDiscounts.type)}`);

  const discountApplications = order.get("discountApplications");
  check(
    discountApplications !== undefined,
    "Order.discountApplications exists — individual discounts are enumerable, so stacking is detectable"
  );
  if (discountApplications) report(`Order.discountApplications: ${renderTypeRef(discountApplications.type)}`);

  const discountCodes = order.get("discountCodes");
  if (discountCodes) report(`Order.discountCodes: ${renderTypeRef(discountCodes.type)}`);
  else report("Order.discountCodes is ABSENT; enumerate discountApplications instead");

  // --------------------------------------------------------------------------
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  // --------------------------------------------------------------------------
  if (failures > 0) {
    console.log(
      "Do NOT write the redemption draft-order mutation against a failed check. A discount field that does\n" +
        "not exist is silently ignored by Shopify — the same failure mode that once charged catalogue price\n" +
        "on every Bank Payment line."
    );
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

// `unauthenticated.admin` loads the session from the local database and
// therefore a Prisma client, so handles are still open when main() returns,
// exactly as the other live gates note. Exit explicitly.
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

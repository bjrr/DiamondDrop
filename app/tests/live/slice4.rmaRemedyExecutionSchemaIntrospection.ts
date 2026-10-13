/**
 * SLICE 4 LIVE GATE — schema introspection for `rmaRemedyExecutionAdapter.server.ts`
 * (team-lead review note, RMA remedy-execution task).
 *
 * WHY THIS ADAPTER GETS A GATE THE ORDER-LOOKUP ADAPTERS ALSO GOT, AND WHY IT
 * MATTERS MORE HERE. `slice5.orderLookupSchemaIntrospection.ts` closed the
 * same "recalled, not verified" gap for two READ-ONLY adapters — a wrong
 * field name there returns nothing. `rmaRemedyExecutionAdapter.server.ts`
 * calls `refundCreate` and `storeCreditAccountCredit`: a wrong field/type
 * there is either a runtime GraphQL error at the moment a customer is owed
 * money, or — worse — a shape that is ACCEPTED but means something different
 * than intended. Introspection cannot prove the mutation behaves correctly
 * (that would require actually calling it, which is NOT authorised here —
 * see the adapter's own module comment and the assigning message), but it
 * closes the cheaper, more common failure mode: a field, argument, input
 * type or enum value that does not exist, or exists under a different name,
 * on Admin API 2026-07.
 *
 * EVERY FIELD, ARGUMENT, INPUT TYPE AND ENUM VALUE THIS ADAPTER SENDS OR
 * READS IS CHECKED HERE, BY NAME, AGAINST THE LIVE SCHEMA. Nothing is
 * skipped because it "seems obviously right" — that instinct is exactly how
 * the order-lookup adapters ended up with an unverified `title`-vs-`name`
 * guess.
 *
 * RUN:  npx tsx tests/live/slice4.rmaRemedyExecutionSchemaIntrospection.ts
 *
 * SIDE EFFECTS: NONE. Every query below is `__type`/`__schema` introspection.
 * No `refundCreate`, `storeCreditAccountCredit`, or any other mutation is
 * ever invoked — this file contains no mutation call at all, by design, so
 * there is no way to accidentally move real money by running it.
 */
import "dotenv/config";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

let failures = 0;
function check(condition: unknown, message: string): void {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) failures += 1;
}

type AdminGraphql = (query: string, options?: { variables?: object }) => Promise<Response>;

interface TypeRef {
  name: string | null;
  kind: string;
  ofType: TypeRef | null;
}
interface IntrospectedArg {
  name: string;
  type: TypeRef;
}
interface IntrospectedField {
  name: string;
  type: TypeRef;
  args: IntrospectedArg[];
}
interface IntrospectedInputField {
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

/** Unwraps NON_NULL/LIST wrappers (up to 3 deep, which covers everything referenced below) to the innermost named type. */
function namedTypeOf(type: TypeRef): string | null {
  let current: TypeRef | null = type;
  while (current && current.name === null && current.ofType) current = current.ofType;
  return current?.name ?? null;
}

/** Renders a type ref as GraphQL SDL shorthand for readable PASS/FAIL output only — not used for comparison logic. */
function renderTypeRef(type: TypeRef): string {
  if (type.kind === "NON_NULL" && type.ofType) return `${renderTypeRef(type.ofType)}!`;
  if (type.kind === "LIST" && type.ofType) return `[${renderTypeRef(type.ofType)}]`;
  return type.name ?? "?";
}

async function introspectOutputFields(admin: { graphql: AdminGraphql }, typeName: string): Promise<Map<string, IntrospectedField>> {
  const data = await gql<{ __type: { name: string; fields: IntrospectedField[] } | null }>(
    admin,
    `#graphql
      query CaratLiveGateIntrospectOutputType($name: String!) {
        __type(name: $name) {
          name
          fields {
            name
            type { ${TYPE_REF_FRAGMENT} }
            args { name type { ${TYPE_REF_FRAGMENT} } }
          }
        }
      }`,
    { name: typeName }
  );
  if (!data.__type) throw new Error(`__type(name: "${typeName}") returned null — type does not exist as an OUTPUT type on this schema/API version`);
  return new Map(data.__type.fields.map((f) => [f.name, f]));
}

async function introspectInputFields(admin: { graphql: AdminGraphql }, typeName: string): Promise<Map<string, IntrospectedInputField>> {
  const data = await gql<{ __type: { name: string; inputFields: IntrospectedInputField[] } | null }>(
    admin,
    `#graphql
      query CaratLiveGateIntrospectInputType($name: String!) {
        __type(name: $name) {
          name
          inputFields {
            name
            type { ${TYPE_REF_FRAGMENT} }
          }
        }
      }`,
    { name: typeName }
  );
  if (!data.__type) throw new Error(`__type(name: "${typeName}") returned null — type does not exist as an INPUT type on this schema/API version`);
  return new Map(data.__type.inputFields.map((f) => [f.name, f]));
}

async function introspectEnumValues(admin: { graphql: AdminGraphql }, typeName: string): Promise<Set<string>> {
  const data = await gql<{ __type: { name: string; enumValues: { name: string }[] } | null }>(
    admin,
    `#graphql
      query CaratLiveGateIntrospectEnumType($name: String!) {
        __type(name: $name) {
          name
          enumValues { name }
        }
      }`,
    { name: typeName }
  );
  if (!data.__type) throw new Error(`__type(name: "${typeName}") returned null — enum does not exist on this schema/API version`);
  return new Set(data.__type.enumValues.map((v) => v.name));
}

/**
 * `expectedNamedType` is OPTIONAL: omit it to merely discover and print a
 * field's actual type without asserting a particular name (used where this
 * script does not know the return type in advance). Passing it asserts an
 * exact match. A first draft of this script passed a bogus sentinel instead
 * of omitting the argument and got a wall of spurious FAILs for fields that
 * were never wrong — fixed here rather than left in, since a live gate that
 * cries wolf trains the next reader to stop trusting it.
 */
function checkField(
  fields: Map<string, IntrospectedField>,
  typeLabel: string,
  fieldName: string,
  expectedNamedType?: string
): IntrospectedField | undefined {
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

function checkArg(field: IntrospectedField | undefined, typeLabel: string, argName: string, expectedNamedType?: string): IntrospectedArg | undefined {
  if (!field) return undefined;
  const arg = field.args.find((a) => a.name === argName);
  check(arg !== undefined, `${typeLabel} has a "${argName}" argument`);
  if (arg && expectedNamedType) {
    console.log(`         ${typeLabel}(${argName}): ${renderTypeRef(arg.type)}`);
    check(
      namedTypeOf(arg.type) === expectedNamedType,
      `${typeLabel}'s "${argName}" argument's named type is ${expectedNamedType} (got ${namedTypeOf(arg.type)})`
    );
  }
  return arg;
}

function checkInputField(
  fields: Map<string, IntrospectedInputField>,
  typeLabel: string,
  fieldName: string,
  expectedNamedType?: string
): IntrospectedInputField | undefined {
  const field = fields.get(fieldName);
  check(field !== undefined, `${typeLabel}.${fieldName} exists`);
  if (field && expectedNamedType) {
    console.log(`         ${typeLabel}.${fieldName}: ${renderTypeRef(field.type)}`);
    check(
      namedTypeOf(field.type) === expectedNamedType,
      `${typeLabel}.${fieldName}'s named type is ${expectedNamedType} (got ${namedTypeOf(field.type)})`
    );
  }
  return field;
}

async function main() {
  console.log(`Slice 4 live gate — RMA remedy execution adapter schema introspection against ${SHOP}\n`);

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  // ==========================================================================
  // 1. getSuggestedRefundForLine — Order.lineItems / LineItem.refundableQuantity,
  //    Order.suggestedRefund and its argument/return shape.
  // ==========================================================================
  console.log('1. Order/LineItem — refundable quantity + Order.suggestedRefund');
  const orderFields = await introspectOutputFields(admin, "Order");

  const lineItemsField = checkField(orderFields, "Order", "lineItems", "LineItemConnection");
  checkArg(lineItemsField, "Order.lineItems", "first", "Int");

  const lineItemFields = await introspectOutputFields(admin, "LineItem");
  checkField(lineItemFields, "LineItem", "refundableQuantity", "Int");

  const suggestedRefundField = checkField(orderFields, "Order", "suggestedRefund");
  // The return type name is discovered, not assumed — printed regardless of match so a rename shows up plainly.
  const suggestedRefundReturnType = suggestedRefundField ? namedTypeOf(suggestedRefundField.type) : null;
  if (suggestedRefundField) console.log(`         Order.suggestedRefund returns: ${renderTypeRef(suggestedRefundField.type)}`);

  const refundLineItemsArg = checkArg(suggestedRefundField, "Order.suggestedRefund", "refundLineItems");
  const suggestedRefundInputTypeName = refundLineItemsArg ? namedTypeOf(refundLineItemsArg.type) : null;
  check(suggestedRefundInputTypeName !== null, "Order.suggestedRefund's refundLineItems argument names a concrete input type");
  console.log(`         Order.suggestedRefund(refundLineItems:) input type is: ${suggestedRefundInputTypeName}`);

  if (suggestedRefundInputTypeName) {
    const refundLineItemInputFields = await introspectInputFields(admin, suggestedRefundInputTypeName);
    checkInputField(refundLineItemInputFields, suggestedRefundInputTypeName, "lineItemId", "ID");
    checkInputField(refundLineItemInputFields, suggestedRefundInputTypeName, "quantity", "Int");
    // FULL field listing, including nullability — the adapter (as first
    // written) sends ONLY lineItemId/quantity into RefundInput.refundLineItems
    // (this same input type, confirmed reused below in section 3). If any
    // OTHER field here is NON_NULL (required), that omission would be a hard
    // mutation error, not merely an incomplete refund.
    console.log(`         ${suggestedRefundInputTypeName} — every field (checking for an undeclared required one):`);
    for (const [name, field] of refundLineItemInputFields) {
      console.log(`           ${name}: ${renderTypeRef(field.type)}`);
    }
    for (const [name, field] of refundLineItemInputFields) {
      if (name === "lineItemId" || name === "quantity") continue;
      check(
        field.type.kind !== "NON_NULL",
        `${suggestedRefundInputTypeName}.${name} is NOT required (adapter does not set it) — got ${renderTypeRef(field.type)}`
      );
    }
  }

  if (suggestedRefundReturnType) {
    const suggestedRefundFields = await introspectOutputFields(admin, suggestedRefundReturnType);
    const subtotalSetField = checkField(suggestedRefundFields, suggestedRefundReturnType, "subtotalSet", "MoneyBag");
    const totalTaxSetField = checkField(suggestedRefundFields, suggestedRefundReturnType, "totalTaxSet", "MoneyBag");
    if (subtotalSetField || totalTaxSetField) {
      const moneyBagFields = await introspectOutputFields(admin, "MoneyBag");
      checkField(moneyBagFields, "MoneyBag", "shopMoney", "MoneyV2");
      const moneyV2Fields = await introspectOutputFields(admin, "MoneyV2");
      checkField(moneyV2Fields, "MoneyV2", "amount", "Decimal");
      checkField(moneyV2Fields, "MoneyV2", "currencyCode", "CurrencyCode");
    }
  }

  // ==========================================================================
  // 2. issueStoreCredit — Customer.storeCreditAccounts, storeCreditAccountCredit
  // ==========================================================================
  console.log("\n2. Customer.storeCreditAccounts + Mutation.storeCreditAccountCredit (D5)");
  const customerFields = await introspectOutputFields(admin, "Customer");
  const storeCreditAccountsField = checkField(customerFields, "Customer", "storeCreditAccounts");
  const storeCreditAccountsReturnType = storeCreditAccountsField ? namedTypeOf(storeCreditAccountsField.type) : null;
  if (storeCreditAccountsField) console.log(`         Customer.storeCreditAccounts returns: ${renderTypeRef(storeCreditAccountsField.type)}`);
  checkArg(storeCreditAccountsField, "Customer.storeCreditAccounts", "first", "Int");

  if (storeCreditAccountsReturnType) {
    const connectionFields = await introspectOutputFields(admin, storeCreditAccountsReturnType);
    const nodesField = checkField(connectionFields, storeCreditAccountsReturnType, "nodes");
    const accountNodeType = nodesField ? namedTypeOf(nodesField.type) : null;
    if (nodesField) console.log(`         ${storeCreditAccountsReturnType}.nodes element type: ${renderTypeRef(nodesField.type)}`);
    if (accountNodeType) {
      const accountFields = await introspectOutputFields(admin, accountNodeType);
      checkField(accountFields, accountNodeType, "id", "ID");
    }
  }

  const mutationFields = await introspectOutputFields(admin, "Mutation");
  const storeCreditAccountCreditField = checkField(mutationFields, "Mutation", "storeCreditAccountCredit");
  if (storeCreditAccountCreditField) {
    console.log(`         Mutation.storeCreditAccountCredit returns: ${renderTypeRef(storeCreditAccountCreditField.type)}`);
    checkArg(storeCreditAccountCreditField, "Mutation.storeCreditAccountCredit", "id", "ID");
    const creditInputArg = checkArg(storeCreditAccountCreditField, "Mutation.storeCreditAccountCredit", "creditInput");
    const creditInputTypeName = creditInputArg ? namedTypeOf(creditInputArg.type) : null;
    console.log(`         creditInput type is: ${creditInputTypeName}`);
    if (creditInputTypeName) {
      const creditInputFields = await introspectInputFields(admin, creditInputTypeName);
      const creditAmountField = checkInputField(creditInputFields, creditInputTypeName, "creditAmount");
      const creditAmountTypeName = creditAmountField ? namedTypeOf(creditAmountField.type) : null;
      console.log(`         creditAmount type is: ${creditAmountTypeName}`);
      if (creditAmountTypeName) {
        const moneyInputFields = await introspectInputFields(admin, creditAmountTypeName);
        checkInputField(moneyInputFields, creditAmountTypeName, "amount");
        checkInputField(moneyInputFields, creditAmountTypeName, "currencyCode", "CurrencyCode");
      }
    }

    const payloadReturnType = namedTypeOf(storeCreditAccountCreditField.type);
    if (payloadReturnType) {
      const payloadFields = await introspectOutputFields(admin, payloadReturnType);
      const txField = checkField(payloadFields, payloadReturnType, "storeCreditAccountTransaction");
      const txReturnType = txField ? namedTypeOf(txField.type) : null;
      if (txReturnType) {
        // The adapter reads `.id` off this object to use as the remedy's
        // processor reference — never introspected directly in the first
        // pass, only assumed.
        const txFields = await introspectOutputFields(admin, txReturnType);
        checkField(txFields, txReturnType, "id", "ID");
      }
      const userErrorsField = checkField(payloadFields, payloadReturnType, "userErrors");
      const userErrorType = userErrorsField ? namedTypeOf(userErrorsField.type) : null;
      if (userErrorType) {
        const userErrorFields = await introspectOutputFields(admin, userErrorType);
        checkField(userErrorFields, userErrorType, "field", "String");
        checkField(userErrorFields, userErrorType, "message", "String");
        checkField(userErrorFields, userErrorType, "code");
      }
    }
  }

  // ==========================================================================
  // 3. createRefund — Order.transactions, Mutation.refundCreate
  // ==========================================================================
  console.log("\n3. Order.transactions + Mutation.refundCreate");
  const transactionsField = checkField(orderFields, "Order", "transactions");
  if (transactionsField) console.log(`         Order.transactions returns: ${renderTypeRef(transactionsField.type)}`);
  // Reported, not asserted pass/fail on its own — whether this takes `first`
  // (a connection) or no args (a plain list) determines whether the
  // adapter's `transactions(first: 25)` call is even syntactically valid.
  const transactionsFirstArg = transactionsField?.args.find((a) => a.name === "first");
  console.log(`         Order.transactions has a "first" argument: ${transactionsFirstArg !== undefined}`);
  check(
    transactionsField !== undefined && (transactionsFirstArg !== undefined || transactionsField.type.kind === "LIST" || transactionsField.type.ofType?.kind === "LIST"),
    'Order.transactions is callable the way the adapter calls it — either it accepts "first" (connection-shaped) or it is a plain list needing no arguments'
  );

  const transactionsReturnType = transactionsField ? namedTypeOf(transactionsField.type) : null;
  // Could be a connection (OrderTransactionConnection, needing .nodes) or a plain [OrderTransaction!]! (the adapter currently assumes the latter — a flat array).
  if (transactionsReturnType && transactionsReturnType !== "OrderTransaction") {
    console.log(`         NOTE: Order.transactions' named type is "${transactionsReturnType}", not "OrderTransaction" directly — if this is a connection type, the adapter's flat-array read (order.transactions as {...}[]) is WRONG and must read .nodes instead.`);
  }
  check(
    transactionsReturnType === "OrderTransaction",
    `Order.transactions resolves (after unwrapping LIST/NON_NULL) directly to OrderTransaction, matching the adapter's flat-array read (got ${transactionsReturnType})`
  );

  const orderTransactionFields = await introspectOutputFields(admin, "OrderTransaction");
  checkField(orderTransactionFields, "OrderTransaction", "id", "ID");
  const kindField = checkField(orderTransactionFields, "OrderTransaction", "kind");
  const kindEnumName = kindField ? namedTypeOf(kindField.type) : null;
  const statusField = checkField(orderTransactionFields, "OrderTransaction", "status");
  const statusEnumName = statusField ? namedTypeOf(statusField.type) : null;
  checkField(orderTransactionFields, "OrderTransaction", "gateway", "String");
  checkField(orderTransactionFields, "OrderTransaction", "parentTransaction", "OrderTransaction");

  if (kindEnumName) {
    const kindValues = await introspectEnumValues(admin, kindEnumName);
    console.log(`         ${kindEnumName} values: ${[...kindValues].join(", ")}`);
    check(kindValues.has("SALE"), `${kindEnumName} includes SALE`);
    check(kindValues.has("CAPTURE"), `${kindEnumName} includes CAPTURE`);
    check(kindValues.has("REFUND"), `${kindEnumName} includes REFUND (used as the adapter's OrderTransactionInput.kind)`);
  }
  if (statusEnumName) {
    const statusValues = await introspectEnumValues(admin, statusEnumName);
    console.log(`         ${statusEnumName} values: ${[...statusValues].join(", ")}`);
    check(statusValues.has("SUCCESS"), `${statusEnumName} includes SUCCESS`);
  }

  const refundCreateField = checkField(mutationFields, "Mutation", "refundCreate");
  if (refundCreateField) {
    console.log(`         Mutation.refundCreate returns: ${renderTypeRef(refundCreateField.type)}`);
    const inputArg = checkArg(refundCreateField, "Mutation.refundCreate", "input");
    const refundInputTypeName = inputArg ? namedTypeOf(inputArg.type) : null;
    console.log(`         refundCreate's input type is: ${refundInputTypeName}`);

    if (refundInputTypeName) {
      const refundInputFields = await introspectInputFields(admin, refundInputTypeName);
      checkInputField(refundInputFields, refundInputTypeName, "orderId", "ID");
      checkInputField(refundInputFields, refundInputTypeName, "notify");
      const refundLineItemsField = checkInputField(refundInputFields, refundInputTypeName, "refundLineItems");
      const refundLineItemsElementType = refundLineItemsField ? namedTypeOf(refundLineItemsField.type) : null;
      console.log(`         RefundInput.refundLineItems element type is: ${refundLineItemsElementType}`);
      check(
        refundLineItemsElementType === suggestedRefundInputTypeName,
        `RefundInput.refundLineItems reuses the SAME input type as Order.suggestedRefund's refundLineItems argument ` +
          `(${suggestedRefundInputTypeName}) — got ${refundLineItemsElementType}`
      );
      const transactionsInputField = checkInputField(refundInputFields, refundInputTypeName, "transactions");
      const transactionInputTypeName = transactionsInputField ? namedTypeOf(transactionsInputField.type) : null;
      console.log(`         transactions element type is: ${transactionInputTypeName}`);

      if (transactionInputTypeName) {
        const txInputFields = await introspectInputFields(admin, transactionInputTypeName);
        checkInputField(txInputFields, transactionInputTypeName, "orderId", "ID");
        checkInputField(txInputFields, transactionInputTypeName, "parentId", "ID");
        checkInputField(txInputFields, transactionInputTypeName, "gateway", "String");
        const txKindField = checkInputField(txInputFields, transactionInputTypeName, "kind");
        const txKindEnumName = txKindField ? namedTypeOf(txKindField.type) : null;
        if (txKindEnumName) check(txKindEnumName === kindEnumName, `${transactionInputTypeName}.kind uses the same enum as OrderTransaction.kind (${kindEnumName})`);
        checkInputField(txInputFields, transactionInputTypeName, "amount");
      }
    }

    const refundPayloadReturnType = namedTypeOf(refundCreateField.type);
    if (refundPayloadReturnType) {
      const refundPayloadFields = await introspectOutputFields(admin, refundPayloadReturnType);
      const refundField = checkField(refundPayloadFields, refundPayloadReturnType, "refund", "Refund");
      if (refundField) {
        const refundFields = await introspectOutputFields(admin, "Refund");
        checkField(refundFields, "Refund", "id", "ID");
      }
      const refundUserErrorsField = checkField(refundPayloadFields, refundPayloadReturnType, "userErrors");
      const refundUserErrorType = refundUserErrorsField ? namedTypeOf(refundUserErrorsField.type) : null;
      if (refundUserErrorType) {
        const refundUserErrorFields = await introspectOutputFields(admin, refundUserErrorType);
        checkField(refundUserErrorFields, refundUserErrorType, "field", "String");
        checkField(refundUserErrorFields, refundUserErrorType, "message", "String");
      }
    }
  }

  console.log(
    failures === 0
      ? "\nLIVE GATE PASSED — every field/argument/input/enum this adapter references exists with the expected shape on this API version."
      : `\n${failures} ASSERTION(S) FAILED — fix rmaRemedyExecutionAdapter.server.ts to match what this store's schema actually exposes before it handles live traffic.`
  );
}

// NO process.exit() on the success path — see requiredCustomerAccounts.ts's
// own header for why: this module pulls in the Shopify session storage and
// therefore a Prisma client, so handles are still open when main() returns,
// and process.exit() tears the process down before they close, which can
// report a passing gate as a failing exit code.
main()
  .catch((error) => {
    console.error("\n", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    process.exitCode = process.exitCode ?? (failures === 0 ? 0 : 1);
    const { prisma } = await import("~/db/client.server");
    await prisma.$disconnect();
  });

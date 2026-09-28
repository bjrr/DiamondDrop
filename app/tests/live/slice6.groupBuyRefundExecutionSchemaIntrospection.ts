/**
 * SLICE 6 LIVE GATE — schema introspection for a future
 * `groupBuyRefundExecutionAdapter.server.ts` mutation (Group Buy campaign
 * close/settlement task, architect review 2026-09-28).
 *
 * WHY THIS ADAPTER REFUSES EVERY CALL TODAY, restated because this file's
 * whole job is to close that gap: a Group Buy tier-adjustment refund returns
 * NO merchandise — the customer keeps everything, only a price difference
 * moves. RMA's `createRefund` (the obvious thing to reuse) populates
 * `RefundInput.refundLineItems` at the line's full `refundableQuantity`,
 * which the architect independently verified against this same schema is a
 * MERCHANDISE-RETURN shape (restock + returned-quantity accounting). Reusing
 * it here would tell Shopify the customer returned merchandise they kept — a
 * false return record against a real order, hard to notice and unpleasant to
 * unwind. So the production adapter refuses rather than guess, and THIS file
 * exists to close that gap with evidence instead of another guess.
 *
 * ============================================================================
 * THE STARTING HYPOTHESIS — INFERENCE, NOT VERIFICATION, stated exactly as
 * the architect handed it off. `RefundInput`'s complete field list, already
 * confirmed by live introspection for the RMA remedy-execution gate against
 * Admin API 2026-07:
 *
 *   currency, orderId, note, notify, shipping, processedAt, refundLineItems,
 *   refundDuties, transactions, refundMethods, discrepancyReason,
 *   allowOverRefunding
 *
 * There is NO `orderAdjustments` field — an earlier hypothesis this codebase
 * held and the architect has since corrected from that same field list, not
 * from a fresh guess. What the field list points at instead: `orderId` +
 * `transactions` alone, with NO `refundLineItems` at all — a refund
 * transaction against the original payment, returning no merchandise — and
 * `discrepancyReason` existing precisely for a refunded amount that does not
 * reconcile to returned line items. That READS like the intended mechanism
 * for this exact situation. It is still inference from a field list, not
 * confirmation that Shopify accepts or behaves correctly for this shape —
 * exactly the same limitation `slice4.rmaRemedyExecutionSchemaIntrospection.ts`
 * states for itself, and this file states again rather than silently
 * upgrading its own confidence.
 *
 * WHAT THIS GATE CHECKS, PER THE ARCHITECT'S ASSIGNMENT:
 *   1. `OrderTransactionInput` (or whatever `RefundInput.transactions`'
 *      element type actually names — discovered here, never assumed) and its
 *      required fields: amount shape, parent transaction, kind, gateway.
 *   2. The `discrepancyReason` enum's permitted values — LISTED here for a
 *      human to pick the one that honestly describes a price adjustment, not
 *      a return. This script does not choose one; see the TODO at that
 *      section below.
 *   3. Whether a refund with `transactions` and NO `refundLineItems` is
 *      SYNTACTICALLY representable — i.e. `refundLineItems` is not a
 *      required (NON_NULL) field, so omitting it is a legal input shape.
 *      Introspection cannot prove Shopify's server-side validation accepts
 *      an omitted `refundLineItems` at runtime; only actually calling the
 *      mutation could, and that is NOT authorised here (money-moving, no
 *      owner sign-off) — same limitation the RMA gate states for itself.
 *
 * CANNOT BE RUN RIGHT NOW (architect note, 2026-09-28): the live gates
 * authenticate through the Shopify session stored in the LOCAL dev database,
 * which is down in this environment (no Docker; integration testing moved to
 * a remote Fly `carat_test` instead). A run today fails with Prisma's
 * misleading "The table `session` does not exist", which actually means it
 * could not reach the local session-store database — NOT a schema problem.
 * Do not point this at production to work around that; wait for the local
 * dev database (or an equivalent session store) to be available, then run it
 * for real before `groupBuyRefundExecutionAdapter.server.ts`'s production
 * adapter is allowed to stop refusing.
 *
 * RUN:  npx tsx tests/live/slice6.groupBuyRefundExecutionSchemaIntrospection.ts
 *
 * SIDE EFFECTS: NONE. Every query below is `__type`/`__schema` introspection.
 * No `refundCreate` or any other mutation is ever invoked — this file
 * contains no mutation call at all, by design, so there is no way to
 * accidentally move real money by running it.
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
 * field's actual type without asserting a particular name. Passing it
 * asserts an exact match — see `slice4.rmaRemedyExecutionSchemaIntrospection.ts`'s
 * identical helper for why an unconditional assertion here would be wrong.
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

/** True when the field's own type is NOT wrapped in NON_NULL — i.e. it may legally be omitted from the input object. */
function isOptional(field: IntrospectedInputField | undefined): boolean {
  return field !== undefined && field.type.kind !== "NON_NULL";
}

async function main() {
  console.log(`Slice 6 live gate — Group Buy refund execution: RefundInput shape for a non-return price adjustment, against ${SHOP}\n`);

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  // ==========================================================================
  // 1. Mutation.refundCreate -> RefundInput — the FULL field list against the
  //    architect's hypothesis, not just the fields this adapter would use.
  // ==========================================================================
  console.log("1. Mutation.refundCreate + RefundInput's complete field list");
  const mutationFields = await introspectOutputFields(admin, "Mutation");
  const refundCreateField = checkField(mutationFields, "Mutation", "refundCreate");
  const inputArg = checkArg(refundCreateField, "Mutation.refundCreate", "input");
  const refundInputTypeName = inputArg ? namedTypeOf(inputArg.type) : null;
  check(refundInputTypeName !== null, "Mutation.refundCreate's input argument names a concrete input type");
  console.log(`         refundCreate's input type is: ${refundInputTypeName}`);

  const HYPOTHESIZED_FIELDS = [
    "currency",
    "orderId",
    "note",
    "notify",
    "shipping",
    "processedAt",
    "refundLineItems",
    "refundDuties",
    "transactions",
    "refundMethods",
    "discrepancyReason",
    "allowOverRefunding",
  ] as const;

  let refundInputFields: Map<string, IntrospectedInputField> = new Map();
  if (refundInputTypeName) {
    refundInputFields = await introspectInputFields(admin, refundInputTypeName);

    console.log(`         ${refundInputTypeName} — every field actually on this schema:`);
    for (const [name, field] of refundInputFields) {
      console.log(`           ${name}: ${renderTypeRef(field.type)}`);
    }

    for (const name of HYPOTHESIZED_FIELDS) {
      check(refundInputFields.has(name), `${refundInputTypeName} has the hypothesized field "${name}"`);
    }
    for (const name of refundInputFields.keys()) {
      check(
        (HYPOTHESIZED_FIELDS as readonly string[]).includes(name),
        `${refundInputTypeName}.${name} was in the hypothesis (an UNEXPECTED extra field means the API version has moved since the hypothesis was formed)`
      );
    }
  }

  // ==========================================================================
  // 2. Is "transactions with NO refundLineItems" a legal input SHAPE?
  //    (Syntactic only — see this file's header for what introspection
  //    cannot prove.)
  // ==========================================================================
  console.log("\n2. Whether refundLineItems may be omitted while transactions is supplied");
  const orderIdField = checkInputField(refundInputFields, refundInputTypeName ?? "RefundInput", "orderId", "ID");
  check(
    orderIdField !== undefined && orderIdField.type.kind === "NON_NULL",
    `${refundInputTypeName}.orderId is REQUIRED (every refund must still name its order)`
  );
  const refundLineItemsField = refundInputFields.get("refundLineItems");
  check(
    isOptional(refundLineItemsField),
    `${refundInputTypeName}.refundLineItems is OPTIONAL (not NON_NULL) — omitting it entirely is a syntactically legal input`
  );
  const transactionsField = refundInputFields.get("transactions");
  check(transactionsField !== undefined, `${refundInputTypeName} has a "transactions" field`);
  if (transactionsField) console.log(`         ${refundInputTypeName}.transactions: ${renderTypeRef(transactionsField.type)}`);

  // ==========================================================================
  // 3. The transactions element type — "OrderTransactionInput" is the
  //    architect's best guess at the name; DISCOVERED here, never assumed.
  // ==========================================================================
  console.log("\n3. The transactions element input type — required fields for amount, parent transaction, kind, gateway");
  const transactionInputTypeName = transactionsField ? namedTypeOf(transactionsField.type) : null;
  console.log(`         transactions element type is: ${transactionInputTypeName}`);

  if (transactionInputTypeName) {
    const txInputFields = await introspectInputFields(admin, transactionInputTypeName);
    console.log(`         ${transactionInputTypeName} — every field, with required/optional called out:`);
    for (const [name, field] of txInputFields) {
      console.log(`           ${name}: ${renderTypeRef(field.type)}${field.type.kind === "NON_NULL" ? "  [REQUIRED]" : ""}`);
    }

    checkInputField(txInputFields, transactionInputTypeName, "orderId", "ID");

    // "parent transaction" — the field this adapter would need to tie a
    // refund transaction back to the order's original SALE/CAPTURE, the same
    // way rmaRemedyExecutionAdapter.server.ts's createRefund already does.
    checkInputField(txInputFields, transactionInputTypeName, "parentId", "ID");
    checkInputField(txInputFields, transactionInputTypeName, "gateway", "String");

    const kindField = checkInputField(txInputFields, transactionInputTypeName, "kind");
    const kindEnumName = kindField ? namedTypeOf(kindField.type) : null;
    console.log(`         ${transactionInputTypeName}.kind enum type is: ${kindEnumName}`);
    if (kindEnumName) {
      const kindValues = await introspectEnumValues(admin, kindEnumName);
      console.log(`         ${kindEnumName} values: ${[...kindValues].join(", ")}`);
      check(kindValues.has("REFUND"), `${kindEnumName} includes REFUND (the value a pure price-adjustment transaction would use)`);
    }

    const amountField = checkInputField(txInputFields, transactionInputTypeName, "amount");
    if (amountField) console.log(`         ${transactionInputTypeName}.amount type is: ${renderTypeRef(amountField.type)} (a MINOR-UNITS-SAFE decimal-string reader must be used against whatever scalar this names — see minorUnitsToDecimalString's existing convention)`);
  }

  // ==========================================================================
  // 4. discrepancyReason — LISTED, not chosen. A human picks the value that
  //    honestly describes a price adjustment, not a return.
  // ==========================================================================
  console.log("\n4. discrepancyReason — enumerated for a human to choose from (TODO below)");
  const discrepancyReasonField = refundInputFields.get("discrepancyReason");
  check(discrepancyReasonField !== undefined, `${refundInputTypeName ?? "RefundInput"} has a "discrepancyReason" field`);
  if (discrepancyReasonField) {
    console.log(`         ${refundInputTypeName}.discrepancyReason: ${renderTypeRef(discrepancyReasonField.type)}`);
    const discrepancyReasonEnumName = namedTypeOf(discrepancyReasonField.type);
    if (discrepancyReasonEnumName) {
      const values = await introspectEnumValues(admin, discrepancyReasonEnumName);
      console.log(`         ${discrepancyReasonEnumName} values: ${[...values].join(", ")}`);
      // TODO(architect/next engineer): pick ONE value from the list printed
      // above that honestly describes "a Group Buy tier-price adjustment,
      // not a returned item" and hard-code it into
      // groupBuyRefundExecutionAdapter.server.ts's real implementation, with
      // a comment citing this gate's output as the evidence for the choice.
      // This script deliberately does not guess one.
      check(values.size > 0, `${discrepancyReasonEnumName} has at least one value to choose from`);
    }
  }

  // ==========================================================================
  // 5. refundCreate's payload — reference for reading back the result,
  //    reusing the exact same shape the RMA gate already confirmed.
  // ==========================================================================
  console.log("\n5. refundCreate payload — refund.id + userErrors (already confirmed shape, re-checked here)");
  if (refundCreateField) {
    const refundPayloadReturnType = namedTypeOf(refundCreateField.type);
    if (refundPayloadReturnType) {
      const refundPayloadFields = await introspectOutputFields(admin, refundPayloadReturnType);
      const refundField = checkField(refundPayloadFields, refundPayloadReturnType, "refund", "Refund");
      if (refundField) {
        const refundFields = await introspectOutputFields(admin, "Refund");
        checkField(refundFields, "Refund", "id", "ID");
      }
      const userErrorsField = checkField(refundPayloadFields, refundPayloadReturnType, "userErrors");
      const userErrorType = userErrorsField ? namedTypeOf(userErrorsField.type) : null;
      if (userErrorType) {
        const userErrorFields = await introspectOutputFields(admin, userErrorType);
        checkField(userErrorFields, userErrorType, "field", "String");
        checkField(userErrorFields, userErrorType, "message", "String");
      }
    }
  }

  console.log(
    failures === 0
      ? "\nLIVE GATE PASSED — every hypothesized field/argument/input/enum exists with the expected shape on this API version. " +
          "This still does NOT prove Shopify accepts or correctly processes a refund with transactions and no refundLineItems " +
          "at runtime — only that the shape is syntactically legal. Pick a discrepancyReason value from section 4's output " +
          "before writing the real mutation."
      : `\n${failures} ASSERTION(S) FAILED — the hypothesis above does not match this store's schema; ` +
          "re-derive the correct shape from the field listings this run printed before writing " +
          "groupBuyRefundExecutionAdapter.server.ts's real implementation."
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

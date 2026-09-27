/**
 * LIVE GATE — do the RMA remedy adapter's Shopify operations actually exist,
 * with the field names and input shapes it sends?
 *
 * WHY THIS ONE MATTERS MORE THAN THE OTHERS. The order-lookup adapters only
 * READ: a recalled field name there returns nothing and fails visibly and
 * harmlessly. `rmaRemedyExecutionAdapter.server.ts` calls `refundCreate` and
 * `storeCreditAccountCredit`. A wrong field name or input shape there is a
 * runtime GraphQL error at the exact moment a customer is owed money, or —
 * worse — money moving on a shape we guessed. The existing "not
 * live-introspected, flagged in the header" convention was set for read
 * adapters and does not stretch to this one.
 *
 * SCHEMA ONLY. Introspection queries and nothing else. This gate must NEVER
 * execute a refund or issue store credit to prove a shape — that is real
 * money movement against a real store and is not what a test is for. What it
 * cannot tell us is whether a mutation BEHAVES as expected; it tells us the
 * operation exists and the fields we send and read are real, which is the
 * class of error that otherwise surfaces in production.
 *
 * RUN:  npx tsx tests/live/rmaRemedySchemaIntrospection.ts
 * SIDE EFFECTS: none.
 */
import "dotenv/config";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

let failures = 0;
function check(condition: unknown, message: string): void {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) failures += 1;
}

type AdminGraphql = (query: string, options?: { variables?: object }) => Promise<Response>;

interface TypeField {
  name: string;
  type?: { name?: string | null; kind?: string; ofType?: { name?: string | null; kind?: string } | null };
}
interface TypeProbe {
  data?: {
    __type?: {
      name?: string;
      kind?: string;
      fields?: TypeField[] | null;
      inputFields?: TypeField[] | null;
      enumValues?: { name: string }[] | null;
    } | null;
  };
  errors?: unknown;
}

async function main() {
  console.log(`RMA remedy adapter — live schema gate against ${SHOP}\n`);

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);
  const gql = admin.graphql as AdminGraphql;

  async function probeType(name: string): Promise<TypeProbe["data"] extends infer _ ? NonNullable<TypeProbe["data"]>["__type"] : never> {
    const r = await gql(
      `#graphql
        query CaratTypeProbe($n: String!) {
          __type(name: $n) {
            name
            kind
            fields { name type { name kind ofType { name kind } } }
            inputFields { name type { name kind ofType { name kind } } }
            enumValues { name }
          }
        }
      `,
      { variables: { n: name } }
    );
    const body = (await r.json()) as TypeProbe;
    if (body.errors) throw new Error(`introspection errors for ${name}: ${JSON.stringify(body.errors)}`);
    return body.data?.__type ?? null;
  }

  function named(t: TypeField["type"]): string {
    return t?.name ?? t?.ofType?.name ?? t?.kind ?? "?";
  }

  // --- The two mutations actually exist on Mutation -------------------------
  const mutation = await probeType("Mutation");
  const mutationNames = new Set((mutation?.fields ?? []).map((f) => f.name));
  for (const op of ["refundCreate", "storeCreditAccountCredit"]) {
    check(mutationNames.has(op), `Mutation.${op} exists`);
  }

  // --- Order.suggestedRefund, the D7 tax source -----------------------------
  const order = await probeType("Order");
  const orderFields = new Set((order?.fields ?? []).map((f) => f.name));
  check(orderFields.has("suggestedRefund"), "Order.suggestedRefund exists");

  const suggested = await probeType("SuggestedRefund");
  const suggestedFields = new Map((suggested?.fields ?? []).map((f) => [f.name, named(f.type)]));
  console.log(`\n  SuggestedRefund fields: ${[...suggestedFields.keys()].join(", ")}\n`);
  // The adapter needs a merchandise subtotal and a tax figure it can read
  // WITHOUT deriving one from the other (D7).
  for (const f of ["amountSet", "subtotalSet", "totalTaxSet"]) {
    check(suggestedFields.has(f), `SuggestedRefund.${f} exists (got type ${suggestedFields.get(f) ?? "MISSING"})`);
  }

  // --- RefundInput / RefundLineItemInput shapes -----------------------------
  const refundInput = await probeType("RefundInput");
  const refundInputFields = new Set((refundInput?.inputFields ?? []).map((f) => f.name));
  console.log(`\n  RefundInput fields: ${[...refundInputFields].join(", ")}\n`);
  check(refundInput !== null, "RefundInput type exists");
  for (const f of ["orderId", "transactions"]) {
    check(refundInputFields.has(f), `RefundInput.${f} exists`);
  }

  const restock = await probeType("RefundLineItemRestockType");
  const restockValues = (restock?.enumValues ?? []).map((v) => v.name);
  console.log(`  RefundLineItemRestockType values: ${restockValues.join(", ") || "(type absent)"}\n`);

  // --- Store credit -------------------------------------------------------
  const creditInput = await probeType("StoreCreditAccountCreditInput");
  const creditInputFields = new Set((creditInput?.inputFields ?? []).map((f) => f.name));
  console.log(`  StoreCreditAccountCreditInput fields: ${[...creditInputFields].join(", ") || "(type absent)"}\n`);
  check(creditInput !== null, "StoreCreditAccountCreditInput type exists");

  const customer = await probeType("Customer");
  const customerFields = new Set((customer?.fields ?? []).map((f) => f.name));
  check(customerFields.has("storeCreditAccounts"), "Customer.storeCreditAccounts exists (D5 — native store credit, not gift cards)");

  console.log(
    failures === 0
      ? "\nLIVE GATE PASSED — every operation and field the remedy adapter sends or reads exists."
      : `\n${failures} ASSERTION(S) FAILED — the remedy adapter would fail at runtime on a real refund.`
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

// No process.exit(): this module loads a Prisma client via the Shopify session
// storage, and exiting with handles open makes libuv abort AFTER the banner
// prints, turning a pass into a non-zero exit. See requiredCustomerAccounts.ts.
main()
  .catch((error) => {
    console.error("\n", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("~/db/client.server");
    await prisma.$disconnect();
  });

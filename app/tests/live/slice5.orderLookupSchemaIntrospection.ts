/**
 * SLICE 5 LIVE GATE — schema introspection for the two warranty order-lookup
 * adapters (team-lead review note on D33's live-verification gap).
 *
 * WHY INTROSPECTION, NOT DATA. `warrantyOrderLookupAdapter.server.ts` and
 * `warrantyClaimOrderLookupAdapter.server.ts` both carry a RECALLED, NOT
 * LIVE-INTROSPECTED disclaimer on their GraphQL shapes — the risk being that
 * `Order`, `Customer` or `LineItem` do not actually expose a selected field
 * (`email`, `customer { id }`, `lineItems { nodes { id name quantity } }`)
 * under that exact name/type on Admin API 2026-07, which would surface as a
 * hard GraphQL error against a real store. That is a question about the
 * SCHEMA, not about any particular order — `__type` introspection answers it
 * completely, with zero side effects and no real order required. This is
 * deliberately narrower than `slice5.warrantyOrderLookup.ts`'s behavioural
 * gate (which needs a real order and, right now, caratforus-dev has none).
 *
 * WHAT THIS DOES NOT CLOSE. Confirming a field EXISTS with the expected type
 * says nothing about `orders(query: "name:#1001")`'s MATCH semantics — that
 * the `name:` search filter actually resolves to the order with that exact
 * name, rather than some other interpretation of the query string. That is
 * BEHAVIOUR, not schema, and introspection cannot answer it; see
 * `slice5.warrantyOrderLookup.ts`'s own header for that open item and why it
 * stays open until real order data exists on this store.
 *
 * RUN:  npx tsx tests/live/slice5.orderLookupSchemaIntrospection.ts
 *
 * SIDE EFFECTS: NONE. `__type` introspection reads the schema only.
 */
import "dotenv/config";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

let failures = 0;
function check(condition: unknown, message: string): void {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) failures += 1;
}

type AdminGraphql = (query: string, options?: { variables?: object }) => Promise<Response>;

interface IntrospectedField {
  name: string;
  type: { name: string | null; kind: string; ofType: { name: string | null; kind: string } | null };
  args?: { name: string; type: { name: string | null; kind: string; ofType: { name: string | null; kind: string } | null } }[];
}

async function queryRootTypeName(admin: { graphql: AdminGraphql }): Promise<string> {
  const resp = await admin.graphql(`#graphql
    query CaratLiveGateQueryRootName { __schema { queryType { name } } }
  `);
  const body = (await resp.json()) as { errors?: unknown; data?: { __schema: { queryType: { name: string } } } };
  if (body.errors) throw new Error(`introspecting queryType name: ${JSON.stringify(body.errors)}`);
  return body.data!.__schema.queryType.name;
}

async function introspectFields(admin: { graphql: AdminGraphql }, typeName: string): Promise<Map<string, IntrospectedField>> {
  const resp = await admin.graphql(
    `#graphql
      query CaratLiveGateIntrospectType($name: String!) {
        __type(name: $name) {
          name
          fields {
            name
            type { name kind ofType { name kind } }
            args { name type { name kind ofType { name kind } } }
          }
        }
      }
    `,
    { variables: { name: typeName } }
  );
  const body = (await resp.json()) as { errors?: unknown; data?: { __type: { name: string; fields: IntrospectedField[] } | null } };
  if (body.errors) throw new Error(`introspecting ${typeName}: ${JSON.stringify(body.errors)}`);
  const type = body.data?.__type;
  if (!type) throw new Error(`__type(name: "${typeName}") returned null — type does not exist on this schema/API version`);
  return new Map(type.fields.map((f) => [f.name, f]));
}

/** Renders a field's type as GraphQL SDL shorthand, e.g. "String!", "[LineItem!]", "ID" — for a readable PASS/FAIL line, not for comparison logic. */
function renderType(field: IntrospectedField): string {
  const t = field.type;
  const base = t.ofType?.name ?? t.name ?? "?";
  const kindOuter = t.kind === "NON_NULL" ? "!" : "";
  const kindInner = t.ofType?.kind === "NON_NULL" ? "!" : "";
  return t.kind === "LIST" || t.ofType?.kind === "LIST" ? `[${base}${kindInner}]${kindOuter}` : `${base}${kindOuter}`;
}

/** True if a field's named type (unwrapping NON_NULL/LIST) matches `expectedNamedType`. Nullability is reported but not enforced — both adapters already treat every field as possibly absent/null in their TypeScript shapes, so a field being nullable when we assumed required is not a break; the reverse (field missing entirely, or a different named type) is. */
function namedTypeMatches(field: IntrospectedField, expectedNamedType: string): boolean {
  const actual = field.type.ofType?.name ?? field.type.name;
  return actual === expectedNamedType;
}

async function main() {
  console.log(`Slice 5 live gate — Order/Customer/LineItem schema introspection against ${SHOP}\n`);

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  console.log("0. Query root fields — order(id:) and orders(first:, query:), by argument name");
  const rootTypeName = await queryRootTypeName(admin);
  const rootFields = await introspectFields(admin, rootTypeName);

  const orderRoot = rootFields.get("order");
  check(orderRoot !== undefined, "Query.order exists");
  if (orderRoot) {
    const idArg = orderRoot.args?.find((a) => a.name === "id");
    check(idArg !== undefined, 'Query.order has an "id" argument (used by warrantyClaimOrderLookupAdapter.server.ts)');
    check(namedTypeMatches(orderRoot, "Order"), `Query.order returns Order (got ${orderRoot.type.ofType?.name ?? orderRoot.type.name})`);
  }

  const ordersRoot = rootFields.get("orders");
  check(ordersRoot !== undefined, "Query.orders exists");
  if (ordersRoot) {
    const firstArg = ordersRoot.args?.find((a) => a.name === "first");
    const queryArg = ordersRoot.args?.find((a) => a.name === "query");
    check(firstArg !== undefined, 'Query.orders has a "first" argument (used by findOrderByName)');
    check(queryArg !== undefined, 'Query.orders has a "query" argument (used by findOrderByName\'s name: filter)');
    check(
      (queryArg?.type.ofType?.name ?? queryArg?.type.name) === "String",
      `Query.orders' "query" argument is a String (got ${queryArg?.type.ofType?.name ?? queryArg?.type.name})`
    );
  }

  console.log("\n1. Order fields — used by both warrantyOrderLookupAdapter.server.ts and warrantyClaimOrderLookupAdapter.server.ts");
  const orderFields = await introspectFields(admin, "Order");
  for (const [fieldName, expectedType] of [
    ["id", "ID"],
    ["name", "String"],
    ["email", "String"],
    ["customer", "Customer"],
    ["lineItems", "LineItemConnection"],
  ] as const) {
    const field = orderFields.get(fieldName);
    check(field !== undefined, `Order.${fieldName} exists`);
    if (field) {
      console.log(`         Order.${fieldName}: ${renderType(field)}`);
      check(namedTypeMatches(field, expectedType), `Order.${fieldName}'s named type is ${expectedType} (got ${field.type.ofType?.name ?? field.type.name})`);
    }
  }

  console.log("\n2. Customer fields — used by both adapters via order.customer.id");
  const customerFields = await introspectFields(admin, "Customer");
  const customerId = customerFields.get("id");
  check(customerId !== undefined, "Customer.id exists");
  if (customerId) {
    console.log(`         Customer.id: ${renderType(customerId)}`);
    check(namedTypeMatches(customerId, "ID"), `Customer.id's named type is ID (got ${customerId.type.ofType?.name ?? customerId.type.name})`);
  }

  console.log("\n3. LineItem fields — id used by both adapters; name/quantity used ADDITIONALLY by warrantyOrderLookupAdapter.server.ts (the claim-lookup twin selects only id)");
  const lineItemFields = await introspectFields(admin, "LineItem");
  for (const [fieldName, expectedType] of [
    ["id", "ID"],
    ["name", "String"],
    ["quantity", "Int"],
  ] as const) {
    const field = lineItemFields.get(fieldName);
    check(field !== undefined, `LineItem.${fieldName} exists`);
    if (field) {
      console.log(`         LineItem.${fieldName}: ${renderType(field)}`);
      check(namedTypeMatches(field, expectedType), `LineItem.${fieldName}'s named type is ${expectedType} (got ${field.type.ofType?.name ?? field.type.name})`);
    }
  }

  console.log(
    failures === 0
      ? "\nLIVE GATE PASSED — every field either adapter selects exists with the expected named type on this API version."
      : `\n${failures} ASSERTION(S) FAILED — a selected field is missing or has changed type; fix the adapter(s) before relying on this shape.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});

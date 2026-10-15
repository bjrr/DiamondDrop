import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import {
  CostComponentBasis,
  CostComponentType,
  CostComponentValueKind,
  LaborSource,
  Metal,
  StoneCostKind,
  StoneType,
} from "@prisma/client";

import { prisma } from "~/db/client.server";
import {
  createCostComponent,
  createLaborRate,
  createMetalReferencePrice,
  createStoneCost,
  InertComponentTypeError,
  InvalidCaratBandError,
  InvalidCostComponentError,
  OverlappingCaratBandError,
} from "~/db/repositories/pricingConfigurationWrites.server";
import {
  createNextPricingProfileVersion,
  NoActivePricingProfileError,
  PricingProfileVersionRaceError,
  resolveActivePricingProfile,
} from "~/db/repositories/pricingProfileRepository.server";
import {
  parseCaratBand,
  parseCurrency,
  parseEnumValue,
  parseMoneyMinorUnits,
  parseNonNegativeDecimal,
  parsePositiveDecimal,
  parseRate,
  PricingConfigurationInputError,
} from "~/domain/pricing/configurationInput";
import {
  minorUnitsToDisplayAmount,
  rateToPercentDisplay,
  validatePricingProfileSettings,
} from "~/domain/pricing/profileSettings";
import { ALL_COMPONENT_TYPES, INERT_COMPONENT_TYPES } from "~/jobs/pricing/resolveInputs.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/pricing-settings — the operator surface for recurring pricing
 * inputs.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * An architecture audit (2026-10-14) found the pricing values were
 * data-driven, runtime-resolved, versioned and append-only — and had **no
 * operator write path at all**. The only writer to `pricing_profile`,
 * `metal_reference_price`, `stone_cost`, `cost_component` and `labor_rate`
 * anywhere in the repository was `prisma/seed.ts`. Changing the gold price
 * meant an engineer with production database access.
 *
 * That is the gap this closes, and nothing more. It is not a pricing
 * management system: no dashboards, no charts, no commodity feed, no bulk
 * import, no channel management.
 *
 * ============================================================================
 * SCOPE OF A PROFILE CHANGE — STATED ON THE PAGE, NOT JUST HERE
 * ============================================================================
 * Only the `buy_now` profile is ever resolved by this codebase, and it is
 * read by floating Buy Now calculations, by Custom Jewelry card-price
 * derivation, and by Group Buy campaigns at the moment they open and freeze.
 * Labelling this screen "Buy Now settings" would be false. The operator text
 * says so plainly, because someone changing markup needs to know what moves.
 *
 * Already-open Group Buy campaigns are insulated by their frozen
 * profile/version — proven by `frozenRuleVersioning.test.ts`, and this screen
 * creates no path around it: it inserts a new profile version exactly like
 * any other, and the campaign keeps reading the row it froze.
 *
 * ============================================================================
 * SAVING CHANGES CONFIGURATION, NEVER A STOREFRONT PRICE
 * ============================================================================
 * The pipeline is unchanged: configuration → recalculation → price
 * calculation → approval/sync intent → Shopify. Nothing here writes a price
 * to Shopify, and `PRICE_AUTO_PUBLISH_ENABLED` is `false` in production so
 * recalculated prices still require explicit approval. The page says that
 * after every save rather than letting an operator assume the storefront
 * moved.
 *
 * MVP1 does NOT expose a "recalculate now" button — see the note at the foot
 * of this file.
 *
 * ============================================================================
 * AUTHORIZATION
 * ============================================================================
 * `authenticate.admin(request)`, the same embedded boundary every other
 * `app.*` route uses. Writes additionally require an ONLINE session with an
 * associated user, because an unattributable change to pricing policy is not
 * a change anyone can defend later. There is deliberately no App Proxy or
 * storefront path to any of this.
 */

const PROFILE_CODE = "buy_now" as const;

interface MetalRow {
  readonly metal: string;
  readonly pricePerGram: string;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly source: string;
}

interface LaborRow {
  readonly source: string;
  readonly ratePerGram: string;
  readonly currency: string;
  readonly effectiveFrom: string;
}

interface StoneRow {
  readonly stoneType: string;
  readonly shape: string;
  readonly band: string;
  readonly cost: string;
  readonly qualifiers: string;
  readonly effectiveFrom: string;
}

interface ComponentRow {
  readonly componentType: string;
  readonly basis: string;
  readonly valueKind: string;
  readonly value: string;
  readonly effectiveFrom: string;
}

interface LoaderData {
  readonly apiKey: string;
  readonly profile: {
    readonly version: number;
    readonly targetMarkupPercent: string;
    readonly minGrossMarginPercent: string;
    readonly minDollarProfit: string;
    readonly currency: string;
    readonly effectiveFrom: string;
    readonly cardRule: string;
    readonly marginModel: string;
  } | null;
  readonly metals: readonly MetalRow[];
  readonly labor: readonly LaborRow[];
  readonly stones: readonly StoneRow[];
  readonly components: readonly ComponentRow[];
  readonly componentTypes: readonly string[];
  readonly autoPublishEnabled: boolean;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  const now = new Date();
  const profile = await resolveActivePricingProfile(PROFILE_CODE, now).catch(() => null);

  // CURRENTLY APPLICABLE ROWS ONLY — one per key, newest effective row that
  // has actually taken effect. The point of the page is "what is in force",
  // not a history browser (explicitly out of scope).
  const metalRows = await prisma.metalReferencePrice.findMany({
    where: { effectiveFrom: { lte: now } },
    orderBy: [{ metal: "asc" }, { effectiveFrom: "desc" }],
  });
  const laborRows = await prisma.laborRate.findMany({
    where: { effectiveFrom: { lte: now } },
    orderBy: [{ source: "asc" }, { effectiveFrom: "desc" }],
  });
  const stoneRows = await prisma.stoneCost.findMany({
    where: { effectiveFrom: { lte: now } },
    orderBy: [{ stoneType: "asc" }, { caratMin: "asc" }],
  });
  const componentRows = await prisma.costComponent.findMany({
    where: { effectiveFrom: { lte: now } },
    orderBy: [{ componentType: "asc" }, { effectiveFrom: "desc" }],
  });

  const firstPerKey = <T, K>(rows: readonly T[], key: (row: T) => K): T[] => {
    const seen = new Set<K>();
    const out: T[] = [];
    for (const row of rows) {
      const k = key(row);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(row);
    }
    return out;
  };

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    profile: profile
      ? {
          version: profile.version,
          targetMarkupPercent: profile.targetMarkupRate ? rateToPercentDisplay(profile.targetMarkupRate) : "",
          minGrossMarginPercent: rateToPercentDisplay(profile.minGrossMarginRate),
          minDollarProfit: minorUnitsToDisplayAmount(profile.minDollarProfit.amountMinorUnits),
          currency: profile.minDollarProfit.currency,
          effectiveFrom: profile.provenance.effectiveFrom.toISOString(),
          cardRule: profile.regularCardPriceRuleId,
          marginModel: profile.marginModel,
        }
      : null,
    metals: firstPerKey(metalRows, (r) => r.metal).map((r) => ({
      metal: r.metal,
      pricePerGram: r.pricePerGram.toString(),
      currency: r.currency,
      effectiveFrom: r.effectiveFrom.toISOString(),
      source: r.source,
    })),
    labor: firstPerKey(laborRows, (r) => r.source).map((r) => ({
      source: r.source,
      ratePerGram: r.ratePerGram.toString(),
      currency: r.currency,
      effectiveFrom: r.effectiveFrom.toISOString(),
    })),
    /**
     * COLLAPSED TO THE CURRENTLY EFFECTIVE ROW PER LOGICAL KEY, exactly as
     * metal and labor are.
     *
     * The first version listed every row with `effectiveFrom <= now`, which
     * showed superseded costs beside live ones and implied that several
     * prices for the same stone were simultaneously in force. They are not:
     * `selectMostSpecific` filters to applicable rows, keeps the highest
     * specificity, and among those takes the LATEST `effectiveFrom`.
     *
     * The key is therefore the full identity the resolver discriminates on —
     * type, shape, band, and every qualifier. Rows differing in any of those
     * are genuinely co-applicable at different specificities and must all
     * remain visible; only an identical key superseded by a later date is
     * hidden. Collapsing more aggressively would hide real configuration.
     */
    stones: firstPerKey(
      [...stoneRows].sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime()),
      (r) =>
        [
          r.stoneType,
          r.shape,
          r.caratMin.toString(),
          r.caratMax.toString(),
          r.color ?? "",
          r.clarity ?? "",
          r.cutGrade ?? "",
          r.labStatus ?? "",
          r.supplierRef ?? "",
        ].join(" ")
    )
      .sort((a, b) =>
        a.stoneType === b.stoneType
          ? a.caratMin.comparedTo(b.caratMin)
          : a.stoneType.localeCompare(b.stoneType)
      )
      .map((r) => ({
      stoneType: r.stoneType,
      shape: r.shape,
      band: `${r.caratMin.toString()}–${r.caratMax.toString()}`,
      cost:
        r.costKind === "per_stone"
          ? `${minorUnitsToDisplayAmount(r.costMinorUnits ?? 0n)} ${r.currency} per stone`
          : `${r.costPerCarat?.toString() ?? "-"} ${r.currency} per carat`,
      qualifiers:
        [r.color, r.clarity, r.cutGrade, r.labStatus].filter((v) => v !== null && v !== "").join(" / ") ||
        "any (wildcard)",
      effectiveFrom: r.effectiveFrom.toISOString(),
    })),
    /**
     * Keyed on `(componentType, valueKind)` — the natural key
     * `resolveCostComponent` itself resolves on, which is why one component
     * type can legitimately appear twice (payment_processing carries both a
     * fixed fee and a percentage).
     */
    components: firstPerKey(
      [...componentRows].sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime()),
      (r) => `${r.componentType}:${r.valueKind}`
    )
      .filter((r) => !INERT_COMPONENT_TYPES.includes(r.componentType))
      .sort((a, b) => a.componentType.localeCompare(b.componentType))
      .map((r) => ({
        componentType: r.componentType,
        basis: r.basis,
        valueKind: r.valueKind,
        value:
          r.valueKind === "percentage"
            ? `${r.rate?.toString() ?? "-"}`
            : `${minorUnitsToDisplayAmount(r.amountMinorUnits ?? 0n)} ${r.currency ?? ""}`.trim(),
        effectiveFrom: r.effectiveFrom.toISOString(),
      })),
    componentTypes: ALL_COMPONENT_TYPES.filter((t) => !INERT_COMPONENT_TYPES.includes(t)),
    autoPublishEnabled: getEnv().PRICE_AUTO_PUBLISH_ENABLED === "true",
  } satisfies LoaderData;
}

interface ActionData {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly message: string | null;
}

const fail = (...problems: string[]): ActionData => ({ ok: false, problems, message: null });
const succeed = (message: string): ActionData => ({ ok: true, problems: [], message });

/** `staff:<shopify user id>`, from the ONLINE session. Never a form field. */
function resolveStaffActorRef(session: Awaited<ReturnType<typeof authenticate.admin>>["session"]): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return `staff:${associatedUser.id}`;
}

function text(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

function optionalText(form: FormData, name: string): string | null {
  const value = text(form, name);
  return value === "" ? null : value;
}

/**
 * Numeric and enum parsing lives in `~/domain/pricing/configurationInput`,
 * not here. This route previously carried its own patterns and an inline
 * minor-units converter alongside `as never` casts on every enum — which is
 * how `currency` ended up unvalidated against a `char(3)` column that pads
 * rather than rejects.
 */

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  if (request.method !== "POST") {
    return Response.json(fail("Method not allowed."), { status: 405 });
  }

  const actorRef = resolveStaffActorRef(session);
  if (!actorRef) {
    // Offline sessions carry no user. A pricing-policy change attributed to
    // nobody is worse than one that did not happen.
    logger.warn("pricing_settings.no_online_user", {});
    return Response.json(
      fail("Could not identify the signed-in staff user. Open this page from Shopify Admin and try again."),
      { status: 401 }
    );
  }

  const form = await request.formData();
  const intent = text(form, "intent");
  const now = new Date();

  try {
    if (intent === "save-profile") {
      const validation = validatePricingProfileSettings({
        targetMarkupPercent: text(form, "targetMarkupPercent"),
        minGrossMarginPercent: text(form, "minGrossMarginPercent"),
        minDollarProfit: text(form, "minDollarProfit"),
        currency: text(form, "currency") || "USD",
      });
      if (!validation.ok) return Response.json(fail(...validation.problems), { status: 400 });

      const created = await createNextPricingProfileVersion({
        code: PROFILE_CODE,
        settings: validation.value,
        actorRef,
        effectiveFrom: now,
      });

      logger.info("pricing_settings.profile_version_created", {
        version: created.version,
        previousVersion: created.previousVersion,
      });

      return Response.json(
        succeed(
          `Saved as pricing profile version ${created.version}, effective ${created.effectiveFrom.toISOString()}. ` +
            `Version ${created.previousVersion} is unchanged and still governs every price already calculated under it. ` +
            `Product prices do not change until the next recalculation, and no price reaches Shopify without approval.`
        )
      );
    }

    if (intent === "save-metal") {
      // RUNTIME-VALIDATED, not cast. `Metal` is Prisma's generated enum, so
      // the accepted set is exactly the schema's.
      const price = text(form, "pricePerGram");
      const created = await createMetalReferencePrice({
        metal: parseEnumValue(Metal, text(form, "metal"), "Metal"),
        // Strictly positive: the database agrees
        // (`metal_reference_price_positive`), and a zero metal price makes
        // gold free without erroring anywhere visible.
        pricePerGram: parsePositiveDecimal(text(form, "pricePerGram"), "Price per gram"),
        currency: parseCurrency(text(form, "currency") || "USD"),
        effectiveFrom: now,
        source: "manual",
        actorRef,
        note: optionalText(form, "note"),
      });
      return Response.json(
        succeed(
          `Saved ${created.metal} at ${price} per gram of pure metal, effective ${created.effectiveFrom.toISOString()}. ` +
            `Earlier values are unchanged. Prices update at the next recalculation.`
        )
      );
    }

    if (intent === "save-labor") {
      // Zero IS allowed here, matching the database's own stance
      // (`labor_rate_non_negative` is `>= 0`, unlike metal's `> 0`): a
      // supplier quoting labour inside another line is representable.
      const rate = parseNonNegativeDecimal(text(form, "ratePerGram"), "Rate per gram");
      const created = await createLaborRate({
        source: parseEnumValue(LaborSource, text(form, "source"), "Labor source"),
        ratePerGram: rate,
        currency: parseCurrency(text(form, "currency") || "USD"),
        effectiveFrom: now,
        actorRef,
        note: optionalText(form, "note"),
      });
      return Response.json(
        succeed(
          `Saved ${created.source} labor at ${rate} per gram, effective ${created.effectiveFrom.toISOString()}. ` +
            `Earlier rates are unchanged.`
        )
      );
    }

    if (intent === "save-stone") {
      const { caratMin, caratMax } = parseCaratBand(text(form, "caratMin"), text(form, "caratMax"));
      const costKind = parseEnumValue(StoneCostKind, text(form, "costKind"), "Cost kind");
      const amount = text(form, "costAmount");
      const shape = text(form, "shape");
      if (shape === "") {
        return Response.json(fail("Shape is required."), { status: 400 });
      }

      const created = await createStoneCost({
        stoneType: parseEnumValue(StoneType, text(form, "stoneType"), "Stone type"),
        shape,
        caratMin,
        caratMax,
        costKind,
        // A free stone is not a thing. There is no database CHECK here —
        // unlike metal price — so this boundary is the only guard, which is
        // precisely why it is strict rather than permissive.
        costMinorUnits:
          costKind === "per_stone"
            ? parseMoneyMinorUnits(amount, "Stone cost", { allowZero: false })
            : null,
        costPerCarat: costKind === "per_carat" ? parsePositiveDecimal(amount, "Cost per carat") : null,
        currency: parseCurrency(text(form, "currency") || "USD"),
        effectiveFrom: now,
        actorRef,
        color: optionalText(form, "color"),
        clarity: optionalText(form, "clarity"),
        cutGrade: optionalText(form, "cutGrade"),
        labStatus: optionalText(form, "labStatus"),
        supplierRef: optionalText(form, "supplierRef"),
      });
      return Response.json(
        succeed(
          `Saved ${created.stoneType}/${created.shape} ${caratMin}–${caratMax} ct, effective ${created.effectiveFrom.toISOString()}. ` +
            `Earlier rows are unchanged.`
        )
      );
    }

    if (intent === "save-component") {
      const valueKind = parseEnumValue(CostComponentValueKind, text(form, "valueKind"), "Value kind");
      const isAmountKind = valueKind === "fixed" || valueKind === "per_stone";
      const value = text(form, "value");

      const created = await createCostComponent({
        componentType: parseEnumValue(CostComponentType, text(form, "componentType"), "Component type"),
        basis: parseEnumValue(CostComponentBasis, text(form, "basis"), "Basis"),
        valueKind,
        // Zero is legitimate for a component — "we do not incur packaging"
        // is a real configuration, unlike a free gram of gold.
        amountMinorUnits: isAmountKind
          ? parseMoneyMinorUnits(value, "Amount", { allowZero: true })
          : null,
        currency: isAmountKind ? parseCurrency(text(form, "currency") || "USD") : null,
        rate: isAmountKind ? null : parseRate(value, "Rate"),
        effectiveFrom: now,
        actorRef,
        note: optionalText(form, "note"),
      });

      return Response.json(
        succeed(
          `Saved ${created.componentType} (${created.valueKind}), effective ${created.effectiveFrom.toISOString()}. ` +
            `Earlier values are unchanged. Prices update at the next recalculation.`
        )
      );
    }

    return Response.json(fail("Unknown action."), { status: 400 });
  } catch (error) {
    if (error instanceof PricingConfigurationInputError) {
      // A rejected input is the operator's to fix, not a server fault.
      return Response.json(fail(error.message), { status: 400 });
    }
    if (
      error instanceof OverlappingCaratBandError ||
      error instanceof InvalidCaratBandError ||
      error instanceof InvalidCostComponentError ||
      error instanceof InertComponentTypeError
    ) {
      return Response.json(fail(error.message), { status: 400 });
    }
    if (error instanceof NoActivePricingProfileError || error instanceof PricingProfileVersionRaceError) {
      return Response.json(fail(error.message), { status: 409 });
    }
    logger.error("pricing_settings.save_failed", {
      intent,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json(fail("That could not be saved. Nothing was changed."), { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const sectionStyle: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 4,
  padding: "1rem",
  margin: "0 0 1.25rem",
};
const labelStyle: React.CSSProperties = { display: "block", fontSize: "0.85rem", margin: "0 0 0.15rem" };
const inputStyle: React.CSSProperties = { padding: "0.4rem", width: "100%", maxWidth: "18rem" };
const fieldStyle: React.CSSProperties = { margin: "0 0 0.6rem" };
const tableStyle: React.CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: "0.85rem" };
const cellStyle: React.CSSProperties = { borderBottom: "1px solid #eee", padding: "0.3rem 0.5rem", textAlign: "left" };

export default function PricingSettingsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <AppProvider apiKey={data.apiKey}>
      <main style={{ padding: "1rem", fontFamily: "system-ui, sans-serif", maxWidth: "60rem" }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Pricing settings</h1>

        {/* SCOPE, STATED UP FRONT. Not "Buy Now settings" — see the header. */}
        <p style={{ margin: "0 0 1rem", color: "#555" }}>
          Changes affect new and floating pricing calculations, including Custom Jewelry card prices and the pricing
          configuration any <em>future</em> Group Buy campaign freezes when it opens. Existing Group Buy campaigns
          retain the pricing configuration frozen when the campaign opened and are never repriced.
        </p>
        <p style={{ margin: "0 0 1rem", color: "#555" }}>
          Saving here changes configuration only. Product prices update at the next recalculation, and
          {data.autoPublishEnabled
            ? " auto-publish is currently ENABLED, so approved changes may reach Shopify automatically."
            : " no price reaches Shopify without going through the existing approval and sync controls."}
        </p>

        {actionData?.problems?.length ? (
          <ul role="alert" style={{ color: "#b00", margin: "0 0 1rem" }}>
            {actionData.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        {actionData?.ok && actionData.message ? (
          <p role="status" style={{ color: "#060", margin: "0 0 1rem" }}>
            {actionData.message}
          </p>
        ) : null}

        {/* ---- pricing profile ---- */}
        <section style={sectionStyle}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Pricing profile</h2>
          {data.profile ? (
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "#555" }}>
              Currently version {data.profile.version}, effective {data.profile.effectiveFrom}. Margin model{" "}
              {data.profile.marginModel}; card rule {data.profile.cardRule}. Saving creates a new version — the three
              values below are saved together, and earlier versions are never modified.
            </p>
          ) : (
            <p style={{ margin: "0 0 0.75rem", color: "#b00" }}>No active pricing profile is provisioned.</p>
          )}

          <Form method="post">
            <input type="hidden" name="intent" value="save-profile" />
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="targetMarkupPercent">
                Target markup (%)
              </label>
              <input
                style={inputStyle}
                id="targetMarkupPercent"
                name="targetMarkupPercent"
                defaultValue={data.profile?.targetMarkupPercent ?? ""}
                required
              />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="minGrossMarginPercent">
                Minimum gross margin (%)
              </label>
              <input
                style={inputStyle}
                id="minGrossMarginPercent"
                name="minGrossMarginPercent"
                defaultValue={data.profile?.minGrossMarginPercent ?? ""}
                required
              />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="minDollarProfit">
                Minimum profit per item
              </label>
              <input
                style={inputStyle}
                id="minDollarProfit"
                name="minDollarProfit"
                defaultValue={data.profile?.minDollarProfit ?? ""}
                required
              />
            </div>
            <input type="hidden" name="currency" value={data.profile?.currency ?? "USD"} />
            <button type="submit" disabled={busy}>
              Save as new profile version
            </button>
          </Form>
        </section>

        {/* ---- metal reference prices ---- */}
        <section style={sectionStyle}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Metal reference prices</h2>
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", color: "#555" }}>
            Price per gram of <strong>pure</strong> metal. Purity (10k/14k/18k) is applied by the pricing engine.
          </p>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={cellStyle}>Metal</th>
                <th style={cellStyle}>Per gram</th>
                <th style={cellStyle}>Effective</th>
                <th style={cellStyle}>Source</th>
              </tr>
            </thead>
            <tbody>
              {data.metals.map((m) => (
                <tr key={m.metal}>
                  <td style={cellStyle}>{m.metal}</td>
                  <td style={cellStyle}>
                    {m.pricePerGram} {m.currency}
                  </td>
                  <td style={cellStyle}>{m.effectiveFrom}</td>
                  <td style={cellStyle}>{m.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Form method="post" style={{ marginTop: "0.75rem" }}>
            <input type="hidden" name="intent" value="save-metal" />
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="metal">
                Metal
              </label>
              <select style={inputStyle} id="metal" name="metal" required>
                <option value="gold">gold</option>
                <option value="sterling_silver">sterling_silver</option>
                <option value="platinum">platinum</option>
              </select>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="pricePerGram">
                Price per gram (pure)
              </label>
              <input style={inputStyle} id="pricePerGram" name="pricePerGram" required />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="metalNote">
                Note / source (optional)
              </label>
              <input style={inputStyle} id="metalNote" name="note" />
            </div>
            <button type="submit" disabled={busy}>
              Add metal price
            </button>
          </Form>
        </section>

        {/* ---- labor rates ---- */}
        <section style={sectionStyle}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Labor rates</h2>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={cellStyle}>Source</th>
                <th style={cellStyle}>Per gram</th>
                <th style={cellStyle}>Effective</th>
              </tr>
            </thead>
            <tbody>
              {data.labor.map((l) => (
                <tr key={l.source}>
                  <td style={cellStyle}>{l.source}</td>
                  <td style={cellStyle}>
                    {l.ratePerGram} {l.currency}
                  </td>
                  <td style={cellStyle}>{l.effectiveFrom}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Form method="post" style={{ marginTop: "0.75rem" }}>
            <input type="hidden" name="intent" value="save-labor" />
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="laborSource">
                Source
              </label>
              <select style={inputStyle} id="laborSource" name="source" required>
                <option value="india">india</option>
                <option value="china">china</option>
                <option value="usa">usa</option>
              </select>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="ratePerGram">
                Rate per gram
              </label>
              <input style={inputStyle} id="ratePerGram" name="ratePerGram" required />
            </div>
            <button type="submit" disabled={busy}>
              Add labor rate
            </button>
          </Form>
        </section>

        {/* ---- stone costs ---- */}
        <section style={sectionStyle}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Stone costs</h2>
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", color: "#555" }}>
            Bands are half-open: <strong>[minimum, maximum)</strong>, so a 0.90–1.10 band covers 0.90 but not 1.10.
            Leaving colour, clarity, cut or lab status blank makes the row a <strong>wildcard</strong> that applies to
            every quality — MVP1 costing does not vary by quality unless you add a more specific row.
          </p>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={cellStyle}>Type</th>
                <th style={cellStyle}>Shape</th>
                <th style={cellStyle}>Band (ct)</th>
                <th style={cellStyle}>Cost</th>
                <th style={cellStyle}>Qualifiers</th>
              </tr>
            </thead>
            <tbody>
              {data.stones.map((s) => (
                <tr key={`${s.stoneType}-${s.shape}-${s.band}-${s.effectiveFrom}`}>
                  <td style={cellStyle}>{s.stoneType}</td>
                  <td style={cellStyle}>{s.shape}</td>
                  <td style={cellStyle}>{s.band}</td>
                  <td style={cellStyle}>{s.cost}</td>
                  <td style={cellStyle}>{s.qualifiers}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Form method="post" style={{ marginTop: "0.75rem" }}>
            <input type="hidden" name="intent" value="save-stone" />
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="stoneType">
                Stone type
              </label>
              <select style={inputStyle} id="stoneType" name="stoneType" required>
                <option value="lab_diamond">lab_diamond</option>
                <option value="natural_diamond">natural_diamond</option>
                <option value="moissanite">moissanite</option>
                <option value="colored_gemstone">colored_gemstone</option>
                <option value="accent_melee">accent_melee</option>
              </select>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="shape">
                Shape
              </label>
              <input style={inputStyle} id="shape" name="shape" placeholder="round" required />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="caratMin">
                Carat minimum (inclusive)
              </label>
              <input style={inputStyle} id="caratMin" name="caratMin" required />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="caratMax">
                Carat maximum (exclusive)
              </label>
              <input style={inputStyle} id="caratMax" name="caratMax" required />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="costKind">
                Cost kind
              </label>
              <select style={inputStyle} id="costKind" name="costKind" required>
                <option value="per_stone">per_stone</option>
                <option value="per_carat">per_carat</option>
              </select>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="costAmount">
                Cost amount (per stone) or rate (per carat)
              </label>
              <input style={inputStyle} id="costAmount" name="costAmount" required />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="color">
                Colour (optional — blank is a wildcard)
              </label>
              <input style={inputStyle} id="color" name="color" />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="clarity">
                Clarity (optional)
              </label>
              <input style={inputStyle} id="clarity" name="clarity" />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="cutGrade">
                Cut grade (optional)
              </label>
              <input style={inputStyle} id="cutGrade" name="cutGrade" />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="labStatus">
                Lab status (optional)
              </label>
              <input style={inputStyle} id="labStatus" name="labStatus" />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="supplierRef">
                Supplier reference (optional)
              </label>
              <input style={inputStyle} id="supplierRef" name="supplierRef" />
            </div>
            <button type="submit" disabled={busy}>
              Add stone cost
            </button>
          </Form>
        </section>

        {/* ---- cost components ---- */}
        <section style={sectionStyle}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Cost components</h2>
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", color: "#555" }}>
            Metal loss, casting, setting, polishing, assembly, QC, packaging, shipping, insurance, warranty reserve and
            supplier fee. A component is identified by its <strong>type and value kind</strong>, so one type can carry
            both a fixed fee and a percentage. <strong>Fixed</strong> and <strong>per stone</strong> take an amount and
            a currency; <strong>percentage</strong> takes a decimal fraction (0.029 means 2.9%).
          </p>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={cellStyle}>Component</th>
                <th style={cellStyle}>Basis</th>
                <th style={cellStyle}>Kind</th>
                <th style={cellStyle}>Value</th>
                <th style={cellStyle}>Effective</th>
              </tr>
            </thead>
            <tbody>
              {data.components.map((c) => (
                <tr key={`${c.componentType}-${c.valueKind}`}>
                  <td style={cellStyle}>{c.componentType}</td>
                  <td style={cellStyle}>{c.basis}</td>
                  <td style={cellStyle}>{c.valueKind}</td>
                  <td style={cellStyle}>{c.value}</td>
                  <td style={cellStyle}>{c.effectiveFrom}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Form method="post" style={{ marginTop: "0.75rem" }}>
            <input type="hidden" name="intent" value="save-component" />
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="componentType">
                Component type
              </label>
              <select style={inputStyle} id="componentType" name="componentType" required>
                {data.componentTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="basis">
                Basis
              </label>
              <select style={inputStyle} id="basis" name="basis" required>
                <option value="cost_side">cost_side</option>
                <option value="revenue_side">revenue_side</option>
              </select>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="valueKind">
                Value kind
              </label>
              <select style={inputStyle} id="valueKind" name="valueKind" required>
                <option value="fixed">fixed</option>
                <option value="per_stone">per_stone</option>
                <option value="percentage">percentage</option>
              </select>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="componentValue">
                Amount (fixed / per stone) or rate (percentage)
              </label>
              <input style={inputStyle} id="componentValue" name="value" required />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="componentNote">
                Note (optional)
              </label>
              <input style={inputStyle} id="componentNote" name="note" />
            </div>
            <button type="submit" disabled={busy}>
              Add cost component
            </button>
          </Form>
        </section>
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

/**
 * NO "RECALCULATE NOW" BUTTON IN MVP1 — a reported limitation, not an
 * oversight.
 *
 * `runPriceRecalculation` with no `variantIds` sweeps every active variant,
 * and the integration suite measures single runs at tens of seconds against a
 * remote database. Running that inside an embedded admin request would block
 * the request past any sane timeout, and making it safe means a job-status
 * surface with polling — which is materially more scope than this gap needs.
 *
 * The scheduled `cron-price-recalculation` machine already runs daily and
 * picks up configuration changes, so the behaviour is "configuration saved
 * now, prices refreshed within a day", which every save message says plainly.
 * Inventing a second recalculation mechanism to avoid that wait would be
 * exactly the kind of parallel pricing path this codebase refuses elsewhere.
 */

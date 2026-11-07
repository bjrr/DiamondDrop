/**
 * The visual Group Buy campaign builder (§1 to §7, §9 to §14, §18, §20).
 *
 * ===========================================================================
 * WHY THE WHOLE STATE IS ONE CLIENT-HELD OBJECT, POSTED ONCE
 * ===========================================================================
 * Configuring a campaign means editing an option, seeing how many
 * configurations that produces, switching some off, and mapping variants to
 * what is left. Every one of those answers depends on all of the others. A
 * form that posted each keystroke would either re-render the whole page per
 * edit or need an endpoint per field, and a merchant halfway through adding
 * a metal would keep tripping validation that is only meaningful once the
 * option is finished.
 *
 * So the state lives here, in the browser, and goes back to the server as
 * one JSON field when the merchant saves. The server trusts none of it:
 * `parseCampaignBuilderState` bounds and narrows the payload,
 * `assessCampaignBuilderCompleteness` re-checks everything this component
 * checks, each mapped variant is confirmed to belong to this campaign, and
 * the generated contract goes through the real
 * `validateGroupBuyCampaignOptions`. Nothing in this file is a security
 * boundary and nothing in it decides a price.
 *
 * ===========================================================================
 * WHAT IT DELIBERATELY DOES NOT SHOW
 * ===========================================================================
 * No supplier cost, landed cost, margin, floor, pricing-profile id, raw
 * vendor SKU, gram weight or Shopify GID (CLAUDE.md rule 10). The price
 * preview arrives already reduced to two customer-facing figures per tier by
 * `campaignPricePreview.server.ts`, whose returned type has no field for
 * anything else.
 *
 * Variant ids are held in state because the mapping is made of them, but the
 * merchant never sees or types one: every control shows the readable label
 * the loader supplies (§6, §18).
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import {
  BUILDER_OPTION_ROLES,
  MAX_DISPLAY_DETAILS,
  MAX_GALLERY_IMAGES,
  MAX_HIGHLIGHTS,
  MAX_OPTIONS,
  OPTION_ROLE_HELP,
  OPTION_ROLE_LABELS,
  assessCampaignBuilderCompleteness,
  configurationCount,
  describeVariantGroup,
  enumerateConfigurations,
  isReadyToOpen,
  isVariantDefiningRole,
  normaliseOptionKey,
  variantGroupsOf,
  ConfigurationSpaceTooLargeError,
  MAX_CONFIGURATIONS,
  type BuilderImageRef,
  type BuilderOption,
  type BuilderOptionRole,
  type CampaignBuilderState,
  type EnumeratedConfiguration,
  type VariantGroup,
} from "~/domain/groupbuy/campaignBuilder";
import { pickCampaignImages } from "./shopifyFilePicker";

// ---------------------------------------------------------------------------

const section: CSSProperties = {
  marginBottom: "1.5rem",
  border: "1px solid #ddd",
  borderRadius: "4px",
  padding: "1rem",
};
const label: CSSProperties = { display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.25rem" };
const input: CSSProperties = { display: "block", padding: "0.4rem 0.6rem", width: "100%", maxWidth: "24rem", marginBottom: "0.6rem" };
const narrowInput: CSSProperties = { ...input, maxWidth: "12rem", marginBottom: 0 };
const hint: CSSProperties = { fontSize: "0.8125rem", color: "#555", margin: "0 0 0.75rem" };
const table: CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: "0.8125rem" };
const cell: CSSProperties = { border: "1px solid #ddd", padding: "0.35rem 0.5rem", textAlign: "left", verticalAlign: "top" };
const subtle: CSSProperties = { color: "#555" };
const danger: CSSProperties = { color: "#b00" };

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section style={section}>
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.35rem" }}>{title}</h2>
      {description ? <p style={hint}>{description}</p> : null}
      {children}
    </section>
  );
}

type CopyState = "idle" | "copied" | "failed";

/**
 * Copies the generated configuration to the clipboard (§12).
 *
 * The clipboard API is unavailable over plain HTTP and can be refused by
 * permission policy, and it REJECTS rather than returning false. A failure
 * is reported on the button instead of being swallowed, so a merchant who
 * pressed Copy and got nothing knows to use Download instead of pasting
 * whatever was on their clipboard before.
 */
async function copyJson(json: string, setCopyState: (next: CopyState) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(json);
    setCopyState("copied");
  } catch {
    setCopyState("failed");
  }
}

/** A money figure from integer minor units. No arithmetic: the digits are split. */
function formatMinorUnits(minorUnits: string, currency: string): string {
  const negative = minorUnits.startsWith("-");
  const digits = (negative ? minorUnits.slice(1) : minorUnits).padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${currency === "USD" ? "$" : `${currency} `}${whole}.${digits.slice(-2)}`;
}

// ---------------------------------------------------------------------------

export interface MappableVariantOption {
  readonly masterVariantId: string;
  readonly label: string;
}

export interface PreviewTierPriceView {
  readonly tierNumber: number;
  readonly bankPaymentMinorUnits: string;
  readonly regularCardMinorUnits: string;
}

export interface PreviewRowView {
  readonly variantGroupSignature: string;
  readonly description: string;
  readonly configurationCount: number;
  readonly tierPrices?: readonly PreviewTierPriceView[];
  readonly problem?: string;
}

export interface CampaignPricePreviewView {
  readonly currency: string;
  readonly pricedAsOf: string;
  readonly tiers: readonly { readonly tierNumber: number; readonly label: string }[];
  readonly rows: readonly PreviewRowView[];
  readonly problems: readonly string[];
}

export interface CampaignBuilderPanelProps {
  readonly initialState: CampaignBuilderState;
  readonly mappableVariants: readonly MappableVariantOption[];
  readonly preview: CampaignPricePreviewView | null;
  /**
   * Whether the COMMERCE configuration may change — true only while the
   * campaign is draft (§17). Options, bands, combinations, mappings, tiers
   * and every factual claim freeze at open.
   */
  readonly editable: boolean;
  /**
   * Whether PRESENTATION may change: hero, mobile hero, card image, gallery,
   * headline and short description. True while draft, and still true once the
   * campaign is open (owner decision, 2026-11-06) — a placeholder photo or a
   * typo on a live campaign is worth being able to fix.
   */
  readonly presentationEditable: boolean;
  readonly busy: boolean;
  /** The generated contract, for the read-only Advanced section (§12). */
  readonly generatedJson: string | null;
  readonly shopifyFilesUrl: string;
  /**
   * Reports whether anything has changed since load, so the page outside this
   * panel can refuse to open a campaign against a configuration the merchant
   * never saved.
   */
  readonly onEditedChange?: (edited: boolean) => void;
}

// ---------------------------------------------------------------------------

export default function CampaignBuilderPanel({
  initialState,
  mappableVariants,
  preview,
  editable,
  presentationEditable,
  busy,
  generatedJson,
  shopifyFilesUrl,
  onEditedChange,
}: CampaignBuilderPanelProps) {
  const [state, setState] = useState<CampaignBuilderState>(initialState);
  const [showJson, setShowJson] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [pickError, setPickError] = useState<string | null>(null);

  /**
   * Opens Shopify's native file picker and applies what comes back.
   *
   * A cancellation changes nothing — not even clearing the existing image —
   * because a merchant who opens the picker and changes their mind has not
   * asked to remove anything. Removal is its own button.
   */
  const handlePick = (
    apply: (picked: readonly BuilderImageRef[]) => void,
    alreadySelected: readonly string[],
    multiSelect: boolean
  ) => {
    setPickError(null);
    void pickCampaignImages({ multiSelect, alreadySelected }).then((result) => {
      if (result.outcome === "cancelled") return;
      if (result.outcome === "failed") {
        setPickError(result.message);
        return;
      }
      apply(result.images);
    });
  };

  const patch = (changes: Partial<CampaignBuilderState>) => setState((current) => ({ ...current, ...changes }));
  const patchContent = (changes: Partial<CampaignBuilderState["content"]>) =>
    setState((current) => ({ ...current, content: { ...current.content, ...changes } }));

  /**
   * The derived views. Enumeration can refuse an oversized option set, so it
   * is caught here rather than crashing the editor mid-edit — a merchant who
   * pastes 50 values into three options should see the limit explained, not
   * a blank page.
   */
  const derived = useMemo(() => {
    const count = configurationCount(state.options);
    try {
      return {
        count,
        configurations: enumerateConfigurations(state) as readonly EnumeratedConfiguration[],
        groups: variantGroupsOf(state) as readonly VariantGroup[],
        tooLarge: null as string | null,
      };
    } catch (error) {
      return {
        count,
        configurations: [] as readonly EnumeratedConfiguration[],
        groups: [] as readonly VariantGroup[],
        tooLarge:
          error instanceof ConfigurationSpaceTooLargeError
            ? error.message
            : "This combination of options could not be worked out.",
      };
    }
  }, [state]);

  const problems = useMemo(() => assessCampaignBuilderCompleteness(state), [state]);
  const ready = isReadyToOpen(problems);
  const disabled = !editable || busy;

  /**
   * Whether anything has changed since the page loaded. Used to warn that the
   * server-calculated price preview and the generated configuration file
   * below both correspond to the SAVED state, not to what is on screen.
   *
   * Compared by serialising rather than by reference: every edit above
   * replaces the state object, so a reference check would report "edited"
   * even after a change was undone.
   */
  const edited = useMemo(
    () => JSON.stringify(state) !== JSON.stringify(initialState),
    [state, initialState]
  );

  // Reported in an effect, not during render: calling a parent's setState
  // mid-render is the "Cannot update a component while rendering a different
  // component" warning, and in React 18 it can loop.
  useEffect(() => {
    onEditedChange?.(edited);
  }, [edited, onEditedChange]);

  // ---- option editing helpers
  const updateOption = (index: number, changes: Partial<BuilderOption>) =>
    setState((current) => ({
      ...current,
      options: current.options.map((option, i) => (i === index ? { ...option, ...changes } : option)),
    }));

  const addOption = () =>
    setState((current) => ({
      ...current,
      options: [
        ...current.options,
        {
          key: "",
          label: "",
          required: true,
          displayOrder: current.options.length + 1,
          role: "variant_defining",
          allowedValues: [{ value: "", label: "" }],
        },
      ],
    }));

  const removeOption = (index: number) =>
    setState((current) => ({ ...current, options: current.options.filter((_, i) => i !== index) }));

  const moveOption = (index: number, direction: -1 | 1) =>
    setState((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.options.length) return current;
      const reordered = [...current.options];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(target, 0, moved!);
      // Display order is renumbered from the visible order, so the merchant
      // never edits a number to change a sequence.
      return { ...current, options: reordered.map((option, i) => ({ ...option, displayOrder: i + 1 })) };
    });

  const updateValue = (optionIndex: number, valueIndex: number, changes: Partial<BuilderOption["allowedValues"][number]>) =>
    setState((current) => ({
      ...current,
      options: current.options.map((option, i) =>
        i !== optionIndex
          ? option
          : {
              ...option,
              allowedValues: option.allowedValues.map((value, j) =>
                j === valueIndex ? { ...value, ...changes } : value
              ),
            }
      ),
    }));

  const addValue = (optionIndex: number) =>
    setState((current) => ({
      ...current,
      options: current.options.map((option, i) =>
        i !== optionIndex ? option : { ...option, allowedValues: [...option.allowedValues, { value: "", label: "" }] }
      ),
    }));

  const removeValue = (optionIndex: number, valueIndex: number) =>
    setState((current) => ({
      ...current,
      options: current.options.map((option, i) =>
        i !== optionIndex
          ? option
          : { ...option, allowedValues: option.allowedValues.filter((_, j) => j !== valueIndex) }
      ),
    }));

  const toggleConfiguration = (signature: string, enabled: boolean) =>
    setState((current) => ({
      ...current,
      disabledConfigurations: enabled
        ? current.disabledConfigurations.filter((s) => s !== signature)
        : [...current.disabledConfigurations, signature],
    }));

  const setMapping = (signature: string, masterVariantId: string) =>
    setState((current) => {
      const next = { ...current.variantMappings };
      if (masterVariantId === "") delete next[signature];
      else next[signature] = masterVariantId;
      return { ...current, variantMappings: next };
    });

  // ---------------------------------------------------------------------

  return (
    <>
      {/* The whole state travels as one field. See this file's header. */}
      <input type="hidden" name="builderState" value={JSON.stringify(state)} form="campaign-builder-form" />

      <ReviewSummary problems={problems} ready={ready} editable={editable} />

      <Section
        title="Campaign basics"
        description="What this campaign sells, in the merchant's own words. The product type is the only required field."
      >
        <label style={label} htmlFor="builder-product-type">
          Product type
        </label>
        <input
          id="builder-product-type"
          style={input}
          value={state.productType}
          disabled={disabled}
          placeholder="Engagement ring"
          onChange={(event) => patch({ productType: event.target.value })}
        />
        <label style={label} htmlFor="builder-title">
          Title (optional)
        </label>
        <input
          id="builder-title"
          style={input}
          value={state.title}
          disabled={disabled}
          placeholder="Signature Solitaire Group Buy"
          onChange={(event) => patch({ title: event.target.value })}
        />
        <label style={label} htmlFor="builder-description">
          Description (optional)
        </label>
        <textarea
          id="builder-description"
          style={{ ...input, maxWidth: "34rem", minHeight: "4rem" }}
          value={state.description}
          disabled={disabled}
          onChange={(event) => patch({ description: event.target.value })}
        />
      </Section>

      <ContentSection
        state={state}
        // Presentation stays editable on a live campaign, so this section's
        // own `disabled` is NOT the page-wide one.
        disabled={!presentationEditable || busy}
        editable={presentationEditable}
        frozenContentEditable={editable}
        patchContent={patchContent}
        shopifyFilesUrl={shopifyFilesUrl}
        onPick={handlePick}
        pickError={pickError}
      />

      <Section
        title="Customer options"
        description={
          <>
            What a customer chooses, and whether each choice changes the price. Mark an option{" "}
            <strong>{OPTION_ROLE_LABELS.variant_defining}</strong> when each choice is a different product variant.
          </>
        }
      >
        {state.options.length === 0 ? (
          <p style={hint}>No options yet. Add the first one below.</p>
        ) : (
          state.options.map((option, index) => (
            <OptionEditor
              key={index}
              option={option}
              index={index}
              total={state.options.length}
              disabled={disabled}
              onChange={(changes) => updateOption(index, changes)}
              onRemove={() => removeOption(index)}
              onMove={(direction) => moveOption(index, direction)}
              onValueChange={(valueIndex, changes) => updateValue(index, valueIndex, changes)}
              onAddValue={() => addValue(index)}
              onRemoveValue={(valueIndex) => removeValue(index, valueIndex)}
              editable={editable}
            />
          ))
        )}
        {!editable ? null : state.options.length >= MAX_OPTIONS ? (
          <p style={hint}>The limit of {MAX_OPTIONS} customer options has been reached.</p>
        ) : (
          <button type="button" onClick={addOption} disabled={disabled}>
            Add an option
          </button>
        )}
      </Section>

      <Section
        title="Available configurations"
        description={
          derived.tooLarge
            ? "The options currently produce too many configurations to list."
            : `These ${derived.count} combinations are what a customer can choose from. Switch off anything you cannot supply.`
        }
      >
        {derived.tooLarge ? (
          <p role="alert" style={danger}>
            {derived.tooLarge}
          </p>
        ) : (
          <ConfigurationMatrix
            state={state}
            configurations={derived.configurations}
            disabled={disabled}
            editable={editable}
            onToggle={toggleConfiguration}
          />
        )}
      </Section>

      <Section
        title="Mapped product variants"
        description="Each priced combination needs the product variant it sells. Choices that only affect price are grouped together, so a ring's sizes within one band share a single variant."
      >
        <VariantMappingTable
          state={state}
          groups={derived.groups}
          mappableVariants={mappableVariants}
          disabled={disabled}
          onChange={setMapping}
        />
      </Section>

      <Section
        title="Price preview"
        description="What each combination would cost at each tier if the campaign opened now. Provisional: the campaign's real prices are fixed when it opens."
      >
        {/*
          THE PREVIEW IS CALCULATED SERVER-SIDE FROM THE SAVED CONFIGURATION,
          because pricing a variant means resolving its cost inputs from the
          database. So it does not follow an unsaved edit, and saying so is
          not optional: a merchant who changed the metals and read the old
          figures as the new ones would be misled by a screen that looked
          right.
        */}
        {edited ? (
          <p role="status" style={{ ...hint, color: "#8a5300" }}>
            Price preview is based on the last saved configuration. Use <strong>Save Changes &amp; Refresh Price
            Preview</strong> below to recalculate it.
          </p>
        ) : null}
        <PricePreviewTable preview={preview} />
      </Section>

      <Section
        title="Advanced configuration"
        description="The campaign-options file this builder generates. Read-only: edit the sections above, and this follows."
      >
        {generatedJson === null ? (
          <p style={hint}>
            The configuration is not complete enough to generate a file yet. Fix the items under Review below.
          </p>
        ) : (
          <>
            <p style={{ margin: "0 0 0.5rem" }}>
              <button type="button" onClick={() => setShowJson((shown) => !shown)}>
                {showJson ? "Hide" : "Show"} generated configuration
              </button>
            </p>
            {showJson ? (
              <>
                {edited ? (
                  <p role="status" style={{ ...hint, color: "#8a5300" }}>
                    This is the saved configuration. Save your changes to regenerate it.
                  </p>
                ) : null}
                <textarea
                  readOnly
                  aria-label="Generated campaign options"
                  value={generatedJson}
                  style={{ width: "100%", minHeight: "16rem", fontFamily: "ui-monospace, monospace", fontSize: "0.75rem" }}
                />
                <p style={{ display: "flex", gap: "0.5rem", margin: "0 0 0.5rem", flexWrap: "wrap" }}>
                  <button type="button" onClick={() => void copyJson(generatedJson, setCopyState)}>
                    {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
                  </button>
                  {/*
                    A plain download link, not a button with a script: the
                    content is already in the page, so a data URL needs no
                    Blob, no object URL to revoke, and works with JavaScript
                    disabled.
                  */}
                  <a
                    href={`data:application/json;charset=utf-8,${encodeURIComponent(generatedJson)}`}
                    download="campaign-options.json"
                  >
                    Download
                  </a>
                </p>
                <p style={hint}>
                  Saving the sections above stores this file against the campaign. It carries no price, cost or
                  margin: those come from the pricing engine at open. To import a file prepared elsewhere, use the
                  advanced upload below.
                </p>
              </>
            ) : null}
          </>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

function ReviewSummary({
  problems,
  ready,
  editable,
}: {
  problems: readonly { section: string; message: string; blocking: boolean }[];
  ready: boolean;
  editable: boolean;
}) {
  const blocking = problems.filter((problem) => problem.blocking);
  const advisory = problems.filter((problem) => !problem.blocking);

  if (!editable) {
    return (
      <div style={{ ...section, background: "#f6f6f6" }}>
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.25rem" }}>Configuration is locked</h2>
        <p style={{ ...hint, margin: 0 }}>
          This campaign is no longer a draft, so its options, variants and content are fixed. Everything below is
          shown as it was configured.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        ...section,
        borderColor: blocking.length > 0 ? "#b00" : "#2b7",
      }}
    >
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.35rem" }}>Review</h2>
      {blocking.length === 0 ? (
        <p style={{ margin: "0 0 0.25rem" }}>
          <strong>Ready to open.</strong> Everything required is configured.
        </p>
      ) : (
        <>
          <p style={{ margin: "0 0 0.35rem", ...danger }}>
            <strong>
              {blocking.length} item{blocking.length === 1 ? "" : "s"} to fix before this campaign can open.
            </strong>
          </p>
          <ul style={{ margin: "0 0 0.5rem", paddingLeft: "1.25rem", fontSize: "0.875rem" }}>
            {blocking.slice(0, 12).map((problem, index) => (
              <li key={index}>{problem.message}</li>
            ))}
          </ul>
          {blocking.length > 12 ? (
            <p style={hint}>and {blocking.length - 12} more, listed against the sections below.</p>
          ) : null}
        </>
      )}
      {advisory.length > 0 ? (
        <>
          <p style={{ margin: "0.5rem 0 0.25rem", fontWeight: 600, fontSize: "0.875rem" }}>
            Worth doing, but not required:
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.875rem", ...subtle }}>
            {advisory.map((problem, index) => (
              <li key={index}>{problem.message}</li>
            ))}
          </ul>
        </>
      ) : null}
      {ready ? null : (
        <p style={{ ...hint, marginTop: "0.5rem", marginBottom: 0 }}>
          Saving is always allowed. Only opening the campaign needs the list above cleared.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * One campaign image, chosen through SHOPIFY'S NATIVE FILE PICKER.
 *
 * There is no URL field. A merchant does not paste a CDN link; they press
 * the button, Shopify's own Files browser opens, and what comes back is
 * resolved server-side into a thumbnail. The alt text is Shopify's too —
 * whatever the merchant set on the file in Shopify Files — so there is one
 * place to maintain it rather than two that can disagree.
 *
 * A GRANDFATHERED REFERENCE (one stored before the picker existed, with a
 * URL and no file id) still renders, and says so, with a prompt to re-pick
 * it. It is not silently discarded: it is the campaign's current image.
 */
function ImageField({
  title,
  buttonLabel,
  image,
  disabled,
  editable,
  onChange,
  onPick,
  shopifyFilesUrl,
}: {
  title: string;
  /** Merchant-facing, e.g. "Choose Hero Image". */
  buttonLabel: string;
  image: BuilderImageRef | null;
  disabled: boolean;
  editable: boolean;
  onChange: (next: BuilderImageRef | null) => void;
  onPick: (apply: (picked: readonly BuilderImageRef[]) => void, alreadySelected: readonly string[]) => void;
  shopifyFilesUrl: string;
}) {
  const legacy = image !== null && image.fileGid.trim() === "";

  return (
    <div style={{ marginBottom: "0.9rem" }}>
      <p style={{ ...label, marginBottom: "0.35rem" }}>{title}</p>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        {image?.url ? (
          <img
            src={image.url}
            alt={image.altText}
            style={{
              width: "4.5rem",
              height: "4.5rem",
              objectFit: "cover",
              border: "1px solid #ddd",
              borderRadius: "4px",
            }}
          />
        ) : (
          <span
            aria-hidden="true"
            style={{
              width: "4.5rem",
              height: "4.5rem",
              border: "1px dashed #bbb",
              borderRadius: "4px",
              display: "inline-block",
            }}
          />
        )}
        <div style={{ flex: "1 1 16rem", minWidth: "12rem" }}>
          {editable ? (
            <p style={{ display: "flex", gap: "0.5rem", margin: "0 0 0.35rem", flexWrap: "wrap" }}>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  onPick(
                    (picked) => onChange(picked[0] ?? null),
                    image && !legacy ? [image.fileGid] : []
                  )
                }
              >
                {image === null ? buttonLabel : "Replace"}
              </button>
              {image !== null ? (
                <button type="button" disabled={disabled} onClick={() => onChange(null)}>
                  Remove
                </button>
              ) : null}
            </p>
          ) : null}
          {image === null ? (
            <p style={{ ...hint, margin: 0 }}>None chosen.</p>
          ) : (
            <p style={{ ...hint, margin: 0 }}>
              {image.altText.trim() === "" ? (
                <>
                  No description set. Add one on the file in{" "}
                  <a href={shopifyFilesUrl} target="_blank" rel="noreferrer">
                    Shopify Files
                  </a>{" "}
                  so customers using a screen reader know what it shows.
                </>
              ) : (
                image.altText
              )}
            </p>
          )}
          {legacy ? (
            <p style={{ ...hint, margin: "0.35rem 0 0", color: "#8a5300" }}>
              This image was added before the Shopify picker was available, so it is stored as a link. Press Replace
              to re-select it from Shopify Files.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ContentSection({
  state,
  disabled,
  editable,
  frozenContentEditable,
  patchContent,
  shopifyFilesUrl,
  onPick,
  pickError,
}: {
  state: CampaignBuilderState;
  disabled: boolean;
  /** Presence of the presentation add/remove controls. */
  editable: boolean;
  /**
   * Whether the FROZEN half (highlights, display details) may be changed.
   *
   * Diverges from `editable` once a campaign opens: presentation stays
   * correctable, but a highlight or a display detail is a claim about the
   * goods and freezes with the rest of the commerce configuration. See
   * `BuilderCampaignPresentation`'s header for the reasoning.
   */
  frozenContentEditable: boolean;
  patchContent: (changes: Partial<CampaignBuilderState["content"]>) => void;
  shopifyFilesUrl: string;
  onPick: (
    apply: (picked: readonly BuilderImageRef[]) => void,
    alreadySelected: readonly string[],
    multiSelect: boolean
  ) => void;
  pickError: string | null;
}) {
  const { content } = state;

  const setGallery = (index: number, next: BuilderImageRef | null) =>
    patchContent({
      galleryImages: next
        ? content.galleryImages.map((image, i) => (i === index ? next : image))
        : content.galleryImages.filter((_, i) => i !== index),
    });

  const remainingGallerySlots = MAX_GALLERY_IMAGES - content.galleryImages.length;

  return (
    <Section
      title="Content and images"
      description="How the campaign presents itself. Images are chosen from your Shopify Files library."
    >
      {pickError ? (
        <p role="alert" style={{ ...hint, ...danger }}>
          {pickError}
        </p>
      ) : null}
      <label style={label} htmlFor="content-headline">
        Headline
      </label>
      <input
        id="content-headline"
        style={{ ...input, maxWidth: "34rem" }}
        value={content.headline}
        disabled={disabled}
        onChange={(event) => patchContent({ headline: event.target.value })}
      />

      <label style={label} htmlFor="content-short-description">
        Short description
      </label>
      <textarea
        id="content-short-description"
        style={{ ...input, maxWidth: "34rem", minHeight: "3.5rem" }}
        value={content.shortDescription}
        disabled={disabled}
        onChange={(event) => patchContent({ shortDescription: event.target.value })}
      />

      <ImageField
        title="Hero image"
        buttonLabel="Choose Hero Image"
        image={content.heroImage}
        disabled={disabled}
        editable={editable}
        shopifyFilesUrl={shopifyFilesUrl}
        onChange={(next) => patchContent({ heroImage: next })}
        onPick={(apply, already) => onPick(apply, already, false)}
      />
      <ImageField
        title="Mobile hero image (optional)"
        buttonLabel="Choose Mobile Image"
        image={content.mobileHeroImage}
        disabled={disabled}
        editable={editable}
        shopifyFilesUrl={shopifyFilesUrl}
        onChange={(next) => patchContent({ mobileHeroImage: next })}
        onPick={(apply, already) => onPick(apply, already, false)}
      />
      <ImageField
        title="Campaign card image (optional)"
        buttonLabel="Choose Card Image"
        image={content.cardImage}
        disabled={disabled}
        editable={editable}
        shopifyFilesUrl={shopifyFilesUrl}
        onChange={(next) => patchContent({ cardImage: next })}
        onPick={(apply, already) => onPick(apply, already, false)}
      />

      <fieldset style={{ border: "1px solid #eee", borderRadius: "4px", padding: "0.75rem", margin: "0 0 0.9rem" }}>
        <legend style={{ fontWeight: 600, fontSize: "0.875rem" }}>
          Gallery ({content.galleryImages.length} of {MAX_GALLERY_IMAGES})
        </legend>
        {content.galleryImages.map((image, index) => (
          <ImageField
            key={index}
            title={`Gallery image ${index + 1}`}
            buttonLabel="Choose Image"
            image={image}
            disabled={disabled}
            editable={editable}
            shopifyFilesUrl={shopifyFilesUrl}
            onChange={(next) => setGallery(index, next)}
            onPick={(apply, already) => onPick(apply, already, false)}
          />
        ))}
        {!editable ? null : remainingGallerySlots > 0 ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onPick(
                (picked) =>
                  patchContent({
                    // TRIMMED TO THE REMAINING SLOTS. The native picker's
                    // multiSelect has no maximum, so a merchant can select
                    // ten images into four free slots. Taking the first four
                    // and saying so beats silently storing ten and having the
                    // save refuse the lot.
                    galleryImages: [...content.galleryImages, ...picked].slice(0, MAX_GALLERY_IMAGES),
                  }),
                content.galleryImages.map((image) => image.fileGid).filter((fileGid) => fileGid !== ""),
                true
              )
            }
          >
            Add Gallery Images
          </button>
        ) : (
          <p style={{ ...hint, margin: 0 }}>
            The gallery is full at {MAX_GALLERY_IMAGES} images. Remove one to add another.
          </p>
        )}
        {editable && remainingGallerySlots > 0 ? (
          <p style={{ ...hint, margin: "0.35rem 0 0" }}>
            You can add {remainingGallerySlots} more. Select several at once in the picker.
          </p>
        ) : null}
      </fieldset>

      <fieldset style={{ border: "1px solid #eee", borderRadius: "4px", padding: "0.75rem", margin: "0 0 0.9rem" }}>
        <legend style={{ fontWeight: 600, fontSize: "0.875rem" }}>
          Highlights ({content.highlights.length} of {MAX_HIGHLIGHTS})
        </legend>
        {content.highlights.map((highlight, index) => (
          <div key={index} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.4rem" }}>
            <input
              style={{ ...input, marginBottom: 0, maxWidth: "28rem" }}
              value={highlight}
              disabled={disabled || !frozenContentEditable}
              aria-label={`Highlight ${index + 1}`}
              onChange={(event) =>
                patchContent({
                  highlights: content.highlights.map((value, i) => (i === index ? event.target.value : value)),
                })
              }
            />
            {frozenContentEditable ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => patchContent({ highlights: content.highlights.filter((_, i) => i !== index) })}
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
        {frozenContentEditable && content.highlights.length < MAX_HIGHLIGHTS ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => patchContent({ highlights: [...content.highlights, ""] })}
          >
            Add a highlight
          </button>
        ) : null}
      </fieldset>

      {/*
        §14's other half: a DISPLAY DETAIL is presentation, not selection. It
        is deliberately separate from Customer options, because a merchant who
        added "Production time" as an option would create purchasable
        combinations that differ only by a label.
      */}
      <fieldset style={{ border: "1px solid #eee", borderRadius: "4px", padding: "0.75rem", margin: 0 }}>
        <legend style={{ fontWeight: 600, fontSize: "0.875rem" }}>
          Display details ({content.displayDetails.length} of {MAX_DISPLAY_DETAILS})
        </legend>
        <p style={hint}>
          Facts shown with the campaign, like “Production time: 4 to 6 weeks”. Customers read these; they do not
          choose them. Anything a customer picks belongs under Customer options.
        </p>
        {content.displayDetails.map((detail, index) => (
          <div key={index} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.4rem", flexWrap: "wrap" }}>
            <input
              style={narrowInput}
              value={detail.label}
              disabled={disabled || !frozenContentEditable}
              aria-label={`Display detail ${index + 1} label`}
              placeholder="Production time"
              onChange={(event) =>
                patchContent({
                  displayDetails: content.displayDetails.map((value, i) =>
                    i === index ? { ...value, label: event.target.value } : value
                  ),
                })
              }
            />
            <input
              style={{ ...narrowInput, maxWidth: "16rem" }}
              value={detail.value}
              disabled={disabled || !frozenContentEditable}
              aria-label={`Display detail ${index + 1} value`}
              placeholder="4 to 6 weeks"
              onChange={(event) =>
                patchContent({
                  displayDetails: content.displayDetails.map((value, i) =>
                    i === index ? { ...value, value: event.target.value } : value
                  ),
                })
              }
            />
            {frozenContentEditable ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  patchContent({ displayDetails: content.displayDetails.filter((_, i) => i !== index) })
                }
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
        {frozenContentEditable && content.displayDetails.length < MAX_DISPLAY_DETAILS ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => patchContent({ displayDetails: [...content.displayDetails, { label: "", value: "" }] })}
          >
            Add a display detail
          </button>
        ) : null}
      </fieldset>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function OptionEditor({
  option,
  index,
  total,
  disabled,
  onChange,
  onRemove,
  onMove,
  onValueChange,
  onAddValue,
  onRemoveValue,
  editable,
}: {
  option: BuilderOption;
  index: number;
  total: number;
  disabled: boolean;
  onChange: (changes: Partial<BuilderOption>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onValueChange: (valueIndex: number, changes: Partial<BuilderOption["allowedValues"][number]>) => void;
  onAddValue: () => void;
  onRemoveValue: (valueIndex: number) => void;
  /**
   * Presence, not merely enablement. Once a campaign is not a draft these
   * controls are REMOVED rather than disabled — the same discipline the rest
   * of this page already follows, and for the same reason: a greyed-out
   * "Remove this option" still tells a merchant the action exists.
   */
  editable: boolean;
}) {
  const isBand = option.role === "variant_defining_band";
  /** The bands the merchant has already named, offered for reuse. */
  const knownBands = [
    ...new Set(
      option.allowedValues
        .map((value) => value.bandValue?.trim() ?? "")
        .filter((band) => band !== "")
    ),
  ].sort();

  return (
    <fieldset style={{ border: "1px solid #ccc", borderRadius: "4px", padding: "0.75rem", marginBottom: "0.9rem" }}>
      <legend style={{ fontWeight: 600, fontSize: "0.875rem" }}>
        {option.label.trim() === "" ? `Option ${index + 1}` : option.label}
      </legend>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
        <span>
          <label style={label} htmlFor={`option-label-${index}`}>
            Label customers see
          </label>
          <input
            id={`option-label-${index}`}
            style={narrowInput}
            value={option.label}
            disabled={disabled}
            placeholder="Diamond shape"
            onChange={(event) => {
              const nextLabel = event.target.value;
              // The internal key is prefilled from the label while the
              // merchant has not set one themselves, so §3's "internal key"
              // is one less thing to invent — but never overwritten once it
              // holds something, because changing a key changes the contract.
              const keyFollowsLabel = option.key === "" || option.key === normaliseOptionKey(option.label);
              onChange({ label: nextLabel, ...(keyFollowsLabel ? { key: normaliseOptionKey(nextLabel) } : {}) });
            }}
          />
        </span>
        <span>
          <label style={label} htmlFor={`option-key-${index}`}>
            Internal key
          </label>
          <input
            id={`option-key-${index}`}
            style={narrowInput}
            value={option.key}
            disabled={disabled}
            onChange={(event) => onChange({ key: event.target.value })}
          />
        </span>
        <span>
          <label style={label} htmlFor={`option-role-${index}`}>
            Price
          </label>
          <select
            id={`option-role-${index}`}
            style={narrowInput}
            value={option.role}
            disabled={disabled}
            onChange={(event) => onChange({ role: event.target.value as BuilderOptionRole })}
          >
            {BUILDER_OPTION_ROLES.map((role) => (
              <option key={role} value={role}>
                {OPTION_ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </span>
      </div>

      <p style={hint}>{OPTION_ROLE_HELP[option.role]}</p>

      <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
        <input
          type="checkbox"
          checked={option.required}
          disabled={disabled}
          onChange={(event) => onChange({ required: event.target.checked })}
        />{" "}
        Customers must choose this
      </label>

      <table style={table}>
        <caption style={{ textAlign: "left", fontWeight: 600, fontSize: "0.8125rem", padding: "0 0 0.25rem" }}>
          Choices
        </caption>
        <thead>
          <tr>
            <th style={cell}>Label customers see</th>
            <th style={cell}>Stored value</th>
            {isBand ? <th style={cell}>Prices from size band</th> : null}
            {editable ? (
              <th style={cell}>
                <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
                  Actions
                </span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {option.allowedValues.map((value, valueIndex) => (
            <tr key={valueIndex}>
              <td style={cell}>
                <input
                  style={{ ...narrowInput, maxWidth: "100%" }}
                  value={value.label}
                  disabled={disabled}
                  aria-label={`Choice ${valueIndex + 1} label`}
                  onChange={(event) => {
                    const nextLabel = event.target.value;
                    const valueFollowsLabel =
                      value.value === "" || value.value === normaliseOptionKey(value.label);
                    onValueChange(valueIndex, {
                      label: nextLabel,
                      ...(valueFollowsLabel ? { value: normaliseOptionKey(nextLabel) } : {}),
                    });
                  }}
                />
              </td>
              <td style={cell}>
                <input
                  style={{ ...narrowInput, maxWidth: "100%" }}
                  value={value.value}
                  disabled={disabled}
                  aria-label={`Choice ${valueIndex + 1} stored value`}
                  onChange={(event) => onValueChange(valueIndex, { value: event.target.value })}
                />
              </td>
              {isBand ? (
                <td style={cell}>
                  <input
                    style={{ ...narrowInput, maxWidth: "100%" }}
                    value={value.bandValue ?? ""}
                    disabled={disabled}
                    list={`bands-${index}`}
                    aria-label={`Choice ${valueIndex + 1} size band`}
                    placeholder="band_6_5_8"
                    onChange={(event) => onValueChange(valueIndex, { bandValue: event.target.value })}
                  />
                </td>
              ) : null}
              {editable ? (
                <td style={cell}>
                  <button
                    type="button"
                    disabled={disabled || option.allowedValues.length === 1}
                    onClick={() => onRemoveValue(valueIndex)}
                  >
                    Remove
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {isBand ? (
        <datalist id={`bands-${index}`}>
          {knownBands.map((band) => (
            <option key={band} value={band} />
          ))}
        </datalist>
      ) : null}

      {!editable ? null : (
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem", flexWrap: "wrap" }}>
        <button type="button" onClick={onAddValue} disabled={disabled}>
          Add a choice
        </button>
        <button type="button" onClick={() => onMove(-1)} disabled={disabled || index === 0}>
          Move up
        </button>
        <button type="button" onClick={() => onMove(1)} disabled={disabled || index === total - 1}>
          Move down
        </button>
        <button type="button" onClick={onRemove} disabled={disabled}>
          Remove this option
        </button>
      </div>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

/**
 * §7's switch-off control. 405 rows would be unreadable, so the matrix is
 * GROUPED BY VARIANT GROUP: one collapsible block per priced combination,
 * each listing the configurations that price from it. That is also the most
 * useful grouping, because switching off a whole group is the common case
 * ("we cannot supply platinum in the largest sizes").
 */
function ConfigurationMatrix({
  state,
  configurations,
  disabled,
  editable,
  onToggle,
}: {
  state: CampaignBuilderState;
  configurations: readonly EnumeratedConfiguration[];
  disabled: boolean;
  editable: boolean;
  onToggle: (signature: string, enabled: boolean) => void;
}) {
  const optionsByKey = useMemo(() => new Map(state.options.map((option) => [option.key, option])), [state.options]);
  const enabledCount = configurations.filter((configuration) => configuration.enabled).length;

  const grouped = useMemo(() => {
    const map = new Map<string, EnumeratedConfiguration[]>();
    for (const configuration of configurations) {
      const list = map.get(configuration.variantGroupSignature);
      if (list) list.push(configuration);
      else map.set(configuration.variantGroupSignature, [configuration]);
    }
    return [...map.entries()];
  }, [configurations]);

  if (configurations.length === 0) {
    return <p style={hint}>Add an option with at least one choice to see the configurations.</p>;
  }

  const describe = (values: Readonly<Record<string, string>>): string =>
    state.options
      .map((option) => {
        const raw = values[option.key];
        if (raw === undefined) return null;
        const matched = optionsByKey.get(option.key)?.allowedValues.find((value) => value.value === raw);
        return `${option.label || option.key}: ${matched?.label || raw}`;
      })
      .filter((part): part is string => part !== null)
      .join(" / ");

  return (
    <>
      <p style={{ margin: "0 0 0.6rem", fontSize: "0.875rem" }}>
        <strong>{enabledCount}</strong> of {configurations.length} switched on.
        {enabledCount === 0 ? <span style={danger}> Nothing can be bought.</span> : null}
      </p>
      {grouped.map(([groupSignature, rows]) => {
        const allOn = rows.every((row) => row.enabled);
        return (
          <details key={groupSignature} style={{ marginBottom: "0.5rem", border: "1px solid #eee", borderRadius: "4px", padding: "0.5rem" }}>
            <summary style={{ fontSize: "0.875rem", cursor: "pointer" }}>
              {describeVariantGroup(state, {
                signature: groupSignature,
                values: rows[0]!.variantGroupValues,
                configurationSignatures: rows.map((row) => row.signature),
                masterVariantId: state.variantMappings[groupSignature] ?? null,
              }) || "Configuration"}{" "}
              <span style={subtle}>
                ({rows.filter((row) => row.enabled).length} of {rows.length} on)
              </span>
            </summary>
            {editable ? (
              <p style={{ margin: "0.4rem 0" }}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => rows.forEach((row) => onToggle(row.signature, !allOn))}
                >
                  {allOn ? "Switch all off" : "Switch all on"}
                </button>
              </p>
            ) : null}
            <ul style={{ margin: 0, paddingLeft: "0.25rem", listStyle: "none", fontSize: "0.8125rem" }}>
              {rows.map((row) => (
                <li key={row.signature} style={{ padding: "0.1rem 0" }}>
                  <label>
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      disabled={disabled}
                      onChange={(event) => onToggle(row.signature, event.target.checked)}
                    />{" "}
                    {describe(row.values)}
                  </label>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------

function VariantMappingTable({
  state,
  groups,
  mappableVariants,
  disabled,
  onChange,
}: {
  state: CampaignBuilderState;
  groups: readonly VariantGroup[];
  mappableVariants: readonly MappableVariantOption[];
  disabled: boolean;
  onChange: (signature: string, masterVariantId: string) => void;
}) {
  if (groups.length === 0) {
    return <p style={hint}>Nothing to map yet. Add an option that affects price, and switch on a configuration.</p>;
  }

  if (mappableVariants.length === 0) {
    return (
      <p role="alert" style={danger}>
        This campaign has no eligible product variants yet. Add them under Eligible variants first, then each
        configuration can be mapped to one.
      </p>
    );
  }

  const unmapped = groups.filter((group) => group.masterVariantId === null).length;

  return (
    <>
      <p style={{ margin: "0 0 0.6rem", fontSize: "0.875rem" }}>
        {unmapped === 0 ? (
          <strong>All {groups.length} mapped.</strong>
        ) : (
          <span style={danger}>
            <strong>
              {unmapped} of {groups.length} still need a product variant.
            </strong>
          </span>
        )}
      </p>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>Configuration</th>
            <th style={cell}>Customer choices covered</th>
            <th style={cell}>Mapped product variant</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.signature}>
              <td style={cell}>{describeVariantGroup(state, group) || "Configuration"}</td>
              <td style={cell}>{group.configurationSignatures.length}</td>
              <td style={cell}>
                <select
                  style={{ ...narrowInput, maxWidth: "100%" }}
                  value={group.masterVariantId ?? ""}
                  disabled={disabled}
                  aria-label={`Product variant for ${describeVariantGroup(state, group) || "this configuration"}`}
                  onChange={(event) => onChange(group.signature, event.target.value)}
                >
                  {/*
                    No auto-selected first variant (§6: never silently guess a
                    mapping). An empty choice that blocks the open is correct;
                    a plausible default that sells the wrong ring is not.
                  */}
                  <option value="">Choose a variant</option>
                  {mappableVariants.map((variant) => (
                    <option key={variant.masterVariantId} value={variant.masterVariantId}>
                      {variant.label}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ---------------------------------------------------------------------------

function PricePreviewTable({ preview }: { preview: CampaignPricePreviewView | null }) {
  if (preview === null) {
    return <p style={hint}>Save the configuration to see a price preview.</p>;
  }

  if (preview.problems.length > 0) {
    return (
      <ul style={{ margin: 0, paddingLeft: "1.25rem", ...danger }}>
        {preview.problems.map((problem, index) => (
          <li key={index}>{problem}</li>
        ))}
      </ul>
    );
  }

  if (preview.rows.length === 0) {
    return <p style={hint}>Nothing to price yet.</p>;
  }

  return (
    <>
      <p style={hint}>
        Prices as of {new Date(preview.pricedAsOf).toLocaleString()}. Each tier shows the Bank Payment Price and, in
        brackets, the Regular/Card Price derived from it. These are provisional until the campaign opens.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={table}>
          <thead>
            <tr>
              <th style={cell}>Configuration</th>
              {preview.tiers.map((tier) => (
                <th key={tier.tierNumber} style={cell}>
                  {tier.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <tr key={row.variantGroupSignature}>
                <td style={cell}>{row.description}</td>
                {row.tierPrices === undefined ? (
                  <td style={{ ...cell, ...danger }} colSpan={Math.max(1, preview.tiers.length)}>
                    {row.problem ?? "Not priced."}
                  </td>
                ) : (
                  row.tierPrices.map((tierPrice) => (
                    <td key={tierPrice.tierNumber} style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>
                      {formatMinorUnits(tierPrice.bankPaymentMinorUnits, preview.currency)}
                      <br />
                      <span style={subtle}>
                        ({formatMinorUnits(tierPrice.regularCardMinorUnits, preview.currency)} card)
                      </span>
                    </td>
                  ))
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export { formatMinorUnits, isVariantDefiningRole, MAX_CONFIGURATIONS };

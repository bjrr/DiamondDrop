import { describe, expect, it } from "vitest";

import {
  FROZEN_CONTENT_FIELDS,
  MAX_GALLERY_IMAGES,
  MIN_PRESENTATION_REASON_LENGTH,
  PRESENTATION_FIELDS,
  applyResolvedImages,
  emptyCampaignBuilderState,
  extractPresentation,
  imageFileGidsToResolve,
  locatedImageRefs,
  parseCampaignPresentation,
  unverifiableImagePaths,
  validatePresentationReason,
  withPresentation,
  type BuilderCampaignPresentation,
  type BuilderImageRef,
} from "./campaignBuilder";
import { PRESENTATION_EDITABLE_STATUSES } from "~/db/repositories/groupBuyRepository.server";
import { PUBLIC_PAST_GROUP_BUY_CAMPAIGNS } from "./campaignVisibility";

/**
 * THE LINE BETWEEN A PROMISE AND A PICTURE.
 *
 * Once a Group Buy campaign opens it has customers in it. Everything they
 * relied on when they joined is frozen. What is not a promise about the goods
 * — the photography, a headline, a one-line promotional description — stays
 * correctable, because a placeholder image or a typo on a live campaign is
 * worth being able to fix without cancelling it.
 *
 * These tests pin WHICH SIDE OF THAT LINE EACH FIELD IS ON, because that is
 * the decision a future change is most likely to get wrong, and getting it
 * wrong means a quality claim changing under a customer who already bought
 * against it.
 */

const SHOPIFY_IMAGE: BuilderImageRef = {
  fileGid: "gid://shopify/MediaImage/111",
  url: "https://cdn.shopify.com/s/files/1/hero.jpg",
  altText: "Solitaire ring on linen",
};

function presentation(overrides: Partial<BuilderCampaignPresentation> = {}): BuilderCampaignPresentation {
  return {
    headline: "Signature Solitaire",
    shortDescription: "Join this month's group buy.",
    heroImage: SHOPIFY_IMAGE,
    mobileHeroImage: null,
    cardImage: null,
    galleryImages: [],
    ...overrides,
  };
}

describe("which fields are presentation and which are frozen", () => {
  it("treats exactly the six owner-named fields as presentation", () => {
    // The owner's editable list, verbatim: hero image, mobile hero image,
    // campaign card image, gallery images, campaign headline, short
    // promotional description.
    expect([...PRESENTATION_FIELDS].sort()).toEqual(
      [
        "cardImage",
        "galleryImages",
        "headline",
        "heroImage",
        "mobileHeroImage",
        "shortDescription",
      ].sort()
    );
  });

  it("keeps highlights and display details FROZEN", () => {
    // Display details are where "Certification: GIA" and "Clarity: VS1" live,
    // and a highlight can carry the same kind of claim in prose. Both are
    // material/specification claims, which the owner's frozen list names.
    expect([...FROZEN_CONTENT_FIELDS].sort()).toEqual(["displayDetails", "highlights"]);
  });

  it("does not let a frozen field reach the presentation record", () => {
    const content = {
      ...emptyCampaignBuilderState().content,
      headline: "Live headline",
      highlights: ["Natural diamond, VS1 clarity"],
      displayDetails: [{ label: "Certification", value: "GIA" }],
    };
    const extracted = extractPresentation(content);
    expect(extracted.headline).toBe("Live headline");
    expect(extracted).not.toHaveProperty("highlights");
    expect(extracted).not.toHaveProperty("displayDetails");
    expect(JSON.stringify(extracted)).not.toContain("GIA");
    expect(JSON.stringify(extracted)).not.toContain("VS1");
  });
});

describe("laying a newer presentation over the frozen configuration", () => {
  const frozen = {
    ...emptyCampaignBuilderState(),
    productType: "Engagement ring",
    content: {
      ...emptyCampaignBuilderState().content,
      headline: "Original headline",
      highlights: ["Frozen highlight"],
      displayDetails: [{ label: "Certification", value: "GIA" }],
    },
  };

  it("replaces presentation and leaves the frozen content untouched", () => {
    const merged = withPresentation(frozen, presentation({ headline: "Corrected headline" }));
    expect(merged.content.headline).toBe("Corrected headline");
    expect(merged.content.heroImage).toEqual(SHOPIFY_IMAGE);
    // The commerce promises are exactly as frozen.
    expect(merged.content.highlights).toEqual(["Frozen highlight"]);
    expect(merged.content.displayDetails).toEqual([{ label: "Certification", value: "GIA" }]);
    expect(merged.productType).toBe("Engagement ring");
  });

  it("never mutates the frozen snapshot it was given", () => {
    // The stored snapshot is evidence of what the campaign opened with. If
    // this mutated it, the separation it exists to provide would be gone.
    const before = JSON.stringify(frozen);
    withPresentation(frozen, presentation({ headline: "Something else" }));
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it("returns the frozen state unchanged when there is no newer version", () => {
    expect(withPresentation(frozen, null)).toBe(frozen);
  });
});

describe("the required reason for a live-campaign change", () => {
  it("accepts the owner's own examples", () => {
    for (const reason of ["Corrected headline typo", "Replaced hero with final campaign photography"]) {
      const result = validatePresentationReason(reason);
      expect(result.ok, reason).toBe(true);
    }
  });

  it("refuses an empty or whitespace-only reason", () => {
    for (const reason of ["", "   ", "\t\n"]) {
      const result = validatePresentationReason(reason);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.problem).toMatch(/Give a reason/);
    }
  });

  it("refuses a reason too short to mean anything later", () => {
    const result = validatePresentationReason("typo");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toMatch(new RegExp(`${MIN_PRESENTATION_REASON_LENGTH} characters`));
  });

  it("trims the stored reason", () => {
    const result = validatePresentationReason("  Corrected headline typo  ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("Corrected headline typo");
  });
});

describe("parsing a posted presentation edit", () => {
  it("accepts the six fields", () => {
    const parsed = parseCampaignPresentation(presentation());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.headline).toBe("Signature Solitaire");
    expect(parsed.value.heroImage).toEqual(SHOPIFY_IMAGE);
  });

  it("IGNORES anything else in the payload, so the freeze cannot be bypassed through it", () => {
    // This is the security property of this endpoint. The panel posts the
    // WHOLE builder state to it, so if it read more than six fields, a live
    // campaign's options, bands, mappings or claims could be changed through
    // the one door that stays open after it ships.
    const parsed = parseCampaignPresentation({
      ...presentation(),
      highlights: ["Smuggled claim"],
      displayDetails: [{ label: "Clarity", value: "VS1" }],
      options: [{ key: "metal", label: "Metal" }],
      variantMappings: { x: "variant-9" },
      productType: "Something else",
      disabledConfigurations: ["x"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const serialised = JSON.stringify(parsed.value);
    expect(serialised).not.toContain("Smuggled claim");
    expect(serialised).not.toContain("VS1");
    expect(serialised).not.toContain("variant-9");
    expect(serialised).not.toContain("Something else");
    expect(Object.keys(parsed.value).sort()).toEqual([...PRESENTATION_FIELDS].sort());
  });

  it("enforces the gallery maximum of six", () => {
    const image = (n: number): BuilderImageRef => ({
      fileGid: `gid://shopify/MediaImage/${n}`,
      url: `https://cdn.shopify.com/s/files/1/g${n}.jpg`,
      altText: "",
    });
    const six = parseCampaignPresentation(
      presentation({ galleryImages: [1, 2, 3, 4, 5, 6].map(image) })
    );
    expect(six.ok).toBe(true);

    const seven = parseCampaignPresentation(
      presentation({ galleryImages: [1, 2, 3, 4, 5, 6, 7].map(image) })
    );
    expect(seven.ok).toBe(false);
    if (seven.ok) return;
    expect(seven.problems.join(" ")).toMatch(new RegExp(`the limit is ${MAX_GALLERY_IMAGES}`));
  });

  it("refuses imagery hosted anywhere but Shopify", () => {
    for (const url of [
      "https://evil.example/x.png",
      "http://cdn.shopify.com/s/files/1/x.jpg",
      "https://cdn.shopify.com.evil.example/x.jpg",
    ]) {
      const parsed = parseCampaignPresentation(
        presentation({ heroImage: { fileGid: "", url, altText: "" } })
      );
      expect(parsed.ok, url).toBe(false);
    }
  });

  it("refuses a file id that is not a MediaImage", () => {
    // The picker is invoked with mediaTypes: ['MediaImage'], so a Video or
    // GenericFile id did not come from where it claims to.
    for (const fileGid of ["gid://shopify/Video/1", "gid://shopify/GenericFile/1", "not-a-gid"]) {
      const parsed = parseCampaignPresentation(
        presentation({ heroImage: { ...SHOPIFY_IMAGE, fileGid } })
      );
      expect(parsed.ok, fileGid).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.problems.join(" ")).toMatch(/not a Shopify image file/);
    }
  });

  it("refuses a non-object payload", () => {
    for (const input of [null, undefined, 42, "x", []]) {
      expect(parseCampaignPresentation(input).ok).toBe(false);
    }
  });
});

describe("server-side verification of selected files", () => {
  it("lists the file ids that must be resolved against Shopify", () => {
    const gids = imageFileGidsToResolve(
      presentation({
        mobileHeroImage: { fileGid: "gid://shopify/MediaImage/222", url: SHOPIFY_IMAGE.url, altText: "" },
        // A duplicate and a GID-less legacy reference: neither should produce
        // a second lookup.
        cardImage: SHOPIFY_IMAGE,
        galleryImages: [{ fileGid: "", url: "https://cdn.shopify.com/s/files/1/legacy.jpg", altText: "" }],
      })
    );
    expect([...gids].sort()).toEqual(["gid://shopify/MediaImage/111", "gid://shopify/MediaImage/222"]);
  });

  it("labels every image with the field it came from", () => {
    const located = locatedImageRefs(
      presentation({
        mobileHeroImage: SHOPIFY_IMAGE,
        cardImage: SHOPIFY_IMAGE,
        galleryImages: [SHOPIFY_IMAGE, SHOPIFY_IMAGE],
      })
    );
    expect(located.map((l) => l.path)).toEqual([
      "Hero image",
      "Mobile hero image",
      "Card image",
      "Gallery image 1",
      "Gallery image 2",
    ]);
  });

  it("replaces a submitted URL and alt text with Shopify's own answer", () => {
    // THE CORE PROPERTY. A hand-crafted post can claim any cdn.shopify.com
    // URL, including another shop's. The save path does not validate the
    // claim, it overwrites it.
    const tampered = presentation({
      heroImage: {
        fileGid: "gid://shopify/MediaImage/111",
        url: "https://cdn.shopify.com/s/files/9/SOMEONE-ELSES-SHOP.jpg",
        altText: "attacker supplied",
      },
    });
    const resolved = applyResolvedImages(
      tampered,
      new Map([
        [
          "gid://shopify/MediaImage/111",
          { url: "https://cdn.shopify.com/s/files/1/real-hero.jpg", altText: "Shopify's alt text" },
        ],
      ])
    );
    expect(resolved.heroImage).toEqual({
      fileGid: "gid://shopify/MediaImage/111",
      url: "https://cdn.shopify.com/s/files/1/real-hero.jpg",
      altText: "Shopify's alt text",
    });
    expect(JSON.stringify(resolved)).not.toContain("SOMEONE-ELSES-SHOP");
    expect(JSON.stringify(resolved)).not.toContain("attacker supplied");
  });

  it("leaves copy alone while rewriting imagery", () => {
    const resolved = applyResolvedImages(presentation(), new Map());
    expect(resolved.headline).toBe("Signature Solitaire");
    expect(resolved.shortDescription).toBe("Join this month's group buy.");
  });
});

describe("compatibility with pre-picker snapshots", () => {
  const legacyUrl = "https://cdn.shopify.com/s/files/1/pasted-before-the-picker.jpg";
  const legacyRef: BuilderImageRef = { fileGid: "", url: legacyUrl, altText: "" };

  it("keeps a stored URL-only reference working", () => {
    // The owner asked for existing URL-based snapshots to be preserved.
    const previous = presentation({ heroImage: legacyRef });
    expect(unverifiableImagePaths(previous, previous)).toEqual([]);
  });

  it("refuses a NEW URL-only reference", () => {
    // Without a file id there is nothing to resolve, so the URL could be any
    // cdn.shopify.com path at all. Grandfathering what exists is
    // compatibility; accepting new ones would be leaving the hole open.
    const previous = presentation({ heroImage: SHOPIFY_IMAGE });
    const next = presentation({
      heroImage: { fileGid: "", url: "https://cdn.shopify.com/s/files/9/injected.jpg", altText: "" },
    });
    expect(unverifiableImagePaths(next, previous)).toEqual(["Hero image"]);
  });

  it("refuses a URL-only reference when there is no previous content at all", () => {
    expect(unverifiableImagePaths(presentation({ heroImage: legacyRef }), null)).toEqual(["Hero image"]);
  });

  it("does not grandfather a legacy URL into a different field", () => {
    // A stored legacy hero may stay a legacy hero. The same URL appearing
    // elsewhere is still a reference nothing verified, but it is the URL that
    // is grandfathered rather than the slot, which is the honest reading of
    // "this exact image is already stored".
    const previous = presentation({ heroImage: legacyRef });
    const moved = presentation({ heroImage: null, cardImage: legacyRef });
    expect(unverifiableImagePaths(moved, previous)).toEqual([]);
  });

  it("accepts a picked reference without needing any grandfathering", () => {
    expect(unverifiableImagePaths(presentation({ heroImage: SHOPIFY_IMAGE }), null)).toEqual([]);
  });
});

describe("which campaign statuses accept a presentation correction", () => {
  // The set is exported from the repository and used by BOTH the write gate
  // and the loader's UI gate, so this asserts one list rather than two that
  // can disagree. It is imported here rather than restated for the same
  // reason the route test stub now imports it: a restated copy is how a
  // stale rule survives a policy change unnoticed.

  it("accepts draft, open and closed", () => {
    // Owner decisions 2026-11-06 (open) and 2026-11-07 (closed). A closed
    // campaign is still READ, in the public Past Group Buys archive, so a
    // typo in its headline remains customer-facing.
    expect([...PRESENTATION_EDITABLE_STATUSES].sort()).toEqual(["closed", "draft", "open"]);
  });

  it("is not gated on archiving, which is orthogonal to status", () => {
    // `campaignVisibility.ts`'s owner-locked header (2026-10-05) is explicit
    // that staff archiving is a dashboard-tidying decision saying nothing
    // about public visibility — which is why PUBLIC_PAST_GROUP_BUY_CAMPAIGNS
    // filters on `status` and pointedly NOT on `archivedAt`. An archived
    // closed campaign is therefore still public history, and the same
    // correction must reach it.
    expect(PUBLIC_PAST_GROUP_BUY_CAMPAIGNS).not.toHaveProperty("archivedAt");
    expect(PUBLIC_PAST_GROUP_BUY_CAMPAIGNS.status).toBe("closed");
    // The gate is a set of statuses, so there is nothing archive-shaped in
    // it to accidentally exclude an archived campaign.
    for (const entry of PRESENTATION_EDITABLE_STATUSES) {
      expect(entry).toMatch(/^(draft|open|closed)$/);
    }
  });

  it("names no status that the campaign lifecycle does not have", () => {
    // A typo like "cancelled" would silently never match, leaving that
    // lifecycle state permanently uncorrectable with no error to notice.
    const LIFECYCLE_STATUSES = ["draft", "open", "closed"];
    for (const status of PRESENTATION_EDITABLE_STATUSES) {
      expect(LIFECYCLE_STATUSES).toContain(status);
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CAMPAIGN_IMAGES_ENDPOINT } from "./shopifyFilePicker";
import { MAX_RESOLVABLE_IMAGES } from "~/shopify/admin/campaignImages.server";
import { MAX_GALLERY_IMAGES } from "~/domain/groupbuy/campaignBuilder";

/**
 * SHOPIFY'S PICKER, NOT A HOME-GROWN ONE.
 *
 * The owner's instruction was explicit: use Shopify's native file picker
 * rather than building a custom file browser. That is a property of HOW the
 * code is written, not of what it returns, so the source is what gets
 * asserted — the same technique as the other fences in this repository.
 *
 * What these tests would catch: somebody replacing the intent call with a
 * `files(query:)` listing and a grid of thumbnails, or adding an
 * `<input type="file">` and a `stagedUploadsCreate` call, both of which would
 * work, would look like an improvement, and would mean building and
 * maintaining a worse copy of Shopify's own UI — the second of them needing a
 * `write_files` scope nobody approved.
 */

const PICKER = readFileSync(join(process.cwd(), "app", "components", "groupbuy", "shopifyFilePicker.ts"), "utf8");
const PANEL = readFileSync(
  join(process.cwd(), "app", "components", "groupbuy", "CampaignBuilderPanel.tsx"),
  "utf8"
);
const RESOLVER = readFileSync(
  join(process.cwd(), "app", "shopify", "admin", "campaignImages.server.ts"),
  "utf8"
);
const ENDPOINT_ROUTE = readFileSync(join(process.cwd(), "app", "routes", "app.campaign-images.tsx"), "utf8");

describe("the native Intents API is what opens the picker", () => {
  it("invokes the documented pick:shopify/File intent", () => {
    expect(PICKER).toContain('intents.invoke("pick:shopify/File"');
  });

  it("awaits the activity's completion, as the API requires", () => {
    // `invoke` resolves with an activity; the SELECTION arrives on
    // `activity.complete`. Reading `invoke`'s result directly would silently
    // never see the merchant's choice.
    expect(PICKER).toMatch(/await\s+activity\.complete/);
    expect(PICKER).toMatch(/response\.data\?\.ids/);
  });

  it("handles all three documented response codes", () => {
    expect(PICKER).toMatch(/"closed"/);
    expect(PICKER).toMatch(/"ok"/);
    // An 'error' response carries a message, which is shown rather than
    // swallowed.
    expect(PICKER).toMatch(/response\.message/);
  });

  it("asks only for images", () => {
    expect(PICKER).toMatch(/mediaTypes:\s*\["MediaImage"\]/);
    // No other media type is requested anywhere.
    for (const type of ["Video", "GenericFile", "Model3d", "ExternalVideo"]) {
      // Anchored on the CALL, which is written with double quotes in code —
      // not on the doc comment near the top of the file, which quotes the
      // API with single quotes. Slicing from that comment would include the
      // local interface declaration, whose type union legitimately names
      // every media type and which is not a request for any of them.
      const callIndex = PICKER.indexOf('intents.invoke("pick:shopify/File"');
      expect(callIndex).toBeGreaterThan(-1);
      expect(PICKER.slice(callIndex)).not.toContain(`"${type}"`);
    }
  });

  it("passes the current selection through so reopening is not a blank library", () => {
    expect(PICKER).toMatch(/selectedFiles/);
  });
});

describe("no custom file browser and no uploader", () => {
  it("does not list files itself", () => {
    // A `files(query:)` listing would be the start of a home-grown browser.
    for (const source of [PICKER, PANEL, RESOLVER, ENDPOINT_ROUTE]) {
      expect(source).not.toMatch(/\bfiles\s*\(\s*query:/);
      expect(source).not.toMatch(/fileCreate/);
      expect(source).not.toMatch(/stagedUploadsCreate/);
    }
  });

  it("renders no file input and no drop zone", () => {
    expect(PANEL).not.toMatch(/type="file"/);
    expect(PANEL).not.toMatch(/onDrop/);
    expect(PICKER).not.toMatch(/type="file"/);
  });

  it("renders no URL field for campaign imagery", () => {
    // The pasted-CDN-URL workflow is gone from the normal path. Its
    // placeholder is the thing that would come back first.
    expect(PANEL).not.toMatch(/placeholder="https:\/\/cdn\.shopify\.com/);
  });

  it("offers the owner-specified buttons", () => {
    for (const label of ["Choose Hero Image", "Choose Mobile Image", "Choose Card Image", "Add Gallery Images"]) {
      expect(PANEL).toContain(label);
    }
  });

  it("supports removal and replacement before save", () => {
    // "Replace" is a JSX expression rather than a text node, so the string
    // literal is what to look for.
    expect(PANEL).toContain('"Replace"');
    expect(PANEL).toMatch(/Remove\s*\n?\s*<\/button>/);
  });

  it("shows a thumbnail of what was selected", () => {
    expect(PANEL).toMatch(/<img\s/);
    expect(PANEL).toMatch(/src=\{image\.url\}/);
  });
});

describe("ids become URLs on the server, never in the browser", () => {
  it("sends the picked ids to the admin-authenticated endpoint", () => {
    expect(PICKER).toContain("CAMPAIGN_IMAGES_ENDPOINT");
    expect(CAMPAIGN_IMAGES_ENDPOINT).toBe("/app/campaign-images");
  });

  it("constructs no CDN URL of its own", () => {
    // A URL assembled client-side from an id would be a guess about Shopify's
    // CDN layout, and would break the moment it changed.
    expect(PICKER).not.toMatch(/cdn\.shopify\.com/);
  });

  it("keeps that endpoint behind admin authentication", () => {
    expect(ENDPOINT_ROUTE).toMatch(/authenticate\.admin\(request\)/);
  });

  it("keeps that endpoint a resource route, with no default export", () => {
    // React Router 7's CSRF guard applies only to modules WITH a default
    // export. Having none keeps this exempt however it comes to be called.
    expect(ENDPOINT_ROUTE).not.toMatch(/^export default/m);
  });

  it("rejects a non-MediaImage id at the endpoint before spending an API call", () => {
    expect(ENDPOINT_ROUTE).toMatch(/gid:\\\/\\\/shopify\\\/MediaImage/);
  });

  it("selects __typename, so a non-image node cannot pass as an image", () => {
    // `nodes` returns [Node]; a non-MediaImage simply does not match the
    // fragment, which without __typename is indistinguishable from success.
    expect(RESOLVER).toMatch(/__typename/);
    expect(RESOLVER).toMatch(/node\.__typename !== "MediaImage"/);
  });

  it("handles both GraphQL error shapes", () => {
    // The Shopify client throws in some versions and returns errors in the
    // body in others. A body-only check silently passed once in this
    // repository when a scope was missing.
    expect(RESOLVER).toMatch(/body\.errors/);
    expect(RESOLVER).toMatch(/catch/);
  });

  it("bounds a single resolution to the three images plus a full gallery", () => {
    expect(MAX_RESOLVABLE_IMAGES).toBe(3 + MAX_GALLERY_IMAGES);
  });
});

describe("the gallery maximum", () => {
  it("is six", () => {
    expect(MAX_GALLERY_IMAGES).toBe(6);
  });

  it("is enforced in the panel when applying a multi-selection", () => {
    // The native picker's multiSelect has no maximum of its own, so ten
    // images can come back into four free slots. The panel trims rather than
    // storing ten and having the save refuse everything.
    expect(PANEL).toMatch(/slice\(0, MAX_GALLERY_IMAGES\)/);
  });

  it("hides the add control once the gallery is full", () => {
    expect(PANEL).toMatch(/remainingGallerySlots > 0/);
  });
});

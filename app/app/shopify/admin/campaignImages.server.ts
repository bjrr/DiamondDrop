/**
 * Resolving Shopify file ids into renderable campaign imagery.
 *
 * ===========================================================================
 * WHY THIS EXISTS AT ALL
 * ===========================================================================
 * Shopify's native file picker is opened through the App Home Intents API:
 *
 *     const activity = await shopify.intents.invoke('pick:shopify/File', {
 *       data: { mediaTypes: ['MediaImage'], multiSelect: true },
 *     });
 *     const response = await activity.complete;
 *     // response.data.ids -> ['gid://shopify/MediaImage/123', ...]
 *
 * That is the whole payload. The intent returns an ARRAY OF IDS and nothing
 * else: no URL, no alt text, no media type, no dimensions. So an id is not
 * yet something a page can render, and it is not yet something that has been
 * confirmed to be an image, or to exist, or to belong to this shop.
 *
 * This module is the one place those ids become facts, by asking the Admin
 * API. It is also why `read_files` is requested, and why nothing more than
 * `read_files` is: resolving is a read.
 *
 * ===========================================================================
 * THE STORED URL IS SHOPIFY'S ANSWER, NOT THE BROWSER'S CLAIM
 * ===========================================================================
 * The builder posts its whole state back as JSON, which means a hand-crafted
 * post can contain any `cdn.shopify.com` URL at all — including one belonging
 * to a different shop. Validating the URL's shape cannot catch that.
 *
 * So the save path does not validate the submitted URL; it REPLACES it. Every
 * image reference carrying a file id is re-resolved here, and the URL and alt
 * text written to the campaign are the ones Shopify just reported for that
 * id. A tampered URL is not rejected so much as overwritten with the truth,
 * which is a stronger property than any pattern match.
 *
 * MEDIAIMAGE ONLY. The picker is invoked with `mediaTypes: ['MediaImage']`,
 * so a Video, Model3d or GenericFile id arriving at the save endpoint did not
 * come from where it claims to. Those are refused by name rather than
 * silently skipped: a campaign whose hero image quietly vanished because the
 * id was a video is worse than one that says so.
 */

import type { AdminGraphqlClient } from "./productClient.server";
import { logger } from "~/lib/logger.server";

/** What Shopify says about one file. The only shape stored against a campaign. */
export interface ResolvedCampaignImage {
  readonly fileGid: string;
  readonly url: string;
  readonly altText: string;
}

export type CampaignImageResolution =
  | { readonly ok: true; readonly byGid: ReadonlyMap<string, ResolvedCampaignImage> }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * `__typename` is selected deliberately. `nodes` returns `[Node]`, so a
 * non-image id does not error — it comes back as a node that simply does not
 * match the `MediaImage` fragment, which is indistinguishable from a
 * successful empty selection without it.
 *
 * `image { url }` rather than `preview`: the preview is a thumbnail Shopify
 * generates for the admin, and a campaign hero rendered from it would be the
 * wrong asset at the wrong resolution.
 */
const RESOLVE_IMAGES_QUERY = `#graphql
  query CaratForUsCampaignImages($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on MediaImage {
        id
        alt
        fileStatus
        image {
          url
          altText
        }
      }
    }
  }
`;

interface MediaImageNode {
  readonly __typename?: string;
  readonly id?: string;
  readonly alt?: string | null;
  readonly fileStatus?: string;
  readonly image?: { readonly url?: string; readonly altText?: string | null } | null;
}

/** At most this many ids in one call: three single images plus a six-image gallery. */
export const MAX_RESOLVABLE_IMAGES = 9;

/**
 * Resolves Shopify file ids to URLs and alt text.
 *
 * Returns problems rather than throwing, because every caller is a form
 * submission that needs to tell a merchant what went wrong. An empty id list
 * resolves to an empty map WITHOUT calling Shopify — a campaign with no
 * imagery is normal, and a needless API call on every save is not.
 */
export async function resolveCampaignImageRefs(
  admin: AdminGraphqlClient,
  fileGids: readonly string[]
): Promise<CampaignImageResolution> {
  if (fileGids.length === 0) return { ok: true, byGid: new Map() };

  if (fileGids.length > MAX_RESOLVABLE_IMAGES) {
    return {
      ok: false,
      problems: [`${fileGids.length} images were submitted; the limit is ${MAX_RESOLVABLE_IMAGES}.`],
    };
  }

  let nodes: readonly (MediaImageNode | null)[];
  try {
    const response = await admin.graphql(RESOLVE_IMAGES_QUERY, { variables: { ids: fileGids } });
    const body = (await response.json()) as {
      data?: { nodes?: readonly (MediaImageNode | null)[] };
      errors?: unknown;
    };
    // BOTH ERROR SHAPES. The Shopify client throws on GraphQL errors in some
    // versions and returns them in the body in others; a body-only check
    // silently passed once in this repository when a scope was missing, so
    // both are handled.
    if (body.errors) {
      logger.error("campaign_images.graphql_error", { shape: "body", idCount: fileGids.length });
      return {
        ok: false,
        problems: [
          "Shopify could not be asked about those images. If this app was recently updated, it may need the Files permission re-approved in Shopify.",
        ],
      };
    }
    nodes = body.data?.nodes ?? [];
  } catch {
    logger.error("campaign_images.graphql_error", { shape: "thrown", idCount: fileGids.length });
    return {
      ok: false,
      problems: [
        "Shopify could not be asked about those images. If this app was recently updated, it may need the Files permission re-approved in Shopify.",
      ],
    };
  }

  const byGid = new Map<string, ResolvedCampaignImage>();
  const problems: string[] = [];

  // `nodes` answers positionally, so an id with no node is matched by index
  // rather than by looking for an id the response does not contain.
  fileGids.forEach((fileGid, index) => {
    const node = nodes[index] ?? null;

    if (node === null) {
      problems.push("One of the selected images no longer exists in Shopify Files. Choose it again.");
      return;
    }
    if (node.__typename !== "MediaImage") {
      problems.push("One of the selected files is not an image. Campaign imagery must be an image file.");
      return;
    }
    const url = node.image?.url;
    if (typeof url !== "string" || url === "") {
      // A file still processing has no usable URL yet. Saying so is more use
      // than "something went wrong".
      problems.push(
        node.fileStatus === "PROCESSING"
          ? "One of the selected images is still being processed by Shopify. Try again in a moment."
          : "One of the selected images has no usable address in Shopify yet."
      );
      return;
    }

    byGid.set(fileGid, {
      fileGid,
      url,
      // Shopify holds alt text in two places; the file's own `alt` is what a
      // merchant edits in Files, so it wins, with the image's `altText` as a
      // fallback. Empty string rather than null: the stored shape is a
      // string, and "" is the honest representation of "not described".
      altText: node.alt ?? node.image?.altText ?? "",
    });
  });

  if (problems.length > 0) {
    // Deduplicated: nine gallery images that are all still processing should
    // produce one sentence, not nine identical ones.
    return { ok: false, problems: [...new Set(problems)] };
  }

  return { ok: true, byGid };
}

/**
 * Resolves Shopify file ids into renderable image references, for the Group
 * Buy campaign builder's native file picker.
 *
 * ===========================================================================
 * WHY A SEPARATE ENDPOINT
 * ===========================================================================
 * `shopify.intents.invoke('pick:shopify/File')` hands the browser an array of
 * ids and nothing more. To show the merchant a thumbnail of what they just
 * picked, the page needs a URL, and a URL can only come from the Admin API.
 * The browser cannot call the Admin API — it has no token and must never have
 * one — so it asks this route, which does.
 *
 * NOTHING IS PERSISTED HERE. This is a read used to paint the editor. The
 * authoritative resolution happens again on save, in the campaign route,
 * because what the browser was shown is not evidence of what the browser
 * later submits.
 *
 * A RESOURCE ROUTE, with no default export. That is deliberate and load-
 * bearing: React Router 7's CSRF guard only applies to route modules that
 * have one. This route is called same-origin from the embedded app's own
 * iframe, so it is not in the cross-origin families
 * `csrfResourceRouteFence.test.ts` polices, but having no default export
 * keeps it exempt regardless of how it ends up being called later.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "~/shopify.server";
import {
  MAX_RESOLVABLE_IMAGES,
  resolveCampaignImageRefs,
} from "~/shopify/admin/campaignImages.server";
import { logger } from "~/lib/logger.server";

/** GET is meaningless here, and a 405 says so rather than rendering nothing. */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return Response.json({ ok: false, problems: ["Method not allowed."] }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  // AUTHENTICATED STAFF ONLY. Resolving a file id reveals its CDN URL and alt
  // text, which is merchant data, so this is behind the same admin
  // authentication as every other route in this family.
  const { admin } = await authenticate.admin(request);

  if (request.method !== "POST") {
    return Response.json({ ok: false, problems: ["Method not allowed."] }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, problems: ["Could not read the request."] }, { status: 400 });
  }

  const rawIds = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(rawIds)) {
    return Response.json({ ok: false, problems: ["No file ids were supplied."] }, { status: 400 });
  }
  if (rawIds.length > MAX_RESOLVABLE_IMAGES) {
    return Response.json(
      { ok: false, problems: [`At most ${MAX_RESOLVABLE_IMAGES} images can be resolved at once.`] },
      { status: 400 }
    );
  }

  // MEDIAIMAGE IDS ONLY, checked before Shopify is asked. The picker is
  // invoked with `mediaTypes: ['MediaImage']`, so anything else did not come
  // from it, and there is no reason to spend an API call finding that out.
  const ids: string[] = [];
  for (const candidate of rawIds) {
    if (typeof candidate !== "string" || !/^gid:\/\/shopify\/MediaImage\/[A-Za-z0-9_-]+$/.test(candidate)) {
      return Response.json(
        { ok: false, problems: ["Campaign imagery must be an image file from Shopify Files."] },
        { status: 400 }
      );
    }
    ids.push(candidate);
  }

  const resolution = await resolveCampaignImageRefs(admin, ids);
  if (!resolution.ok) {
    return Response.json({ ok: false, problems: resolution.problems }, { status: 400 });
  }

  logger.info("campaign_images.resolved", { idCount: ids.length });

  // Returned in the order asked for, so the caller can line selections up
  // with the gallery slots it requested.
  return Response.json({
    ok: true,
    images: ids.map((fileGid) => resolution.byGid.get(fileGid)).filter((image) => image !== undefined),
  });
}

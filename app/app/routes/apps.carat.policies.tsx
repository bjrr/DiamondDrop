import type { LoaderFunctionArgs } from "react-router";

import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import {
  PUBLISHED_POLICY_TERMS,
  isPublishedPolicySlug,
  type PublishedPolicyGroup,
} from "~/domain/content/publishedPolicyTerms";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * GET /apps/carat/policies[?group=returns][&slug=...]
 *
 * The authoritative text of every material term a policy page is allowed to
 * quote. Slice 12.
 *
 * A RESOURCE ROUTE — no default export. Same reasoning as every other
 * `apps.carat.*` route.
 *
 * ============================================================================
 * A POLICY PAGE QUOTES; IT DOES NOT RESTATE
 * ============================================================================
 * `publishedPolicyTerms.ts` carries the full argument. In short: typing a
 * material term into a Shopify page creates a second copy with nothing keeping
 * it equal to the sentence the customer actually acknowledged, and the first
 * time anyone notices the drift is a dispute where our page contradicts our
 * own evidence.
 *
 * So the theme renders `text` VERBATIM from here. Narrative, headings and
 * links around it are ordinary page copy; the quoted sentences are not.
 *
 * `version` travels with every term so a page can show which version it is
 * quoting, and so a support conversation can establish what someone would have
 * read on a given day.
 *
 * ============================================================================
 * THE ALLOWLIST IS THE SECURITY BOUNDARY
 * ============================================================================
 * This endpoint never looks up an arbitrary slug. `policy_version` is a
 * general versioned-text table, and serving whatever it is handed would mean
 * the first internal policy added to it becomes world-readable through a
 * storefront URL with no code change and no review. An unknown or
 * unpublished slug gets the same empty result as one that does not exist —
 * no 404, so the endpoint cannot be used to probe which slugs are real.
 *
 * ============================================================================
 * A MISSING ROW IS REPORTED, NOT PAPERED OVER
 * ============================================================================
 * Every slug here is in `REQUIRED_POLICY_VERSIONS`, so `/health` already fails
 * when one is absent. If one is missing anyway, that term is OMITTED from the
 * response and logged at error: a policy page that silently drops a term it
 * was supposed to quote is worse than one that is visibly incomplete, and
 * substituting placeholder text for a material term is worse than both.
 */

function isGroup(value: string | null): value is PublishedPolicyGroup {
  return (
    value === "returns" ||
    value === "warranty" ||
    value === "luxury-steals" ||
    value === "group-buy" ||
    value === "custom-jewelry" ||
    value === "quote-match"
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  const { verified, shop, reason } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET, getEnv().SHOPIFY_SHOP_DOMAIN);
  if (!verified) {
    logger.warn("content.policies_proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const requestedGroup = url.searchParams.get("group");
  const requestedSlug = url.searchParams.get("slug");

  let wanted = PUBLISHED_POLICY_TERMS;
  if (isGroup(requestedGroup)) wanted = wanted.filter((t) => t.group === requestedGroup);
  // AN UNPUBLISHED SLUG NARROWS TO NOTHING rather than erroring. See the
  // header: a 404 here would distinguish "real but unpublished" from
  // "nonexistent".
  if (requestedSlug !== null) wanted = wanted.filter((t) => isPublishedPolicySlug(requestedSlug) && t.slug === requestedSlug);

  const terms: { slug: string; title: string; group: string; version: number; text: string }[] = [];
  for (const term of wanted) {
    const policy = await getLatestPolicyVersion(term.slug);
    if (!policy) {
      logger.error("content.published_policy_term_missing", { slug: term.slug });
      continue;
    }
    terms.push({
      slug: term.slug,
      title: term.title,
      group: term.group,
      version: policy.version,
      // VERBATIM. The theme must render this as given — see the header.
      text: policy.text,
    });
  }

  return Response.json(
    {
      terms,
      /* Set when a term we expected could not be read. The theme should show
         what it has rather than nothing, but a page builder checking this can
         tell the difference between "this group has three terms" and "this
         group has three terms and one failed to load". */
      incomplete: terms.length !== wanted.length,
    },
    {
      headers: {
        /* PUBLIC AND CACHEABLE. These are the same sentences every customer
           is shown at acknowledgment time — there is nothing per-shopper
           here, and a policy term changes by someone deploying a new version,
           not by the minute. Five minutes bounds how long a revised term
           takes to appear. */
        "Cache-Control": "public, max-age=300",
      },
    }
  );
}

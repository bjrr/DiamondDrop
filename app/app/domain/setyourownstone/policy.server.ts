/**
 * Set Your Own Stone — matching policy resolution.
 *
 * docs/SET-YOUR-OWN-STONE.md §6.2 is blunt: "Do not invent a universal
 * jewelry-fit tolerance." This module is where that instruction is kept
 * honest, and it does so by returning nothing unless someone deliberately
 * configured something.
 *
 * THE DEFAULT IS ZERO ON BOTH DIALS. No approved tolerance for any shape,
 * and a review band of zero. With no configuration at all, the only
 * automatic matches possible are an exact nominal hit or a vendor's own
 * published range — both of which are authorities rather than inventions.
 *
 * WHY THIS IS A FUNCTION AND NOT A CONSTANT. §6.2 also requires that
 * tolerance data be "configurable so a later owner-approved rule does not
 * require rewriting the storefront". The seam lives here: when the owner
 * approves a per-shape tolerance, it is read in this one place and every
 * caller picks it up. Today there is nothing to read, and saying so plainly
 * is better than pretending a config system exists.
 */
import {
  DEFAULT_MATCHING_POLICY,
  type MatchingPolicy,
} from "~/domain/setyourownstone/matching";

/**
 * The policy in force.
 *
 * Async because the eventual source is a stored owner decision, and making
 * callers await now means adding that source later changes no call sites.
 */
export async function resolveMatchingPolicy(): Promise<MatchingPolicy> {
  // No owner-approved tolerance exists yet, and a review band is a display
  // threshold the owner has not opened. Returning the zeroed default is the
  // correct behaviour, not a placeholder: it means nothing is shown to a
  // customer on the strength of a number this system made up.
  return DEFAULT_MATCHING_POLICY;
}

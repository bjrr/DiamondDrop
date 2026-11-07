/**
 * Opening Shopify's NATIVE file picker, via the App Home Intents API.
 *
 * ===========================================================================
 * SHOPIFY'S PICKER, NOT OURS
 * ===========================================================================
 * `pick:shopify/File` opens the merchant's own Shopify Files library — the
 * same browser they already know, with their own search, folders, and
 * whatever upload affordance Shopify chooses to offer there. CaratForUs
 * builds none of that and should not: a hand-rolled file browser would be a
 * worse copy of a thing Shopify maintains, and it would need `write_files`
 * to accept an upload. This app requests only `read_files`.
 *
 * The documented contract (shopify.dev, App Home Intents API, 2026-10):
 *
 *     const activity = await shopify.intents.invoke('pick:shopify/File', {
 *       data: {
 *         mediaTypes: ['MediaImage'],
 *         multiSelect: true,
 *         selectedFiles: ['gid://shopify/MediaImage/1'],
 *       },
 *     });
 *     const response = await activity.complete;
 *     // response.code: 'ok' | 'closed' | 'error'
 *     // response.data.ids: string[]   (only when 'ok')
 *
 * ===========================================================================
 * IDS ARE NOT IMAGES
 * ===========================================================================
 * The intent returns ids and nothing else. A thumbnail needs a URL, and only
 * the Admin API can supply one, so the ids go to `/app/campaign-images`,
 * which resolves them server-side with the app's token. The browser never
 * holds an Admin API credential, and the URL it ends up displaying is
 * Shopify's answer rather than anything this file constructed.
 */

/**
 * The slice of App Bridge this module uses. Declared locally rather than
 * imported: App Bridge is injected into the page by Shopify at runtime, and
 * typing only what is actually called keeps this honest about its
 * dependency.
 */
interface ShopifyIntentsBridge {
  readonly intents: {
    invoke(
      intent: "pick:shopify/File",
      options?: {
        data?: {
          mediaTypes?: readonly ("MediaImage" | "Video" | "GenericFile" | "Model3d" | "ExternalVideo")[];
          multiSelect?: boolean;
          selectedFiles?: readonly string[];
          unselectedFiles?: readonly string[];
        };
      }
    ): Promise<{
      complete: Promise<{
        code: "ok" | "closed" | "error";
        message?: string;
        data?: { ids?: readonly string[] };
      }>;
    }>;
  };
}

export interface PickedImage {
  readonly fileGid: string;
  readonly url: string;
  readonly altText: string;
}

export type PickImagesResult =
  /** The merchant chose files and they resolved. */
  | { readonly outcome: "picked"; readonly images: readonly PickedImage[] }
  /** The merchant closed the picker. Not an error; nothing to report. */
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "failed"; readonly message: string };

function bridge(): ShopifyIntentsBridge | null {
  const candidate = (globalThis as { shopify?: unknown }).shopify;
  if (typeof candidate !== "object" || candidate === null) return null;
  const intents = (candidate as { intents?: unknown }).intents;
  if (typeof intents !== "object" || intents === null) return null;
  if (typeof (intents as { invoke?: unknown }).invoke !== "function") return null;
  return candidate as ShopifyIntentsBridge;
}

/** Where the picker's ids are turned into URLs. */
export const CAMPAIGN_IMAGES_ENDPOINT = "/app/campaign-images";

/**
 * Opens the native picker, then resolves the chosen ids into renderable
 * references.
 *
 * `multiSelect` and `alreadySelected` are passed straight through to the
 * intent, so reopening the gallery picker shows the merchant's current
 * choices already ticked rather than an empty library.
 */
export async function pickCampaignImages(options: {
  readonly multiSelect: boolean;
  readonly alreadySelected?: readonly string[];
}): Promise<PickImagesResult> {
  const shopify = bridge();
  if (shopify === null) {
    // Reached when the page is open outside the Shopify admin iframe, where
    // App Bridge is not injected. Said plainly, because the merchant's fix is
    // to open the app from Shopify rather than to retry.
    return {
      outcome: "failed",
      message: "The Shopify file picker is only available when this app is open inside Shopify admin.",
    };
  }

  let ids: readonly string[];
  try {
    const activity = await shopify.intents.invoke("pick:shopify/File", {
      data: {
        // IMAGES ONLY. A campaign hero cannot be a video or a PDF, and
        // filtering here means the merchant is never offered a file that
        // would be refused after they picked it.
        mediaTypes: ["MediaImage"],
        multiSelect: options.multiSelect,
        ...(options.alreadySelected && options.alreadySelected.length > 0
          ? { selectedFiles: options.alreadySelected }
          : {}),
      },
    });
    const response = await activity.complete;

    if (response.code === "closed") return { outcome: "cancelled" };
    if (response.code !== "ok") {
      return { outcome: "failed", message: response.message ?? "Shopify could not open the file picker." };
    }
    ids = response.data?.ids ?? [];
  } catch (error) {
    return {
      outcome: "failed",
      message: error instanceof Error ? error.message : "Shopify could not open the file picker.",
    };
  }

  // The merchant opened the picker and confirmed without choosing anything.
  // Treated as a cancellation, not an empty selection, so an accidental
  // confirm does not silently clear an existing image.
  if (ids.length === 0) return { outcome: "cancelled" };

  let payload: { ok?: boolean; images?: readonly PickedImage[]; problems?: readonly string[] };
  try {
    const response = await fetch(CAMPAIGN_IMAGES_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    payload = (await response.json()) as typeof payload;
  } catch {
    return { outcome: "failed", message: "Those images could not be loaded. Check your connection and try again." };
  }

  if (payload.ok !== true || !Array.isArray(payload.images)) {
    return {
      outcome: "failed",
      message: payload.problems?.join(" ") ?? "Those images could not be loaded from Shopify.",
    };
  }

  return { outcome: "picked", images: payload.images };
}

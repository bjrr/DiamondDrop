import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

/**
 * Loads the REAL `theme/assets/carat-syos-pdp.js` into a minimal Node `vm`
 * sandbox -- same technique and reasoning as
 * `bankPaymentCheckoutFormSandbox.ts` (see that file's header).
 *
 * This one needs a slightly less trivial DOM than its siblings, because the
 * behaviour under test IS the DOM mutation: whether the hidden input ends up
 * named, and whether the custom block ends up revealed. The stub below is
 * therefore a real (tiny) attribute bag with `querySelectorAll` support for
 * the three selectors the asset actually uses, and nothing else.
 *
 * Deliberately NOT a full DOM. A selector the asset does not use is a selector
 * this stub refuses, so a future change that starts querying something new
 * fails loudly here instead of silently matching nothing.
 */
const THEME_ASSETS_ROOT = join(process.cwd(), "..", "theme", "assets");

/** A minimal element: an attribute bag that remembers its children. */
export class StubElement {
  readonly attributes = new Map<string, string>();
  value = "";

  constructor(
    readonly tagName: string,
    attributes: Record<string, string> = {},
    readonly children: StubElement[] = [],
  ) {
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? (this.attributes.get(name) as string) : null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  /** Flattened self + descendants, so a query can look through the block. */
  tree(): StubElement[] {
    return [this, ...this.children.flatMap((child) => child.tree())];
  }

  querySelectorAll(selector: string): StubElement[] {
    return matchAll(this.children.flatMap((child) => child.tree()), selector);
  }
}

/**
 * The only selectors the asset is allowed to use. Anything else throws rather
 * than quietly returning an empty list -- an empty list is how the Liquid bug
 * this asset exists to fix went unnoticed in the first place.
 */
function matchAll(pool: StubElement[], selector: string): StubElement[] {
  switch (selector) {
    case "input[data-carat-syos-session]":
      return pool.filter((e) => e.tagName === "input" && e.hasAttribute("data-carat-syos-session"));
    case "[data-carat-syos-pdp-custom]":
      return pool.filter((e) => e.hasAttribute("data-carat-syos-pdp-custom"));
    case "a[data-carat-syos-link-base]":
      return pool.filter((e) => e.tagName === "a" && e.hasAttribute("data-carat-syos-link-base"));
    default:
      throw new Error(`carat-syos-pdp.js queried an unexpected selector: ${selector}`);
  }
}

export interface SyosPdpRun {
  /** The hidden input after the asset ran. */
  input: StubElement;
  /** The custom-path block after the asset ran. */
  block: StubElement;
  /** Its two links, in document order: customize-this, then back-to-my-stone. */
  links: StubElement[];
  /** Re-runs the asset's observer callback, as a Dawn re-render would. */
  rerender(): void;
}

/**
 * Builds the markup the theme really emits for an SYOS mounting -- a nameless
 * hidden input and a hidden block whose links carry base URLs -- then runs the
 * asset against it at `url`.
 */
export function runSyosPdpAsset(url: string): SyosPdpRun {
  const source = readFileSync(join(THEME_ASSETS_ROOT, "carat-syos-pdp.js"), "utf8");

  // Exactly what buy-buttons.liquid and main-product.liquid render: no `name`
  // on the input, `hidden` on the block.
  const input = new StubElement("input", { type: "hidden", "data-carat-syos-session": "" });
  const customizeThis = new StubElement("a", {
    "data-carat-syos-link-base": "/pages/custom-jewelry?mounting=A%20Ring",
    href: "/pages/custom-jewelry?mounting=A%20Ring",
  });
  const backToStone = new StubElement("a", {
    "data-carat-syos-link-base": "/pages/set-your-own-stone",
    href: "/pages/set-your-own-stone",
  });
  const block = new StubElement("div", { "data-carat-syos-pdp-custom": "", hidden: "" }, [
    customizeThis,
    backToStone,
  ]);
  const body = new StubElement("body", {}, [input, block]);

  let observerCallback: (() => void) | null = null;
  const frames: (() => void)[] = [];

  const windowStub = {
    location: { href: url, origin: new URL(url).origin },
    requestAnimationFrame: (fn: () => void) => {
      frames.push(fn);
      return frames.length;
    },
  };

  const documentStub = {
    body,
    querySelectorAll: (selector: string) => matchAll(body.tree(), selector),
  };

  class ObserverStub {
    constructor(callback: () => void) {
      observerCallback = callback;
    }
    observe(): void {}
    disconnect(): void {}
  }

  const sandbox = {
    window: windowStub,
    document: documentStub,
    URL,
    URLSearchParams,
    MutationObserver: ObserverStub,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "carat-syos-pdp.js" });

  return {
    input,
    block,
    links: [customizeThis, backToStone],
    rerender() {
      if (!observerCallback) throw new Error("carat-syos-pdp.js registered no observer");
      observerCallback();
      // Drain the frame it scheduled, which is where the reapply happens.
      while (frames.length > 0) (frames.shift() as () => void)();
    },
  };
}

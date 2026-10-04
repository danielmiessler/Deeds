import { type Command, EXIT } from "./contract.ts";
import { VENDOR_HOSTS } from "./vendors.ts";

export type Catalog = {
  name: "deeds";
  exitCodes: typeof EXIT;
  vendorHosts: string[];
  /** "os-sandbox": this process runs under an OS network denial; "in-process": only the tripwire is active. */
  offlineEnforcement: "os-sandbox" | "in-process";
  commands: { name: string; summary: string; usage: string; network: "none" | "model" | "model+clone"; pure: boolean }[];
};

/** Pure: the sandbox state is an input, so building the catalog does no I/O. */
export function buildCatalog(commands: readonly Command[], offlineEnforcement: Catalog["offlineEnforcement"]): Catalog {
  return {
    name: "deeds",
    exitCodes: EXIT,
    vendorHosts: [...VENDOR_HOSTS],
    offlineEnforcement,
    commands: commands.map((c) => ({
      name: c.name,
      summary: c.summary,
      usage: c.usage ?? `deeds ${c.name}`,
      network: c.network ?? "none",
      pure: c.pure === true,
    })),
  };
}

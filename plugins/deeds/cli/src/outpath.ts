/**
 * Where analyze may write the files it is asked for (`--html <file>`, analyze-many's `--out <dir>`). Repository
 * text reaches an agent running deeds (author and cap names), so a steered agent could name a startup file or an
 * agent instruction file as the output. By default the path must stay inside the working directory (symlinks
 * resolved), an existing --html target must be an .html file, and an existing --out target must be a folder.
 * `--allow-any-output` lifts all three for a person who means it.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { DeedsError, EXIT } from "./contract.ts";

export const ALLOW_ANY_OUTPUT_FLAG = "--allow-any-output";

/** The nearest existing path at or above `p`, resolved through symlinks. */
function realExisting(p: string): string {
  let cur = p;
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
  return realpathSync(cur);
}

function inside(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve an output path against `cwd` and refuse it unless it is safe to write, or `allowAny` is set. */
export function checkOutputPath(cwd: string, target: string, kind: "html" | "dir", allowAny: boolean): string {
  const out = resolve(cwd, target);
  if (allowAny) return out;
  const flag = kind === "html" ? "--html" : "--out";
  const refuse = (why: string) => {
    throw new DeedsError("usage", `${flag} ${target}: ${why}; pass ${ALLOW_ANY_OUTPUT_FLAG} to write there anyway`, EXIT.usage);
  };
  const exists = existsSync(out) || (() => { try { return lstatSync(out).isSymbolicLink(); } catch { return false; } })();
  if (exists) {
    const st = lstatSync(out);
    if (st.isSymbolicLink()) refuse("it is a symbolic link");
    if (kind === "html" && !(st.isFile() && extname(out).toLowerCase() === ".html")) refuse("it already exists and is not an .html file");
    if (kind === "dir" && !st.isDirectory()) refuse("it already exists and is not a folder");
  }
  const base = realpathSync(cwd);
  // Lexically under cwd, and still under it once the existing part of the path is resolved through symlinks.
  if (!inside(resolve(cwd), out) || !inside(base, realExisting(out))) refuse(`it is outside the working directory ${base}`);
  return out;
}

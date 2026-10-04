/**
 * The language registry. A language is a tree-sitter grammar, the query files that find its
 * boundaries (queries/*.scm), and a small interpreter that turns one query match into a boundary.
 * Adding a language means adding those three things here; the engine does not change.
 *
 * Query convention: every match carries exactly one anchor capture named route, cli, ui or export,
 * plus fields named `<anchor>.<field>`. Matches are interpreted below and anything that does not look
 * like a real boundary (a client call that resembles a route, a private function) returns null.
 */
import type { Node } from "web-tree-sitter";
import goWasm from "tree-sitter-wasms/out/tree-sitter-go.wasm" with { type: "file" };
import javascriptWasm from "tree-sitter-wasms/out/tree-sitter-javascript.wasm" with { type: "file" };
import pythonWasm from "tree-sitter-wasms/out/tree-sitter-python.wasm" with { type: "file" };
import rustWasm from "tree-sitter-wasms/out/tree-sitter-rust.wasm" with { type: "file" };
import tsxWasm from "tree-sitter-wasms/out/tree-sitter-tsx.wasm" with { type: "file" };
import typescriptWasm from "tree-sitter-wasms/out/tree-sitter-typescript.wasm" with { type: "file" };
import ecmaCommon from "./queries/ecma-common.scm" with { type: "text" };
import ecmaJsx from "./queries/ecma-jsx.scm" with { type: "text" };
import ecmaTs from "./queries/ecma-ts.scm" with { type: "text" };
import goQueries from "./queries/go.scm" with { type: "text" };
import pythonQueries from "./queries/python.scm" with { type: "text" };
import rustQueries from "./queries/rust.scm" with { type: "text" };

export type Kind = "route" | "cli" | "ui" | "export";
export const KINDS: readonly Kind[] = ["route", "cli", "ui", "export"];

export interface Boundary {
  kind: Kind;
  name: string;
  file: string;
  line: number;
  language: string;
  detail?: string;
}

/** One query match: its anchor node and its named captures. */
export interface Match {
  anchor: Node;
  caps: ReadonlyMap<string, Node>;
}

/** What an interpreter returns: the boundary text and the node whose line identifies it. */
export interface Found {
  name: string;
  at: Node;
  detail?: string;
  /** A definition node counted as a route or command: it is not also an export. */
  claim?: Node;
  /** For an export: the definition node, checked against the claims above. */
  of?: Node;
  /** Same-anchor siblings with this key collapse, preferring the named form (default exports). */
  weak?: boolean;
}

export interface Interpreter {
  route(m: Match): Found[];
  cli(m: Match): Found[];
  ui(m: Match): Found[];
  export(m: Match): Found[];
}

export interface LanguageSpec {
  id: string;
  /** Path of the grammar wasm. */
  grammar: string;
  extensions: readonly string[];
  /** Query sources, concatenated. */
  queries: string;
  interpreter: Interpreter;
  /** Path segments that mean "not importable from outside", for exports (Go internal/). */
  privateDirs?: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// helpers

const cap = (m: Match, name: string): Node | undefined => m.caps.get(name);
const collapse = (s: string, max = 60): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
};

/** Strip quotes from a string literal's text (or return the text of an already-unquoted fragment). */
export function unquote(text: string): string {
  const raw = /^r(#*)"([\s\S]*)"\1$/.exec(text);
  if (raw) return raw[2]!;
  if (text.length >= 2) {
    const q = text[0]!;
    if ((q === '"' || q === "'" || q === "`") && text.endsWith(q)) return text.slice(1, -1);
  }
  return text;
}

const VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const verb = (s: string): string => (VERBS.has(s.toUpperCase()) ? s.toUpperCase() : "ANY");
const firstToken = (s: string): string => s.trim().split(/\s+/)[0] ?? "";
const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const isCommandName = (s: string): boolean => /^[A-Za-z0-9][\w.:-]*$/.test(s);

const one = (name: string, at: Node, extra: Partial<Found> = {}): Found[] => [{ name, at, ...extra }];

function uiFrom(m: Match): Found[] {
  const target = cap(m, "ui.target");
  const event = cap(m, "ui.event");
  if (!target || !event) return [];
  return one(`${collapse(target.text)}:${event.text}`, event);
}

// ---------------------------------------------------------------------------------------------
// ECMAScript family (typescript, tsx, javascript)

const FUNCTION_LIKE = new Set(["arrow_function", "function_expression", "function", "function_declaration"]);
const REFERENCE_LIKE = new Set(["identifier", "member_expression"]);
const CLIENT_RECEIVER = /(^|\.)(axios|http|https|fetch|client|api|request|superagent|got|ky|session|agent|\$http|httpClient)$/i;
const OPTION_NAME = /^(opts|options|config|cfg|params|headers|init|settings)$/i;

/** A call like `app.get("/x", handler)` is a route; `axios.get("/x", opts)` and `map.get("/k")` are not. */
function looksLikeHandlerCall(args: Node, receiver: string): boolean {
  if (CLIENT_RECEIVER.test(receiver.trim())) return false;
  const rest = args.namedChildren.slice(1).filter((n): n is Node => n !== null && n.type !== "comment");
  if (rest.length === 0) return false;
  if (rest.some((n) => FUNCTION_LIKE.has(n.type))) return true;
  const last = rest[rest.length - 1]!;
  return REFERENCE_LIKE.has(last.type) && !OPTION_NAME.test(last.text);
}

const DECL_DETAIL: Record<string, string> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  function_signature: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  variable_declaration: "var",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
};

const ecma: Interpreter = {
  route(m) {
    const path = cap(m, "route.path");
    const method = cap(m, "route.method");
    const args = cap(m, "route.args");
    const recv = cap(m, "route.recv");
    if (!path || !method || !args || !recv) return [];
    if (!path.text.startsWith("/")) return [];
    if (!looksLikeHandlerCall(args, recv.text)) return [];
    return one(`${verb(method.text)} ${path.text}`, path);
  },
  cli(m) {
    const name = cap(m, "cli.name");
    if (!name) return [];
    const first = firstToken(name.text);
    return isCommandName(first) ? one(first, name) : [];
  },
  ui(m) {
    const handler = cap(m, "ui.handler");
    if (handler && !FUNCTION_LIKE.has(handler.type) && !REFERENCE_LIKE.has(handler.type)) return [];
    return uiFrom(m);
  },
  export(m) {
    const name = cap(m, "export.name");
    const decl = cap(m, "export.decl");
    const from = cap(m, "export.from");
    const dflt = cap(m, "export.default");
    if (from) return one(`* from ${from.text}`, from, { detail: "star" });
    if (dflt) return one("default", dflt, { detail: "default", weak: true });
    if (!name) return [];
    const exported = cap(m, "export.alias") ?? name;
    if (!decl) return one(unquote(exported.text), exported, { detail: "named" });
    const detail =
      decl.type === "lexical_declaration" ? (decl.firstChild?.text ?? "const") : (DECL_DETAIL[decl.type] ?? decl.type);
    return one(name.text, name, { detail });
  },
};

// ---------------------------------------------------------------------------------------------
// Python

/** The text node of a string literal, or undefined when `node` is not a string. */
function pyString(node: Node | null | undefined): Node | undefined {
  if (!node || node.type !== "string") return undefined;
  return node.namedChildren.find((c) => c?.type === "string_content") ?? node;
}

/** The string node naming a click/typer command: first positional string, or `name="..."`. */
function pyCliName(args: Node): Node | undefined {
  for (const c of args.namedChildren) {
    if (!c) continue;
    if (c.type === "string") return pyString(c);
    if (c.type === "keyword_argument" && c.childForFieldName("name")?.text === "name") {
      return pyString(c.childForFieldName("value"));
    }
  }
  return undefined;
}

const python: Interpreter = {
  route(m) {
    const path = cap(m, "route.path");
    const method = cap(m, "route.method");
    const args = cap(m, "route.args");
    if (!path || !method || !args || !path.text.startsWith("/")) return [];
    let methods = [verb(method.text)];
    if (method.text === "route") {
      const list = /methods\s*=\s*[[(]([^\])]*)[\])]/.exec(args.text);
      const named = list ? [...list[1]!.matchAll(/["']([A-Za-z]+)["']/g)].map((x) => x[1]!.toUpperCase()) : [];
      methods = named.length > 0 ? named : ["GET"];
    }
    const claim = cap(m, "claim");
    return methods.map((x) => ({ name: `${x} ${path.text}`, at: path, ...(claim ? { claim } : {}) }));
  },
  cli(m) {
    const claim = cap(m, "claim");
    const claimed = claim ? { claim } : {};
    const named = cap(m, "cli.name");
    if (named) return one(firstToken(named.text), named);
    const fallback = cap(m, "cli.fallback");
    if (!fallback) return [];
    const args = cap(m, "cli.args");
    const explicit = args ? pyCliName(args) : undefined;
    if (explicit !== undefined) return explicit.text ? one(explicit.text, explicit, claimed) : [];
    return one(fallback.text.replace(/_/g, "-"), fallback, claimed);
  },
  ui: uiFrom,
  export(m) {
    const name = cap(m, "export.name");
    const decl = cap(m, "export.decl");
    if (!name || !decl || name.text.startsWith("_")) return [];
    return one(name.text, name, { detail: decl.type === "class_definition" ? "class" : "function", of: decl });
  },
};

// ---------------------------------------------------------------------------------------------
// Go

const goRoute: Interpreter["route"] = (m) => {
  const path = cap(m, "route.path");
  const method = cap(m, "route.method");
  const args = cap(m, "route.args");
  if (!path || !method || !args || args.namedChildCount < 2) return [];
  const text = unquote(path.text);
  const pattern = /^([A-Z]+)\s+(\/.*)$/.exec(text);
  if (pattern) return one(`${verb(pattern[1]!)} ${pattern[2]}`, path);
  if (!text.startsWith("/")) return [];
  return one(`${verb(method.text)} ${text}`, path);
};

const GO_DETAIL: Record<string, string> = {
  function_declaration: "function",
  method_declaration: "method",
  const_spec: "const",
  var_spec: "var",
};

const go: Interpreter = {
  route: goRoute,
  cli(m) {
    const name = cap(m, "cli.name");
    if (!name) return [];
    const first = firstToken(unquote(name.text));
    return isCommandName(first) ? one(first, name) : [];
  },
  ui: () => [],
  export(m) {
    const name = cap(m, "export.name");
    const decl = cap(m, "export.decl");
    if (!name || !decl || !/^[A-Z]/.test(name.text)) return [];
    const recv = cap(m, "export.recv");
    if (recv) {
      if (!/^[A-Z]/.test(recv.text)) return [];
      return one(`${recv.text}.${name.text}`, name, { detail: "method" });
    }
    let detail = GO_DETAIL[decl.type];
    if (decl.type === "type_spec") {
      const t = decl.childForFieldName("type")?.type;
      detail = t === "struct_type" ? "struct" : t === "interface_type" ? "interface" : "type";
    }
    return one(name.text, name, { detail: detail ?? decl.type });
  },
};

// ---------------------------------------------------------------------------------------------
// Rust

const RUST_DETAIL: Record<string, string> = {
  function_item: "function",
  struct_item: "struct",
  enum_item: "enum",
  trait_item: "trait",
  type_item: "type",
  const_item: "const",
  static_item: "static",
  mod_item: "mod",
};

/** True when the enum carries `#[derive(... Subcommand ...)]`: its variants are CLI commands. */
function isSubcommandEnum(enumNode: Node): boolean {
  for (let n = enumNode.previousNamedSibling; n && (n.type === "attribute_item" || n.type === "line_comment"); n = n.previousNamedSibling) {
    if (n.type === "attribute_item" && /\bSubcommand\b/.test(n.text)) return true;
  }
  return false;
}

const rust: Interpreter = {
  route(m) {
    const path = cap(m, "route.path");
    const method = cap(m, "route.method");
    const args = cap(m, "route.args");
    if (!path) return [];
    const text = unquote(path.text);
    if (!text.startsWith("/")) return [];
    if (method) return one(`${verb(method.text)} ${text}`, path);
    // Builder form: .route("/x", get(handler))
    const second = args?.namedChildren[1];
    const hit = second ? /^(?:[\w]+::)*(get|post|put|patch|delete|head|options)\b/.exec(second.text) : null;
    return one(`${hit ? verb(hit[1]!) : "ANY"} ${text}`, path);
  },
  cli(m) {
    const name = cap(m, "cli.name");
    if (!name) return [];
    const enumNode = cap(m, "cli.enum");
    if (enumNode) return isSubcommandEnum(enumNode) ? one(kebab(name.text), name) : [];
    const text = unquote(name.text);
    return isCommandName(text) ? one(text, name) : [];
  },
  ui: () => [],
  export(m) {
    const name = cap(m, "export.name");
    const decl = cap(m, "export.decl");
    const vis = cap(m, "export.vis");
    if (!name || !decl || vis?.text !== "pub") return [];
    const recv = cap(m, "export.recv");
    if (recv) return one(`${recv.text}::${name.text}`, name, { detail: "method" });
    return one(name.text, name, { detail: RUST_DETAIL[decl.type] ?? decl.type });
  },
};

// ---------------------------------------------------------------------------------------------
// Registry

const wasm = (p: string): string => p;

export const LANGUAGES: readonly LanguageSpec[] = [
  {
    id: "typescript",
    grammar: wasm(typescriptWasm),
    extensions: [".ts", ".mts", ".cts"],
    queries: ecmaCommon + "\n" + ecmaTs,
    interpreter: ecma,
  },
  {
    id: "tsx",
    grammar: wasm(tsxWasm),
    extensions: [".tsx"],
    queries: ecmaCommon + "\n" + ecmaTs + "\n" + ecmaJsx,
    interpreter: ecma,
  },
  {
    id: "javascript",
    grammar: wasm(javascriptWasm),
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    queries: ecmaCommon + "\n" + ecmaJsx,
    interpreter: ecma,
  },
  { id: "python", grammar: wasm(pythonWasm), extensions: [".py"], queries: pythonQueries, interpreter: python },
  {
    id: "go",
    grammar: wasm(goWasm),
    extensions: [".go"],
    queries: goQueries,
    interpreter: go,
    privateDirs: ["internal"],
  },
  { id: "rust", grammar: wasm(rustWasm), extensions: [".rs"], queries: rustQueries, interpreter: rust },
];

const BY_EXT = new Map<string, LanguageSpec>(LANGUAGES.flatMap((l) => l.extensions.map((e) => [e, l] as const)));

/** The language of a path by extension, or undefined when no grammar covers it. */
export function languageOf(path: string): LanguageSpec | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : BY_EXT.get(path.slice(dot));
}

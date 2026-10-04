; Shared by typescript, tsx and javascript. Capture names: the anchor is route | cli | ui | export,
; fields are <anchor>.<field>. The interpreter lives in ../engine.ts and ../languages.ts.

; HTTP routes: app.get("/path", handler), router.post("/path", mw, handler)
(call_expression
  function: (member_expression
    object: (_) @route.recv
    property: (property_identifier) @route.method)
  arguments: (arguments . (string (string_fragment) @route.path)) @route.args
  (#match? @route.method "^(get|post|put|patch|delete|head|options|all)$")) @route

; CLI commands: program.command("name <arg>")
(call_expression
  function: (member_expression
    property: (property_identifier) @cli.kind)
  arguments: (arguments . (string (string_fragment) @cli.name))
  (#eq? @cli.kind "command")) @cli

; UI events: target.addEventListener("click", fn) and target.onclick = fn
(call_expression
  function: (member_expression
    object: (_) @ui.target
    property: (property_identifier) @ui.kind)
  arguments: (arguments . (string (string_fragment) @ui.event))
  (#eq? @ui.kind "addEventListener")) @ui

(assignment_expression
  left: (member_expression
    object: (_) @ui.target
    property: (property_identifier) @ui.event)
  right: (_) @ui.handler
  (#match? @ui.event "^on[a-z]+$")) @ui

; Exports
(export_statement
  declaration: (function_declaration name: (identifier) @export.name) @export.decl) @export
(export_statement
  declaration: (generator_function_declaration name: (identifier) @export.name) @export.decl) @export
(export_statement
  declaration: (class_declaration name: (_) @export.name) @export.decl) @export
(export_statement
  declaration: (lexical_declaration
    (variable_declarator name: (identifier) @export.name)) @export.decl) @export
(export_statement
  declaration: (variable_declaration
    (variable_declarator name: (identifier) @export.name)) @export.decl) @export
(export_statement
  (export_clause
    (export_specifier name: (_) @export.name alias: (_)? @export.alias))) @export
(export_statement
  "*"
  source: (string (string_fragment) @export.from)) @export
(export_statement
  "default"
  value: (_) @export.default) @export

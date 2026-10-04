; Routes: actix and rocket attribute macros.
(attribute_item
  (attribute
    [(identifier) @route.method (scoped_identifier name: (identifier) @route.method)]
    arguments: (token_tree . (string_literal) @route.path))
  (#match? @route.method "^(get|post|put|patch|delete|head|options)$")) @route

; Routes: axum and actix builders, Router::new().route("/path", get(handler))
(call_expression
  function: (field_expression field: (field_identifier) @route.kind)
  arguments: (arguments . (string_literal) @route.path) @route.args
  (#eq? @route.kind "route")) @route

; CLI commands: clap builder and derive.
(call_expression
  function: (scoped_identifier path: (identifier) @cli.type name: (identifier) @cli.kind)
  arguments: (arguments . (string_literal) @cli.name)
  (#match? @cli.type "^(Command|App|SubCommand)$")
  (#match? @cli.kind "^(new|with_name)$")) @cli
(enum_item
  body: (enum_variant_list (enum_variant name: (identifier) @cli.name) @cli)) @cli.enum

; Exports: pub items.
(source_file
  (function_item (visibility_modifier) @export.vis name: (identifier) @export.name) @export.decl @export)
(source_file
  (struct_item (visibility_modifier) @export.vis name: (type_identifier) @export.name) @export.decl @export)
(source_file
  (enum_item (visibility_modifier) @export.vis name: (type_identifier) @export.name) @export.decl @export)
(source_file
  (trait_item (visibility_modifier) @export.vis name: (type_identifier) @export.name) @export.decl @export)
(source_file
  (type_item (visibility_modifier) @export.vis name: (type_identifier) @export.name) @export.decl @export)
(source_file
  (const_item (visibility_modifier) @export.vis name: (identifier) @export.name) @export.decl @export)
(source_file
  (static_item (visibility_modifier) @export.vis name: (identifier) @export.name) @export.decl @export)
(source_file
  (mod_item (visibility_modifier) @export.vis name: (identifier) @export.name) @export.decl @export)
(source_file
  (impl_item
    !trait
    type: (type_identifier) @export.recv
    body: (declaration_list
      (function_item (visibility_modifier) @export.vis name: (identifier) @export.name) @export.decl @export)))

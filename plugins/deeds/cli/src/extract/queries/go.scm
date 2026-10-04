; Routes: net/http, gin, echo, chi and similar. The interpreter requires a handler argument.
(call_expression
  function: (selector_expression field: (field_identifier) @route.method)
  arguments: (argument_list . [(interpreted_string_literal) (raw_string_literal)] @route.path) @route.args
  (#match? @route.method "^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Head|Options|Any|ANY|Handle|HandleFunc)$")) @route

; CLI commands: cobra and urfave composite literals.
(composite_literal
  type: (qualified_type name: (type_identifier) @cli.kind)
  body: (literal_value
    (keyed_element
      (literal_element (identifier) @cli.key)
      (literal_element [(interpreted_string_literal) (raw_string_literal)] @cli.name)))
  (#eq? @cli.kind "Command")
  (#match? @cli.key "^(Use|Name)$")) @cli

; Exports: capitalised top-level declarations.
(source_file
  (function_declaration name: (identifier) @export.name) @export.decl @export)
(source_file
  (method_declaration
    receiver: (parameter_list
      (parameter_declaration
        type: [(type_identifier) @export.recv (pointer_type (type_identifier) @export.recv)]))
    name: (field_identifier) @export.name) @export.decl @export)
(source_file
  (type_declaration (type_spec name: (type_identifier) @export.name) @export.decl) @export)
(source_file
  (const_declaration (const_spec name: (identifier) @export.name) @export.decl) @export)
(source_file
  (var_declaration (var_spec name: (identifier) @export.name) @export.decl) @export)

; TypeScript-only declarations (typescript and tsx).
(export_statement
  declaration: (interface_declaration name: (type_identifier) @export.name) @export.decl) @export
(export_statement
  declaration: (type_alias_declaration name: (type_identifier) @export.name) @export.decl) @export
(export_statement
  declaration: (enum_declaration name: (identifier) @export.name) @export.decl) @export
(export_statement
  declaration: (abstract_class_declaration name: (type_identifier) @export.name) @export.decl) @export
(export_statement
  declaration: (function_signature name: (identifier) @export.name) @export.decl) @export

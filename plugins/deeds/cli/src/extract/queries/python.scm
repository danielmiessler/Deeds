; Routes: Flask, FastAPI and similar decorators.
(decorated_definition
  (decorator
    (call
      function: (attribute attribute: (identifier) @route.method)
      arguments: (argument_list . (string (string_content) @route.path)) @route.args))
  definition: (_) @claim
  (#match? @route.method "^(route|get|post|put|patch|delete|head|options)$")) @route

; CLI commands: click and typer decorators, with and without a call.
(decorated_definition
  (decorator
    (call
      function: (attribute attribute: (identifier) @cli.kind)
      arguments: (argument_list) @cli.args))
  definition: (function_definition name: (identifier) @cli.fallback) @claim
  (#match? @cli.kind "^(command|group)$")) @cli
(decorated_definition
  (decorator
    (attribute attribute: (identifier) @cli.kind))
  definition: (function_definition name: (identifier) @cli.fallback) @claim
  (#match? @cli.kind "^(command|group)$")) @cli

; CLI commands: argparse sub-parsers.
(call
  function: (attribute attribute: (identifier) @cli.kind)
  arguments: (argument_list . (string (string_content) @cli.name))
  (#eq? @cli.kind "add_parser")) @cli

; UI events: tkinter bind and Qt signals.
(call
  function: (attribute
    object: (_) @ui.target
    attribute: (identifier) @ui.kind)
  arguments: (argument_list . (string (string_content) @ui.event))
  (#eq? @ui.kind "bind")) @ui
(call
  function: (attribute
    object: (attribute
      object: (_) @ui.target
      attribute: (identifier) @ui.event)
    attribute: (identifier) @ui.kind)
  (#eq? @ui.kind "connect")) @ui

; Exports: top-level functions and classes.
(module
  (function_definition name: (identifier) @export.name) @export.decl @export)
(module
  (class_definition name: (identifier) @export.name) @export.decl @export)
(module
  (decorated_definition
    definition: (function_definition name: (identifier) @export.name) @export.decl) @export)
(module
  (decorated_definition
    definition: (class_definition name: (identifier) @export.name) @export.decl) @export)

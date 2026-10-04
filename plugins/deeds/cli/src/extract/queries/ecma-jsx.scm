; JSX event props (tsx and javascript): <button onClick={fn}>
(jsx_opening_element
  name: (_) @ui.target
  (jsx_attribute (property_identifier) @ui.event (jsx_expression)) @ui
  (#match? @ui.event "^on[A-Z]"))
(jsx_self_closing_element
  name: (_) @ui.target
  (jsx_attribute (property_identifier) @ui.event (jsx_expression)) @ui
  (#match? @ui.event "^on[A-Z]"))

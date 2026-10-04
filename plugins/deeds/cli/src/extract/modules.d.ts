declare module "*.wasm" {
  const path: string;
  export default path;
}
declare module "*.scm" {
  const text: string;
  export default text;
}

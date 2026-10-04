/**
 * The noise list: files whose hunks say nothing about the work and only cost tokens. Lockfiles,
 * generated output, data files and logs are cut from a diff before any model sees it. Schema
 * and migration files are code and stay.
 */

const NOISE_BASENAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
  "Cargo.lock", "Gemfile.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "composer.lock", "go.sum",
  "mix.lock", "pubspec.lock", "Podfile.lock", "packages.lock.json", "flake.lock", "gradle.lockfile",
]);

const NOISE_PATTERNS: RegExp[] = [
  // Generated or bundled output.
  /(^|\/)(dist|build|out|vendor|node_modules|__generated__|generated)\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.(generated|gen)\.[a-z]+$/,
  /\.pb\.(go|cc|h)$/,
  /_pb2(_grpc)?\.py$/,
  /\.snap$/,
  // Data files.
  /\.(csv|tsv|parquet|feather|arrow|xlsx|xls|sqlite|sqlite3|db|ndjson|avro|orc|pkl|npy|npz|h5)$/i,
  // Logs.
  /\.log$/i,
  /(^|\/)logs?\//,
];

/** True when a path's hunks never reach the model. */
export function isNoisePath(path: string): boolean {
  const base = path.split("/").at(-1) ?? path;
  return NOISE_BASENAMES.has(base) || NOISE_PATTERNS.some((re) => re.test(path));
}

/** One file's section of a unified diff, from its `diff --git` header to the next. */
interface FileSection {
  path: string;
  text: string;
}

/** Split a `git show` diff into per-file sections. Text before the first header is dropped. */
export function splitDiff(diff: string): FileSection[] {
  const out: FileSection[] = [];
  const re = /^diff --(?:git|cc|combined) (.+)$/gm;
  const starts: { index: number; header: string }[] = [];
  for (let m = re.exec(diff); m; m = re.exec(diff)) starts.push({ index: m.index, header: m[1]! });
  starts.forEach((s, i) => {
    const text = diff.slice(s.index, starts[i + 1]?.index ?? diff.length);
    // `a/x b/y` for a normal diff, the bare path for a combined (merge) diff.
    const pair = /^a\/(.+?) b\/(.+)$/.exec(s.header);
    out.push({ path: pair ? pair[2]! : s.header.trim(), text });
  });
  return out;
}

/** Drop every noise file from a commit. Returns the files and diff that may reach the model. */
export function stripNoise(commit: { files: string[]; diff: string }): { files: string[]; diff: string; dropped: string[] } {
  const sections = splitDiff(commit.diff);
  const kept = sections.filter((s) => !isNoisePath(s.path));
  const dropped = [...new Set([...sections.filter((s) => isNoisePath(s.path)).map((s) => s.path), ...commit.files.filter(isNoisePath)])];
  return {
    files: commit.files.filter((f) => !isNoisePath(f)),
    diff: kept.map((s) => s.text).join(""),
    dropped,
  };
}

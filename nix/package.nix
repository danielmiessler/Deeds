{
  lib,
  stdenvNoCC,
  bun,
  git,
  makeWrapper,
}:

let
  cli = ../plugins/deeds/cli;
  inherit (builtins.fromJSON (builtins.readFile (cli + "/package.json"))) version;

  # Update this hash whenever plugins/deeds/cli/bun.lock changes: build once with
  # lib.fakeHash, then copy the hash from the error message.
  nodeModulesHash = "sha256-2bmVEPK10WZo3nCkp1vFtr2lmuiiOuFn918w9Ja2/RM=";

  nodeModules = stdenvNoCC.mkDerivation {
    pname = "deeds-node-modules";
    inherit version;
    src = lib.fileset.toSource {
      root = cli;
      fileset = lib.fileset.unions [
        (cli + "/package.json")
        (cli + "/bun.lock")
      ];
    };
    nativeBuildInputs = [ bun ];
    dontConfigure = true;
    dontFixup = true;
    buildPhase = ''
      export HOME=$TMPDIR
      bun install --frozen-lockfile --production --ignore-scripts --no-cache --silent
    '';
    installPhase = ''
      cp -r node_modules $out
    '';
    outputHashMode = "recursive";
    outputHash = nodeModulesHash;
  };
in
stdenvNoCC.mkDerivation {
  pname = "deeds";
  inherit version;
  src = lib.fileset.toSource {
    root = cli;
    fileset = lib.fileset.unions [
      (cli + "/package.json")
      (cli + "/bunfig.toml")
      (cli + "/src")
      (cli + "/canon")
    ];
  };
  nativeBuildInputs = [ makeWrapper ];
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/deeds
    cp -r package.json bunfig.toml src canon $out/share/deeds/
    ln -s ${nodeModules} $out/share/deeds/node_modules
    makeWrapper ${lib.getExe bun} $out/bin/deeds \
      --add-flags "--no-env-file --config=$out/share/deeds/bunfig.toml $out/share/deeds/src/cli.ts" \
      --suffix PATH : ${lib.makeBinPath [ git ]}
    runHook postInstall
  '';

  meta = {
    description = "Count caps, fixes and tends instead of PRs";
    homepage = "https://github.com/danielmiessler/deeds";
    license = lib.licenses.mit;
    mainProgram = "deeds";
  };
}

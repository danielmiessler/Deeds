import { type Command, DeedsError, EXIT } from "../contract.ts";

const GLOBAL_FLAGS = ["--json", "--allow-unsandboxed"];
const CHOICES: Readonly<Record<string, string>> = {
  "--mode": "jev full",
  "--vendor": "anthropic openai",
};
const VALUE_FLAGS: Readonly<Record<string, true>> = {
  "--since": true, "--until": true, "--mode": true, "--vendor": true,
  "--model": true, "--html": true, "--out": true, "--rev": true,
};
const FILE_FLAGS: Readonly<Record<string, true>> = { "--html": true, "--out": true };

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function flags(command: Command): string[] {
  return [...new Set([...GLOBAL_FLAGS, ...Array.from((command.usage ?? "").matchAll(/--[a-z][a-z-]*/g), (m) => m[0])])];
}

function bash(commands: readonly Command[]): string {
  const names = commands.map((c) => c.name).join(" ");
  return `# Bash completion for deeds. Source this file in your shell.
_deeds() {
  local cur command="" pending="" word choices="" i
  cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  for ((i=1; i<COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    case "$word" in --json|--allow-unsandboxed) continue ;; esac
    if [[ -z "$command" ]]; then
      command="$word"
    elif [[ -n "$pending" ]]; then
      pending=""
    else
      case "$word" in ${Object.keys(VALUE_FLAGS).join("|")}) pending="$word" ;; esac
    fi
  done
  if [[ -z "$command" ]]; then
    choices=${quote(`${names} ${GLOBAL_FLAGS.join(" ")} --help -h`)}
  elif [[ "$cur" == -* && -z "$pending" ]]; then
    case "$command" in
${commands.map((c) => `      ${c.name}) choices=${quote(flags(c).join(" "))} ;;`).join("\n")}
    esac
  else
    case "$pending" in
      --mode) choices=${quote(CHOICES["--mode"] ?? "")} ;;
      --vendor) choices=${quote(CHOICES["--vendor"] ?? "")} ;;
      --html|--out) return 0 ;;
      --since|--until|--model|--rev) ;;
      *)
        if [[ "$command" == completions ]]; then
          choices='bash zsh fish'
        elif [[ "$command" == analyze || "$command" == analyze-many || "$command" == extract ]]; then
          return 0
        fi
        ;;
    esac
  fi
  if [[ -n "$choices" ]]; then
    COMPREPLY=( $(compgen -W "$choices" -- "$cur") )
    for ((i=0; i<\${#COMPREPLY[@]}; i++)); do COMPREPLY[i]+=" "; done
  fi
  # Bash 3.2 has no compopt. Only path contexts leave replies empty for native filename fallback.
  (("\${#COMPREPLY[@]}")) || COMPREPLY=("$cur")
  return 0
}
complete -o default -o nospace -F _deeds deeds
`;
}

function zsh(commands: readonly Command[]): string {
  const specs = (c: Command) => flags(c).map((flag) => {
    if (CHOICES[flag]) return quote(`${flag}:value:(${CHOICES[flag]})`);
    if (FILE_FLAGS[flag]) return quote(`${flag}:path:_files`);
    if (VALUE_FLAGS[flag]) return quote(`${flag}:value:`);
    return quote(flag);
  });
  const positional = (name: string) => {
    if (name === "completions") return quote("1:shell:(bash zsh fish)");
    if (name === "analyze" || name === "extract") return quote("1:repository:_files -/");
    if (name === "analyze-many") return quote("1:list file:_files");
    return "";
  };
  return `#compdef deeds
_deeds() {
  local context state state_descr line
  typeset -A opt_args
  local -a filtered
  local -i i cursor=$CURRENT original_current=$CURRENT
  for ((i=1; i<=\${#words}; i++)); do
    if ((i != original_current)) && [[ "\${words[i]}" == --json || "\${words[i]}" == --allow-unsandboxed ]]; then continue; fi
    filtered+=("\${words[i]}")
    if ((i == original_current)); then cursor=\${#filtered}; fi
  done
  local -a words=("\${filtered[@]}")
  local -i CURRENT=$cursor
  local -a commands
  commands=(
${commands.map((c) => `    ${quote(`${c.name}:${c.summary}`)}`).join("\n")}
  )
  _arguments -C '--json' '--allow-unsandboxed' '(-h --help)'{-h,--help}'[Show help]' '1:command:->command' '*::argument:->args'
  case "$state" in
    command) _describe 'command' commands ;;
    args)
      case "$line[1]" in
${commands.map((c) => `        ${c.name}) _arguments ${[...specs(c), positional(c.name)].filter(Boolean).join(" ")} ;;`).join("\n")}
      esac
      ;;
  esac
}
compdef _deeds deeds
`;
}

function fish(commands: readonly Command[]): string {
  const names = commands.map((c) => c.name).join(" ");
  const lines = [
    "# Fish completion for deeds. Source this file in your shell.",
    "complete -c deeds -e",
    `function __deeds_command_is
    for word in (commandline -pxc)[2..]
        switch $word
            case ${GLOBAL_FLAGS.join(" ")}
                continue
        end
        contains -- "$word" $argv
        return $status
    end
    test (count $argv) -eq 0
end`,
    `function __deeds_value_is
    set -l started 0
    set -l pending ''
    for word in (commandline -pxc)[2..]
        switch $word
            case ${GLOBAL_FLAGS.join(" ")}
                continue
        end
        if test $started -eq 0
            set started 1
        else if test -n "$pending"
            set pending ''
        else if contains -- "$word" ${Object.keys(VALUE_FLAGS).join(" ")}
            set pending $word
        end
    end
    test -n "$pending"; or return 1
    test (count $argv) -eq 0; and return 0
    contains -- "$pending" $argv
end`,
    `complete -c deeds -n '__deeds_command_is' -f -a ${quote(names)}`,
    "complete -c deeds -l json -f -d 'Print JSON'",
    "complete -c deeds -l allow-unsandboxed -f -d 'Allow the in-process network guard'",
    "complete -c deeds -n '__deeds_command_is' -s h -l help -f -d 'Show help'",
  ];
  for (const command of commands) {
    const condition = quote(`__deeds_command_is ${command.name}`);
    for (const flag of flags(command).filter((f) => !GLOBAL_FLAGS.includes(f))) {
      let spec = `complete -c deeds -n ${condition} -l ${flag.slice(2)}`;
      if (VALUE_FLAGS[flag]) spec += " -r";
      if (!FILE_FLAGS[flag]) spec += " -f";
      if (CHOICES[flag]) spec += ` -a ${quote(CHOICES[flag])}`;
      lines.push(spec);
      if (VALUE_FLAGS[flag]) {
        const valueCondition = quote(`__deeds_command_is ${command.name}; and __deeds_value_is ${flag}`);
        if (CHOICES[flag]) lines.push(`complete -c deeds -n ${valueCondition} -f -a ${quote(CHOICES[flag])}`);
        else if (flag === "--out") lines.push(`complete -c deeds -n ${valueCondition} -f -a '(__fish_complete_directories)'`);
        else if (FILE_FLAGS[flag]) lines.push(`complete -c deeds -n ${valueCondition} -F`);
        else lines.push(`complete -c deeds -n ${valueCondition} -f`);
      }
    }
    if (command.name === "completions") lines.push(`complete -c deeds -n ${condition} -f -a 'bash zsh fish'`);
    else if (command.name === "analyze" || command.name === "extract") lines.push(`complete -c deeds -n ${quote(`__deeds_command_is ${command.name}; and not __deeds_value_is`)} -f -a '(__fish_complete_directories)'`);
    else if (command.name !== "analyze-many") lines.push(`complete -c deeds -n ${condition} -f`);
  }
  return lines.join("\n") + "\n";
}

/** Emit an offline, sourceable completion script. Tab completion never starts deeds. */
const completions: Command = {
  name: "completions",
  pure: true,
  summary: "Print shell completion for Bash, Zsh, or Fish.",
  usage: "deeds completions <bash|zsh|fish> [--json]",
  run(ctx) {
    const [shell] = ctx.args;
    if (ctx.args.length !== 1 || (shell !== "bash" && shell !== "zsh" && shell !== "fish")) {
      throw new DeedsError("usage", "run deeds completions bash, zsh, or fish", EXIT.usage);
    }
    let script: string;
    switch (shell) {
      case "bash": script = bash(ctx.commands); break;
      case "zsh": script = zsh(ctx.commands); break;
      case "fish": script = fish(ctx.commands); break;
    }
    return { data: { shell, script }, text: script };
  },
};

export default completions;

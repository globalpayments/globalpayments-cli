import type { Command } from 'commander';
import { runCommand } from '../contract/emit.js';
import { ERROR_CODES, GlobalPaymentsError } from '../contract/errors.js';
import { Catalog } from '../shell/catalog.js';
import { loadCompletionData } from '../shell/completion-data.js';
import { quoteArg } from '../shell/tokenize.js';

/**
 * Tab completion for bash, zsh and fish.
 *
 * The scripts are thin: on every Tab they call `globalpayments __complete`, which
 * answers from the same engine as the interactive shell's palette. So shell
 * completion knows every command, flag, pack id, case address, webhook event and
 * matching file, and can never drift from the real command tree.
 */
export const SHELLS = ['bash', 'zsh', 'fish'] as const;
export type ShellName = (typeof SHELLS)[number];

const BASH = `# globalpayments completion for bash (3.2 and later)
# Add to ~/.bashrc:   eval "$(globalpayments completion bash)"
_globalpayments_complete() {
  # Split the line ourselves: COMP_WORDS breaks case addresses apart at the colon.
  local line="\${COMP_LINE:0:COMP_POINT}"
  local -a words
  read -ra words <<< "$line"
  local cur=""
  if [[ "$line" != *[[:space:]] && \${#words[@]} -gt 0 ]]; then
    cur="\${words[\${#words[@]}-1]}"
    unset "words[\${#words[@]}-1]"
  fi
  local -a args=("\${words[@]:1}")
  local candidates
  candidates=$(globalpayments __complete --shell bash -- "\${args[@]}" "$cur" 2>/dev/null) || return 0
  # Filter by hand: compgen -W would expand $(...) hidden in a file name.
  COMPREPLY=()
  local c
  while IFS= read -r c; do
    [[ -n "$c" && "$c" == "$cur"* ]] && COMPREPLY[\${#COMPREPLY[@]}]="$c"
  done <<< "$candidates"
  # Bash only replaces the text after the last colon, so drop what it keeps.
  if [[ "$cur" == *:* && "$COMP_WORDBREAKS" == *:* ]]; then
    local prefix="\${cur%"\${cur##*:}"}"
    local i
    for i in "\${!COMPREPLY[@]}"; do
      COMPREPLY[$i]="\${COMPREPLY[$i]#"$prefix"}"
    done
  fi
}
complete -o default -F _globalpayments_complete globalpayments
`;

const ZSH = `#compdef globalpayments
# globalpayments completion for zsh
# Either add to ~/.zshrc:   eval "$(globalpayments completion zsh)"
# or save it on your fpath: globalpayments completion zsh > "\${fpath[1]}/_globalpayments"
_globalpayments() {
  local -a candidates
  candidates=("\${(@f)$(globalpayments __complete --shell zsh -- "\${(@)words[2,CURRENT-1]}" "\${words[CURRENT]}" 2>/dev/null)}")
  candidates=("\${(@)candidates:#}")
  (( \${#candidates} )) || { _files; return }
  _describe -t globalpayments 'globalpayments' candidates
}
if [[ "\${funcstack[1]}" = "_globalpayments" ]]; then
  _globalpayments "$@"
else
  (( \${+functions[compdef]} )) && compdef _globalpayments globalpayments
fi
`;

const FISH = `# globalpayments completion for fish
# Save it:   globalpayments completion fish > ~/.config/fish/completions/globalpayments.fish
function __globalpayments_complete
    set -l tokens (commandline -opc)
    set -e tokens[1]
    set -l cur (commandline -ct)
    globalpayments __complete --shell fish -- $tokens "$cur" 2>/dev/null
end
complete -c globalpayments -f -a '(__globalpayments_complete)'
`;

export function completionScript(shell: ShellName): string {
  return shell === 'bash' ? BASH : shell === 'zsh' ? ZSH : FISH;
}

/**
 * Candidates for the last word, given the words before it. Shells complete one
 * word at a time, so a command path like "api get" is offered word by word, and
 * the interactive shell's own built-ins are left out.
 */
export async function completeWords(root: Command, words: string[], shell: ShellName | 'plain' = 'plain'): Promise<string[]> {
  const data = await loadCompletionData().catch(() => ({ packIds: [], caseAddresses: [] }));
  const catalog = new Catalog(root, { packIds: () => data.packIds, caseAddresses: () => data.caseAddresses });
  const current = words[words.length - 1] ?? '';
  const before = words.slice(0, -1).map(quoteArg);
  const line = [...before, current].join(' ');
  const set = catalog.suggest(line, line.length);
  if (!set) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of set.items) {
    if (item.kind === 'builtin') continue;
    let value = item.value;
    let description = item.description ?? '';
    if (item.kind === 'command' && value.includes(' ')) {
      // Offer the next word of a multi-word path, described by its group.
      value = value.split(' ')[0]!;
      const group = root.commands.find((command) => command.name() === value);
      description = group?.description() ?? description;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    const oneLine = description.replace(/\s+/g, ' ').trim();
    if (shell === 'zsh') out.push(oneLine ? `${value.replace(/:/g, '\\:')}:${oneLine}` : value.replace(/:/g, '\\:'));
    else if (shell === 'fish') out.push(oneLine ? `${value}\t${oneLine}` : value);
    else out.push(value);
  }
  return out;
}

export function registerCompletionCommands(program: Command): void {
  program
    .command('completion')
    .argument('<shell>', 'bash, zsh or fish')
    .description('Print a Tab-completion script for bash, zsh or fish')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (shell: string, options: { json?: boolean }) => {
      await runCommand<{ shell: ShellName; script: string }>('completion', { json: options.json }, async () => {
        const name = shell.toLowerCase();
        if (!(SHELLS as readonly string[]).includes(name)) {
          throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, `Unsupported shell "${shell}".`, {
            remediation: 'Use bash, zsh or fish.',
            details: { supported: [...SHELLS] }
          });
        }
        return {
          data: { shell: name as ShellName, script: completionScript(name as ShellName) },
          // Raw script on stdout so it can be eval'd or redirected straight into a file.
          render: (data) => process.stdout.write(data.script)
        };
      });
    });

  program
    .command('__complete', { hidden: true })
    .description('Completion candidates for shell scripts (internal)')
    .option('--shell <name>', 'bash, zsh, fish or plain', 'plain')
    .argument('[words...]', 'Words typed so far, the last one being completed')
    .allowUnknownOption()
    .action(async (words: string[], options: { shell: string }, command: Command) => {
      const root = command.parent ?? program;
      const shell = (SHELLS as readonly string[]).includes(options.shell) ? (options.shell as ShellName) : 'plain';
      try {
        const candidates = await completeWords(root, words.length > 0 ? words : [''], shell);
        if (candidates.length > 0) process.stdout.write(`${candidates.join('\n')}\n`);
      } catch {
        // Completion must never print an error into someone's prompt.
      }
    });
}

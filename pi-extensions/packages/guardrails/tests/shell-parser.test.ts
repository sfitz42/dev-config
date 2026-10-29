import { describe, expect, test } from 'vitest'

import { parseShell, ShellParseError } from '../src/shell/shell-parser.ts'
import { collectAssignments, walkCommands } from '../src/shell/shell-walk.ts'
import { staticText } from '../src/shell/shell-words.ts'

import type { Redirect, Word } from '../src/shell/shell-ast.ts'

/** `${` for shell text, without tripping the template-literal lint. */
const BRACE = '$' + '{'

/** Each simple command's argv as display text, in visit order. */
function commands (source: string): string[][] {
  const out: string[][] = []
  walkCommands(parseShell(source), ({ command }) => {
    if (command !== undefined) {
      out.push(command.words.map(display))
    }
  })
  return out
}

function display (word: Word): string {
  return word.parts.map((part) => {
    switch (part.kind) {
      case 'literal':
        return part.value
      case 'parameter':
        return `$${part.name}`
      case 'command-substitution':
        return '$(..)'
      case 'process-substitution':
        return `${part.direction}(..)`
      case 'arithmetic':
        return '$((..))'
    }
    return ''
  }).join('')
}

function redirects (source: string): string[] {
  const out: string[] = []
  walkCommands(parseShell(source), ({ redirects: items }) => {
    for (const item of items) {
      out.push(`${item.fd ?? ''}${item.operator}${display(item.target)}`)
    }
  })
  return out
}

function heredocs (source: string): Redirect[] {
  const out: Redirect[] = []
  walkCommands(parseShell(source), ({ redirects: items }) => {
    out.push(...items.filter((item) => item.heredoc !== undefined))
  })
  return out
}

describe('words and quoting', () => {
  test.each([
    ['ls -la', [['ls', '-la']]],
    ["echo 'a b' \"c d\" e\\ f", [['echo', 'a b', 'c d', 'e f']]],
    ['cat .e""nv', [['cat', '.env']]],
    ["cat .e''nv", [['cat', '.env']]],
    ['cat .\\env', [['cat', '.env']]],
    ["echo $'rm\\x20-rf\\t/'", [['echo', 'rm -rf\t/']]],
    ['echo $"hi"', [['echo', 'hi']]],
    ['rm \\\n  -rf /tmp/x', [['rm', '-rf', '/tmp/x']]],
    ['ls # rm -rf /', [['ls']]],
    ['echo a#b', [['echo', 'a#b']]],
    ['ls @(a|b) !(c)', [['ls', '@(a|b)', '!(c)']]],
    ['echo {a,b}/c', [['echo', '{a,b}/c']]],
    [`echo "$HOME/x" ${BRACE}HOME}`, [['echo', '$HOME/x', '$HOME']]],
    ['echo $1 $@ $? $$', [['echo', '$1', '$@', '$?', '$$']]],
    ['echo $ end$', [['echo', '$', 'end$']]],
    ['echo "a\\"b" "\\$x"', [['echo', 'a"b', '$x']]]
  ])('%j', (source, expected) => {
    expect(commands(source)).toEqual(expected)
  })
})

describe('lists and pipelines', () => {
  test('visits every command joined by operators', () => {
    expect(commands('a && b || c; d & e | f |& g\nh')).toEqual([
      ['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g'], ['h']
    ])
  })

  test('handles negation and time', () => {
    expect(commands('! time -p rm -rf x')).toEqual([['rm', '-rf', 'x']])
  })

  test('allows newlines after operators', () => {
    expect(commands('a &&\n  b |\n  c')).toEqual([['a'], ['b'], ['c']])
  })
})

describe('substitutions', () => {
  test.each([
    ['echo "$(rm -rf /)"', [['echo', '$(..)'], ['rm', '-rf', '/']]],
    ['echo `whoami`', [['echo', '$(..)'], ['whoami']]],
    ['echo "`id`"', [['echo', '$(..)'], ['id']]],
    ['echo $(echo $(id))', [['echo', '$(..)'], ['echo', '$(..)'], ['id']]],
    ['diff <(ls a) >(cat)', [['diff', '<(..)', '>(..)'], ['ls', 'a'], ['cat']]],
    [`echo ${BRACE}x:-$(id)}`, [['echo', '$x'], ['id']]],
    ['echo $(( $(id) + 1 ))', [['echo', '$((..))'], ['id']]],
    ['echo $((ls) )', [['echo', '$(..)'], ['ls']]],
    ['A=$(id) cmd', [['cmd'], ['id']]],
    ['a=(x $(id))', [[], ['id']]],
    ['cat < "$(id)"', [['cat'], ['id']]],
    ['[[ -f $(id) ]]', [['id']]],
    ['for f in $(ls); do echo $f; done', [['ls'], ['echo', '$f']]],
    ['case $(id) in x) y;; esac', [['id'], ['y']]]
  ])('%j', (source, expected) => {
    expect(commands(source)).toEqual(expected)
  })

  test('marks commands that run inside a substitution', () => {
    const seen: [string, boolean][] = []
    walkCommands(parseShell('cat $(echo .env)'), ({ command, inSubstitution }) => {
      const [name] = command?.words ?? []
      if (name !== undefined) {
        seen.push([display(name), inSubstitution])
      }
    })
    expect(seen).toEqual([['cat', false], ['echo', true]])
  })
})

describe('compound commands', () => {
  test.each([
    ['if a; then b; elif c; then d; else e; fi', [['a'], ['b'], ['c'], ['d'], ['e']]],
    ['while a; do b; done', [['a'], ['b']]],
    ['until a\ndo\n  b\ndone', [['a'], ['b']]],
    ['for x in 1 2; do echo $x; done', [['echo', '$x']]],
    ['for x; do echo; done', [['echo']]],
    ['for ((i=0; i<3; i++)); do echo; done', [['echo']]],
    ['select x in a b; do echo; done', [['echo']]],
    ['case $x in a|b) one;; (c) two;& *) three;;& esac', [['one'], ['two'], ['three']]],
    ['f() { rm -rf x; }', [['rm', '-rf', 'x']]],
    ['function g { id; }', [['id']]],
    ['function h() ( id )', [['id']]],
    ['{ a; b; }', [['a'], ['b']]],
    ['( a; b )', [['a'], ['b']]],
    ['[[ $a =~ ^(x|y)$ && -n $b ]]', []],
    ['(( i += 1 ))', []],
    ['coproc cat', [['cat']]],
    ['echo } {', [['echo', '}', '{']]]
  ])('%j', (source, expected) => {
    expect(commands(source)).toEqual(expected)
  })
})

describe('redirects', () => {
  test.each([
    ['echo hi > out 2>&1 &>> log < in', ['>out', '2>&1', '&>>log', '<in']],
    ['cmd >| f <> g 3< h', ['>|f', '<>g', '3<h']],
    ['{ a; } > out', ['>out']],
    ['cmd {fd}> out', ['>out']],
    ['cat <<< "$x"', ['<<<$x']]
  ])('%j', (source, expected) => {
    expect(redirects(source)).toEqual(expected)
  })

  test('reads a heredoc body without treating it as commands', () => {
    const source = 'cat <<EOF\nrm -rf /\nEOF\nls'
    expect(commands(source)).toEqual([['cat'], ['ls']])
    expect(heredocs(source)[0]?.heredoc?.body).toBe('rm -rf /\n')
  })

  test('finds substitutions inside an unquoted heredoc body', () => {
    expect(commands('cat <<EOF\n$(id) `whoami`\nEOF')).toEqual([
      ['cat'], ['id'], ['whoami']
    ])
  })

  test('ignores substitutions in a quoted heredoc body', () => {
    expect(commands("cat <<'EOF'\n$(id)\nEOF")).toEqual([['cat']])
  })

  test('strips leading tabs for <<-', () => {
    const [redirect] = heredocs('cat <<-END\n\tx\n\tEND\necho')
    expect(redirect?.heredoc?.body).toBe('\tx\n')
  })

  test('reads several heredocs in order', () => {
    const bodies = heredocs('cat <<A <<B\na\nA\nb\nB')
      .map((item) => item.heredoc?.body)
    expect(bodies).toEqual(['a\n', 'b\n'])
  })
})

describe('fails closed', () => {
  test.each([
    'echo "unterminated',
    "echo 'unterminated",
    'echo $(id',
    'echo `id',
    'echo ${x',
    'if a; then b',
    'while a; do b',
    'for x in a',
    'case x in a) b',
    '[[ -f x',
    '( a',
    'a )',
    '&& b',
    'a |',
    'a ;; b',
    'echo >',
    'fi',
    'cat <(ls',
    'x=(a b',
    `${'( '.repeat(200)}a${' )'.repeat(200)}`,
    `${'$('.repeat(200)}a${')'.repeat(200)}`
  ])('%j', (source) => {
    expect(() => parseShell(source)).toThrow(ShellParseError)
  })
})

describe('assignments', () => {
  test('collects static values in order', () => {
    const script = parseShell(
      'F=.env; export G=~/x; cat $F; F=other; local H=$(id)'
    )
    const values = collectAssignments(script, (word) =>
      staticText(word, { home: '/home/u' }))
    expect(values.get('F')).toEqual(['.env', 'other'])
    expect(values.get('G')).toEqual(['/home/u/x'])
    expect(values.has('H')).toBe(false)
  })
})

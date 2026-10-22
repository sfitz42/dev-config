import { describe, expect, test } from 'vitest'

import { parseShell } from '../src/shell/shell-parser.ts'
import { evaluateWord, expandBraces } from '../src/shell/shell-words.ts'

import type { Word } from '../src/shell/shell-ast.ts'
import type { EvaluateOptions } from '../src/shell/shell-words.ts'

/** `${` for shell text, without tripping the template-literal lint. */
const BRACE = '$' + '{'

function argument (source: string): Word {
  const [statement] = parseShell(source).statements
  const command = statement?.command
  if (command?.kind !== 'simple' || command.words[1] === undefined) {
    throw new Error(`no argument in ${source}`)
  }
  return command.words[1]
}

const options: EvaluateOptions = {
  home: '/home/u',
  variables: new Map([['F', ['.env']], ['D', ['a', 'b']]])
}

describe('evaluateWord', () => {
  test.each([
    ['cat plain', 'plain', false, false],
    ['cat ~', '/home/u', false, false],
    ['cat ~/x', '/home/u/x', false, false],
    ['cat "~/x"', '~/x', false, false],
    ['cat ~root/x', '~root/x', true, true],
    ['cat $F', '.env', false, false],
    ['cat $UNSET/x', '$UNSET/x', true, true],
    ['cat x/$UNSET', 'x/$UNSET', true, false],
    [`cat ${BRACE}F:-y}`, `${BRACE}F}`, true, true],
    ['cat $(id)/x', '$(...)/x', true, true]
  ])('%j', (source, text, unresolved, prefix) => {
    const [value] = evaluateWord(argument(source), options)
    expect(value).toMatchObject({
      text, unresolved, unresolvedPrefix: prefix
    })
  })

  test('yields one result per known value', () => {
    expect(evaluateWord(argument('cat $D/x'), options).map((v) => v.text))
      .toEqual(['a/x', 'b/x'])
  })

  test('detects unquoted globs only', () => {
    expect(evaluateWord(argument('cat .en*'))[0]?.hasGlob).toBe(true)
    expect(evaluateWord(argument("cat '.en*'"))[0]?.hasGlob).toBe(false)
  })
})

describe('expandBraces', () => {
  test.each([
    ['plain', ['plain']],
    ['{a,b}/c', ['{a,b}/c', 'a/c', 'b/c']],
    ['x{1..3}', ['x{1..3}', 'x1', 'x2', 'x3']],
    ['{/etc,~}/{passwd,shadow}', [
      '{/etc,~}/{passwd,shadow}',
      '/etc/{passwd,shadow}',
      '~/{passwd,shadow}',
      '/etc/passwd',
      '/etc/shadow',
      '~/passwd',
      '~/shadow'
    ]],
    ['{single}', ['{single}']]
  ])('%j', (text, expected) => {
    expect(expandBraces(text)).toEqual(expected)
  })

  test('caps the number of results', () => {
    expect(expandBraces('{1..9}{1..9}{1..9}').length).toBeLessThanOrEqual(64)
  })
})

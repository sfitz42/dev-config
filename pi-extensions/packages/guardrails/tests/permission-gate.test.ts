import { describe, expect, test } from 'vitest'

import { DEFAULT_CONFIG } from '../src/config/config-defaults.ts'
import {
  assessCommand,
  sessionGrant
} from '../src/permission-gate/gate-check.ts'

import type { GateSettings } from '../src/permission-gate/gate-check.ts'

const options = { cwd: '/work', home: '/home/u' }

/** `${` for shell text, without tripping the template-literal lint. */
const BRACE = '$' + '{'

function assess (
  command: string,
  settings: Partial<GateSettings> = {}
): string {
  const decision = assessCommand(command, {
    ...DEFAULT_CONFIG.permissionGate, ...settings
  }, options)
  return decision.kind === 'dangerous'
    ? decision.finding.description
    : decision.kind
}

describe('built-in matchers', () => {
  test.each([
    ['rm -rf build', 'recursive force delete'],
    ['rm -r -f build', 'recursive force delete'],
    ['rm --recursive --force build', 'recursive force delete'],
    ['sudo ls', 'superuser command'],
    ['doas ls', 'privileged command execution'],
    ['dd if=/dev/zero of=/dev/sda', 'disk write operation'],
    ['mkfs.ext4 /dev/sda1', 'filesystem format'],
    ['chmod -R 777 .', 'insecure recursive permissions'],
    ['chmod -R o+w .', 'insecure recursive permissions'],
    ['chown -R me .', 'recursive ownership change'],
    ['shred secret', 'secure file overwrite'],
    ['parted /dev/sda', 'disk partitioning'],
    ['docker run --privileged img', 'container with privileged mode'],
    ['podman container run --pid=host img', 'container with host PID namespace']
  ])('%j', (command, description) => {
    expect(assess(command)).toBe(description)
  })

  test.each([
    'ls -la',
    'rm -r build',
    'rm -f file',
    'rm -- -rf',
    'git status',
    'echo rm -rf /',
    "grep -r 'sudo' docs",
    'chmod -R 755 .',
    'chmod -R +w .',
    'docker run img',
    'docker build --network host .'
  ])('allows %j', (command) => {
    expect(assess(command)).toBe('allow')
  })
})

// Each of these got past the upstream gate.
describe('bypasses closed', () => {
  test.each([
    ['/bin/rm -rf /tmp/x', 'path to the binary'],
    ['\\rm -rf x', 'escaped name'],
    ['command rm -rf x', 'command wrapper'],
    ['env FOO=1 rm -rf x', 'env wrapper'],
    ['nice -n 5 rm -rf x', 'nice wrapper'],
    ['timeout 5 rm -rf x', 'timeout wrapper'],
    ['nohup rm -rf x &', 'nohup wrapper'],
    ['exec rm -rf x', 'exec builtin'],
    ['ls | xargs rm -rf', 'xargs'],
    ['bash -c "rm -rf x"', 'bash -c'],
    ["sh -lc 'rm -rf x'", 'grouped -c flag'],
    ['eval "rm -rf x"', 'eval'],
    ['find . -name x -exec rm -rf {} \\;', 'find -exec'],
    ['watch rm -rf x', 'watch'],
    ['ssh host rm -rf /', 'remote command'],
    ['R=rm; $R -rf x', 'command name in a variable'],
    ['{rm,x} -rf y', 'brace expansion'],
    ['cat <<EOF\n$(rm -rf x)\nEOF', 'unquoted heredoc substitution'],
    [`echo ${BRACE}y:-$(rm -rf x)}`, 'parameter operand substitution'],
    ['docker run --pid host img', 'space-separated host namespace'],
    ['docker run -v /:/host img', 'space-separated root mount'],
    ['docker run --volume /var/run/docker.sock:/s img', 'socket mount']
  ])('%j (%s)', (command) => {
    expect(assess(command)).not.toBe('allow')
  })

  test('treats a runtime command name as dangerous', () => {
    expect(assess('$CMD -rf x')).toBe('command name is only known at runtime')
  })

  test('treats unparseable text as dangerous', () => {
    expect(assess('echo "unterminated')).toBe('command could not be parsed')
    expect(assess("bash -c 'echo \"x'")).toBe(
      'nested command could not be parsed')
  })
})

describe('allowed and auto-deny patterns', () => {
  test('an allowed pattern only covers the command it matches', () => {
    const allowedPatterns = [{ pattern: 'rm -rf node_modules' }]
    expect(assess('rm -rf node_modules', { allowedPatterns })).toBe('allow')
    expect(assess('rm -rf node_modules; rm -rf ~', { allowedPatterns }))
      .toBe('recursive force delete')
    expect(assess('npm test && sudo reboot', {
      allowedPatterns: [{ pattern: 'npm test' }]
    })).toBe('superuser command')
  })

  test('a session grant allows exactly that whole command', () => {
    const command = 'cd x && rm -rf build'
    const allowedPatterns = [sessionGrant(command)]
    expect(assess(command, { allowedPatterns })).toBe('allow')
    expect(assess(`${command}; rm -rf ~`, { allowedPatterns }))
      .toBe('recursive force delete')
  })

  test('auto-deny wins over allowed patterns', () => {
    expect(assess('git push --force', {
      allowedPatterns: [{ pattern: 'git push' }],
      autoDenyPatterns: [{ pattern: '--force' }]
    })).toBe('deny')
  })

  test('auto-deny regexes see each command in a list', () => {
    expect(assess('cd repo && git push origin main', {
      autoDenyPatterns: [{ pattern: '^git push', regex: true }]
    })).toBe('deny')
  })
})

describe('custom patterns', () => {
  test('adds substring patterns to the built-ins', () => {
    expect(assess('terraform apply', {
      patterns: [
        ...DEFAULT_CONFIG.permissionGate.patterns,
        { pattern: 'terraform apply', description: 'infra change' }
      ]
    })).toBe('infra change')
  })

  test('customPatterns replace the built-in matchers', () => {
    const settings = {
      patterns: [{ pattern: 'deploy', description: 'deploy' }],
      useBuiltinMatchers: false
    }
    expect(assess('rm -rf x', settings)).toBe('allow')
    expect(assess('make deploy', settings)).toBe('deploy')
  })
})

import { getSettingsListTheme } from '@earendil-works/pi-coding-agent'
import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui'

import {
  addDangerousPattern,
  addPolicyRule,
  COMMAND_PRESETS,
  POLICY_PRESETS
} from './presets.ts'
import { Choice, isDown, isUp, step, Wizard, wrap } from './widgets.ts'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Component, SettingsListTheme } from '@earendil-works/pi-tui'

import type { GuardrailsConfig } from '../config/config-schema.ts'
import type { Runtime } from '../runtime.ts'

interface Selection {
  scope: 'local' | 'global'
  policies: Set<number>
  commands: Set<number>
}

const VISIBLE = 7

/** A scrolling checklist; Space or Enter toggles, Tab moves on. */
class Checklist implements Component {
  private selected = 0
  private offset = 0

  constructor (
    private readonly title: string,
    private readonly items: readonly { label: string, description: string }[],
    private readonly checked: Set<number>,
    private readonly theme: SettingsListTheme
  ) {}

  invalidate (): void {}

  render (width: number): string[] {
    const end = Math.min(this.items.length, this.offset + VISIBLE)
    const lines = [
      this.theme.label(`  ${this.title}`, true),
      this.theme.hint(`  ${this.checked.size} selected · ` +
        `${this.offset + 1}-${end} of ${this.items.length} · Space toggles · Tab next`),
      ''
    ]
    for (let i = this.offset; i < end; i++) {
      const item = this.items[i]
      if (item !== undefined) {
        const mark = this.checked.has(i) ? '[x]' : '[ ]'
        lines.push((i === this.selected ? this.theme.cursor : '  ') +
          `${mark} ${this.theme.value(item.label, i === this.selected)}`)
      }
    }
    const description = this.items[this.selected]?.description ?? ''
    return [...lines, '', ...wrap(description, Math.max(20, width - 4))
      .map((line) => this.theme.description(`  ${truncateToWidth(line, width)}`))]
  }

  handleInput (data: string): void {
    if (isUp(data) || isDown(data)) {
      const delta = isUp(data) ? -1 : 1
      this.selected = step(this.selected, this.items.length, delta)
      this.offset = Math.min(Math.max(this.offset, this.selected - VISIBLE + 1),
        this.selected)
    } else if (data === ' ' || matchesKey(data, Key.enter)) {
      if (!this.checked.delete(this.selected)) {
        this.checked.add(this.selected)
      }
    }
  }
}

class Review implements Component {
  constructor (
    private readonly selection: Selection,
    private readonly paths: Readonly<Record<'local' | 'global', string>>,
    private readonly theme: SettingsListTheme,
    private readonly next: () => void
  ) {}

  invalidate (): void {}

  render (): string[] {
    const { scope, policies, commands } = this.selection
    const empty = policies.size + commands.size === 0
    return [
      this.theme.hint(`  Save to: ${this.paths[scope]}`),
      this.theme.hint(`  File policies: ${policies.size}`),
      ...[...policies].sort((a, b) => a - b).map((i) =>
        `    - ${POLICY_PRESETS[i]?.label ?? ''}`),
      this.theme.hint(`  Dangerous commands: ${commands.size}`),
      ...[...commands].sort((a, b) => a - b).map((i) =>
        `    - ${COMMAND_PRESETS[i]?.label ?? ''}`),
      '',
      this.theme.hint(empty
        ? '  Select at least one preset first.'
        : '  Enter to add these to the config.')
    ]
  }

  handleInput (data: string): void {
    if (matchesKey(data, Key.enter) &&
      this.selection.policies.size + this.selection.commands.size > 0) {
      this.next()
    }
  }
}

/** Adds the selected presets to a scope's config. */
function applySelection (
  base: GuardrailsConfig | undefined,
  selection: Selection
): GuardrailsConfig {
  let next = structuredClone(base ?? {})
  for (const index of [...selection.policies].sort((a, b) => a - b)) {
    const preset = POLICY_PRESETS[index]
    if (preset !== undefined) {
      next = addPolicyRule(next, preset.rule)
    }
  }
  for (const index of [...selection.commands].sort((a, b) => a - b)) {
    const preset = COMMAND_PRESETS[index]
    if (preset !== undefined) {
      next = addDangerousPattern(next, preset.pattern)
    }
  }
  return next
}

/**
 * Registers `/guardrails:examples`, which adds preset rules and command
 * patterns to the project or global config without replacing anything.
 *
 * @param pi - The extension API.
 * @param runtime - Config access.
 */
function registerExamplesCommand (pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerCommand('guardrails:examples', {
    description: 'Add example guardrails policies and command patterns',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') {
        return
      }
      await runtime.ensureLoaded(ctx)
      const theme = getSettingsListTheme()
      const paths = {
        local: runtime.loader.localPath(ctx.cwd) ?? '.pi/extensions/guardrails.json',
        global: runtime.loader.globalPath
      }
      const selection: Selection = {
        scope: 'local', policies: new Set(), commands: new Set()
      }
      const applied = await ctx.ui.custom<boolean>(
        (_tui, _theme, _keybindings, done) => new Wizard({
          title: 'Guardrails examples',
          theme,
          steps: [
            {
              label: 'Scope',
              build: (next) => new Choice({
                title: 'Add the presets to',
                theme,
                items: [
                  { label: 'Project', description: paths.local },
                  { label: 'Global', description: paths.global }
                ],
                onSelect: (index) => {
                  selection.scope = index === 0 ? 'local' : 'global'
                  next()
                }
              })
            },
            {
              label: 'Files',
              optional: true,
              build: () => new Checklist('File policy presets', POLICY_PRESETS,
                selection.policies, theme)
            },
            {
              label: 'Commands',
              optional: true,
              build: () => new Checklist('Dangerous command presets',
                COMMAND_PRESETS, selection.commands, theme)
            },
            {
              label: 'Review',
              build: (next) => new Review(selection, paths, theme, next)
            }
          ],
          onFinish: () => done(true),
          onCancel: () => done(false)
        }),
        { overlay: true })
      if (!applied) {
        ctx.ui.notify('No guardrails examples added.', 'warning')
        return
      }
      const { scope } = selection
      await runtime.loader.save(scope,
        applySelection(runtime.loader.raw(scope), selection))
      runtime.notifyChanged()
      ctx.ui.notify(`Guardrails examples added to ${paths[scope]}.`, 'info')
    }
  })
}

export { applySelection, registerExamplesCommand }

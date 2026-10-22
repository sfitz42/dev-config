import { getSettingsListTheme } from '@earendil-works/pi-coding-agent'
import { Key, matchesKey, SettingsList } from '@earendil-works/pi-tui'

import { addPolicyRule, toKebabCase } from './presets.ts'
import {
  Choice,
  Confirm,
  PathListEditor,
  PatternEditor,
  TextField,
  Wizard
} from './widgets.ts'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type {
  Component,
  SettingItem,
  SettingsListTheme,
  TUI
} from '@earendil-works/pi-tui'

import type { ResolvedConfig } from '../config/config-defaults.ts'
import type {
  ConfigScope,
  FeatureId,
  GuardrailsConfig,
  PolicyRule,
  Protection
} from '../config/config-schema.ts'
import type { Runtime } from '../runtime.ts'

type Done = (value?: string) => void

const SCOPES: readonly ConfigScope[] = ['memory', 'local', 'global']
const SCOPE_LABELS: Readonly<Record<ConfigScope, string>> = {
  memory: 'Memory', local: 'Local', global: 'Global'
}
interface FeatureText {
  readonly label: string
  readonly description: string
}

const FEATURES: Readonly<Record<FeatureId, FeatureText>> = {
  policies: {
    label: 'Policies', description: 'Block or limit file access with named rules'
  },
  permissionGate: {
    label: 'Permission gate',
    description: 'Confirm dangerous commands (rm -rf, sudo, ...)'
  },
  pathAccess: {
    label: 'Path access',
    description: 'Ask before tools touch paths outside the working directory'
  }
}
const PROTECTIONS: readonly Protection[] = ['noAccess', 'readOnly', 'none']

function heading (label: string): SettingItem {
  return { id: `heading:${label}`, label: `── ${label} ──`, currentValue: '' }
}

function onOff (value: boolean | undefined, inherited: boolean): string {
  return value === undefined
    ? `inherited: ${inherited ? 'on' : 'off'}`
    : value ? 'on' : 'off'
}

function count (items: readonly unknown[] | undefined): string {
  return `${items?.length ?? 0} items`
}

/** Editor for one policy rule, as a nested settings list. */
function ruleEditor (
  getRule: () => PolicyRule | undefined,
  update: (change: (rule: PolicyRule) => PolicyRule | undefined) => void,
  theme: SettingsListTheme,
  done: Done
): Component {
  const text = (
    id: string,
    label: string,
    read: (rule: PolicyRule) => string | undefined,
    write: (rule: PolicyRule, value: string) => PolicyRule
  ): SettingItem => ({
    id,
    label,
    currentValue: read(getRule() ?? emptyRule()) ?? '',
    submenu: (_value, close) => new TextField(label,
      read(getRule() ?? emptyRule()) ?? '', theme, (value) => {
        if (value !== undefined) {
          update((rule) => write(rule, value.trim()))
        }
        close(value?.trim())
      })
  })
  const toggle = (id: 'enabled' | 'onlyIfExists' | 'respectCwd',
    label: string): SettingItem => ({
    id,
    label,
    currentValue: getRule()?.[id] === false ? 'off' : 'on',
    values: ['on', 'off']
  })
  const patterns = (id: 'patterns' | 'allowedPatterns', label: string):
  SettingItem => ({
    id,
    label,
    currentValue: count(getRule()?.[id]),
    submenu: (_value, close) => new PatternEditor({
      label,
      items: getRule()?.[id] ?? [],
      theme,
      context: 'file',
      onSave: (items) => update((rule) => ({
        ...rule,
        [id]: id === 'allowedPatterns' && items.length === 0
          ? undefined
          : items
      })),
      onDone: () => close(count(getRule()?.[id]))
    })
  })

  const items: SettingItem[] = [
    text('name', 'Name', (rule) => rule.name,
      (rule, value) => ({ ...rule, name: value === '' ? undefined : value })),
    text('id', 'ID', (rule) => rule.id,
      (rule, value) => value === '' ? rule : { ...rule, id: value }),
    text('description', 'Description', (rule) => rule.description,
      (rule, value) => ({
        ...rule, description: value === '' ? undefined : value
      })),
    {
      id: 'protection',
      label: 'Protection',
      currentValue: getRule()?.protection ?? 'readOnly',
      values: [...PROTECTIONS]
    },
    toggle('enabled', 'Enabled'),
    toggle('onlyIfExists', 'Only if file exists'),
    toggle('respectCwd', 'Skip anchored patterns inside cwd'),
    patterns('patterns', 'Patterns'),
    patterns('allowedPatterns', 'Allowed patterns'),
    text('blockMessage', 'Block message ({file})', (rule) => rule.blockMessage,
      (rule, value) => ({
        ...rule, blockMessage: value === '' ? undefined : value
      })),
    {
      id: 'delete',
      label: 'Delete rule',
      currentValue: '',
      submenu: (_value, close) => new Confirm('Delete this rule?', theme,
        (confirmed) => {
          if (confirmed) {
            update(() => undefined)
            done('deleted')
          } else {
            close()
          }
        })
    }
  ]

  return new SettingsList(items, 14, theme, (id, value) => {
    if (id === 'protection' && PROTECTIONS.includes(value as Protection)) {
      update((rule) => ({ ...rule, protection: value as Protection }))
    } else if (id === 'enabled' || id === 'onlyIfExists' ||
      id === 'respectCwd') {
      update((rule) => ({ ...rule, [id]: value === 'on' }))
    }
  }, () => {
    const rule = getRule()
    done(rule === undefined
      ? 'deleted'
      : `${rule.protection}, ` +
      (rule.enabled === false ? 'disabled' : 'enabled'))
  })
}

function emptyRule (): PolicyRule {
  return { id: '', patterns: [], protection: 'readOnly' }
}

/** Name → protection → patterns, then adds the rule. */
function addRuleWizard (
  theme: SettingsListTheme,
  create: (rule: PolicyRule) => void,
  done: Done
): Component {
  const draft: PolicyRule = {
    ...emptyRule(), onlyIfExists: true, enabled: true
  }
  return new Wizard({
    title: 'Add policy',
    theme,
    steps: [
      {
        label: 'Name',
        build: (next) => new TextField('Policy name (e.g. Secret files)',
          draft.name ?? '', theme, (value) => {
            if (value === undefined) {
              done()
            } else if (value.trim() !== '') {
              draft.name = value.trim()
              draft.id = toKebabCase(value) || 'policy'
              next()
            }
          }, 'Enter continue')
      },
      {
        label: 'Protection',
        build: (next) => new Choice({
          title: 'Protection',
          theme,
          items: [
            { label: 'noAccess', description: 'Block reads and writes.' },
            { label: 'readOnly', description: 'Allow reads, block writes.' },
            { label: 'none', description: 'Match but do not block.' }
          ],
          initial: PROTECTIONS.indexOf(draft.protection),
          onSelect: (index) => {
            draft.protection = PROTECTIONS[index] ?? 'readOnly'
            next()
          }
        })
      },
      {
        label: 'Patterns',
        capturesInput: true,
        build: (next) => new PatternEditor({
          label: 'Files this policy protects (a to add, Esc when done)',
          items: draft.patterns,
          theme,
          context: 'file',
          onSave: (items) => { draft.patterns = items },
          // Esc with no patterns cancels: a rule needs at least one.
          onDone: () => {
            if (draft.patterns.length > 0) {
              next()
            } else {
              done()
            }
          }
        })
      }
    ],
    onFinish: () => {
      create(draft)
      done(`added ${draft.name ?? draft.id}`)
    },
    onCancel: () => done()
  })
}

class SettingsScreen implements Component {
  private tab: ConfigScope
  private list: SettingsList
  private status = ''
  private submenuOpen = false
  private readonly drafts = new Map<ConfigScope, GuardrailsConfig>()
  private readonly dirty = new Set<ConfigScope>()
  private readonly theme = getSettingsListTheme()

  constructor (private readonly options: {
    runtime: Runtime
    loadedFeatures: ReadonlySet<FeatureId>
    tui: TUI
    close: () => void
  }) {
    const { loader } = options.runtime
    for (const scope of SCOPES) {
      this.drafts.set(scope, loader.raw(scope) ?? {})
    }
    this.tab = SCOPES.find((scope) => loader.raw(scope) !== undefined) ??
      'global'
    this.list = this.buildList()
  }

  invalidate (): void {
    this.list.invalidate()
  }

  render (width: number): string[] {
    const tabs = SCOPES.map((scope) => {
      const label = `${SCOPE_LABELS[scope]}${this.dirty.has(scope) ? '*' : ''}`
      return scope === this.tab
        ? this.theme.label(` ${label} `, true)
        : this.theme.hint(` ${label} `)
    }).join(' ')
    const note = this.tab === 'local' && !this.options.runtime.loader.trusted
      ? this.theme.hint('  Project not trusted: these settings are ignored until /trust.')
      : this.tab === 'memory'
        ? this.theme.hint('  Memory: this session only.')
        : ''
    return [
      this.theme.label(' Guardrails Settings', true),
      tabs,
      ...(note === '' ? [] : [note]),
      '',
      ...this.list.render(width),
      '',
      this.theme.hint(`  Tab scope · Ctrl+S save · Esc close${this.status}`)
    ]
  }

  handleInput (data: string): void {
    if (!this.submenuOpen) {
      if (matchesKey(data, Key.ctrl('s'))) {
        this.save().catch((error: unknown) => {
          this.status = ` · save failed: ${String(error)}`
          this.options.tui.requestRender()
        })
        return
      }
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
        const delta = matchesKey(data, Key.tab) ? 1 : -1
        const index = SCOPES.indexOf(this.tab)
        this.tab = SCOPES[(index + delta + SCOPES.length) % SCOPES.length] ??
          'global'
        this.list = this.buildList()
        return
      }
    }
    this.list.handleInput(data)
  }

  private get draft (): GuardrailsConfig {
    return this.drafts.get(this.tab) ?? {}
  }

  private setDraft (next: GuardrailsConfig): void {
    this.drafts.set(this.tab, next)
    this.dirty.add(this.tab)
    this.status = ''
  }

  private resolved (): ResolvedConfig {
    return this.options.runtime.loader.config
  }

  private async save (): Promise<void> {
    const { runtime } = this.options
    for (const scope of this.dirty) {
      await runtime.loader.save(scope, this.drafts.get(scope) ?? {})
    }
    this.dirty.clear()
    runtime.notifyChanged()
    this.status = ' · saved'
    this.list = this.buildList()
    this.options.tui.requestRender()
  }

  /** Wraps a submenu so Tab and Ctrl+S reach it while it is open. */
  private submenu (
    build: (done: Done) => Component
  ): SettingItem['submenu'] {
    return (_value, close) => {
      this.submenuOpen = true
      return build((value) => {
        this.submenuOpen = false
        close(value)
        this.list = this.buildList()
      })
    }
  }

  private buildList (): SettingsList {
    const items = [
      ...this.featureItems(),
      ...this.policyItems(),
      ...this.pathItems(),
      ...this.gateItems()
    ]
    return new SettingsList(items, 18, this.theme,
      (id, value) => this.change(id, value), () => this.options.close())
  }

  private featureItems (): SettingItem[] {
    const resolved = this.resolved()
    const items: SettingItem[] = [heading('Features')]
    for (const id of ['permissionGate', 'pathAccess'] as const) {
      const loaded = this.options.loadedFeatures.has(id)
      items.push({
        id: `features.${id}`,
        label: FEATURES[id].label,
        description: loaded
          ? FEATURES[id].description
          : `${FEATURES[id].description} (not loaded by Pi)`,
        currentValue: loaded
          ? onOff(this.draft.features?.[id], resolved.features[id])
          : 'unavailable',
        values: loaded ? ['on', 'off'] : []
      })
    }
    if (this.tab === 'global') {
      items.push({
        id: 'onboarding.completed',
        label: 'Onboarding',
        description: 'Set to pending to run /guardrails:onboarding again',
        currentValue: this.draft.onboarding?.completed === true
          ? 'completed'
          : 'pending',
        values: ['completed', 'pending']
      })
    }
    return items
  }

  private policyItems (): SettingItem[] {
    const rules = this.draft.policies?.rules ?? []
    const resolved = this.resolved()
    const items: SettingItem[] = [
      heading(`Policies (${rules.length})`),
      {
        id: 'features.policies',
        label: 'Enabled',
        description: FEATURES.policies.description,
        currentValue: onOff(this.draft.features?.policies,
          resolved.features.policies),
        values: ['on', 'off']
      }
    ]
    rules.forEach((rule, index) => {
      items.push({
        id: `policies.rules.${index}`,
        label: `  ${rule.name?.trim() ?? rule.id}`,
        description: rule.description ?? 'No description',
        currentValue: `${rule.protection}, ` +
          (rule.enabled === false ? 'disabled' : 'enabled'),
        submenu: this.submenu((done) => ruleEditor(
          () => this.draft.policies?.rules?.[index],
          (change) => this.updateRule(index, change),
          this.theme,
          done))
      })
    })
    items.push({
      id: 'policies.add',
      label: '  + Add policy',
      description: 'Create a policy rule step by step',
      currentValue: '',
      submenu: this.submenu((done) => addRuleWizard(this.theme,
        (rule) => this.setDraft(addPolicyRule(this.draft, rule)), done))
    })
    return items
  }

  private pathItems (): SettingItem[] {
    const pathAccess = this.draft.pathAccess
    const resolved = this.resolved().pathAccess
    const inherited = (value: string | undefined, fallback: string): string =>
      value ?? `inherited: ${fallback}`
    return [
      heading('Path Access'),
      {
        id: 'pathAccess.mode',
        label: 'Mode',
        description: 'allow: no limits · ask: prompt · block: deny outside paths',
        currentValue: inherited(pathAccess?.mode, resolved.mode),
        values: ['allow', 'ask', 'block']
      },
      {
        id: 'pathAccess.applyTo',
        label: 'Applies to',
        description: 'all: reads and writes · write: writes only (bash is always checked)',
        currentValue: inherited(pathAccess?.applyTo, resolved.applyTo),
        values: ['all', 'write']
      },
      {
        id: 'pathAccess.allowedPaths',
        label: 'Allowed paths',
        description: 'Always allowed outside the working directory; ~/ supported',
        currentValue: count(pathAccess?.allowedPaths),
        submenu: this.submenu((done) => new PathListEditor({
          label: 'Allowed paths',
          items: this.draft.pathAccess?.allowedPaths ?? [],
          theme: this.theme,
          onSave: (items) => this.setDraft({
            ...this.draft,
            pathAccess: { ...this.draft.pathAccess, allowedPaths: items }
          }),
          onDone: () => done(count(this.draft.pathAccess?.allowedPaths))
        }))
      },
      {
        id: 'pathAccess.alwaysScope',
        label: 'Always-grant scope',
        description: 'Where "allow always" is saved: local (project) or global',
        currentValue: inherited(pathAccess?.alwaysScope, resolved.alwaysScope),
        values: ['local', 'global']
      }
    ]
  }

  private gateItems (): SettingItem[] {
    const gate = this.draft.permissionGate
    const resolved = this.resolved().permissionGate
    const editor = (
      id: 'patterns' | 'allowedPatterns' | 'autoDenyPatterns',
      label: string,
      description: string
    ): SettingItem => ({
      id: `permissionGate.${id}`,
      label,
      description,
      currentValue: count(gate?.[id]),
      submenu: this.submenu((done) => new PatternEditor({
        label,
        items: this.draft.permissionGate?.[id] ?? [],
        theme: this.theme,
        context: 'command',
        onSave: (items) => this.setDraft({
          ...this.draft,
          permissionGate: {
            ...this.draft.permissionGate,
            [id]: id === 'patterns'
              ? items.map((item) => ({
                ...item, description: item.description ?? item.pattern
              }))
              : items
          }
        }),
        onDone: () => done(count(this.draft.permissionGate?.[id]))
      }))
    })
    return [
      heading('Permission Gate'),
      {
        id: 'permissionGate.requireConfirmation',
        label: 'Require confirmation',
        description: 'Prompt for dangerous commands; off only warns',
        currentValue: onOff(gate?.requireConfirmation,
          resolved.requireConfirmation),
        values: ['on', 'off']
      },
      editor('patterns', 'Dangerous patterns',
        'Extra command patterns that need confirmation'),
      editor('allowedPatterns', 'Allowed commands',
        'Commands that skip the prompt (matched per simple command)'),
      editor('autoDenyPatterns', 'Auto-deny patterns',
        'Commands blocked without asking')
    ]
  }

  private updateRule (
    index: number,
    change: (rule: PolicyRule) => PolicyRule | undefined
  ): void {
    const rules = [...(this.draft.policies?.rules ?? [])]
    const rule = rules[index]
    if (rule === undefined) {
      return
    }
    const next = change(rule)
    if (next === undefined) {
      rules.splice(index, 1)
    } else {
      rules[index] = next
    }
    this.setDraft({
      ...this.draft, policies: { ...this.draft.policies, rules }
    })
  }

  private change (id: string, value: string): void {
    const draft = structuredClone(this.draft)
    if (id.startsWith('features.')) {
      const feature = id.slice('features.'.length) as FeatureId
      draft.features = { ...draft.features, [feature]: value === 'on' }
    } else if (id === 'onboarding.completed') {
      draft.onboarding = value === 'completed'
        ? {
            ...draft.onboarding,
            completed: true,
            completedAt: draft.onboarding?.completedAt ??
              new Date().toISOString()
          }
        : { completed: false }
    } else if (id === 'permissionGate.requireConfirmation') {
      draft.permissionGate = {
        ...draft.permissionGate, requireConfirmation: value === 'on'
      }
    } else if (id === 'pathAccess.mode' &&
      (value === 'allow' || value === 'ask' || value === 'block')) {
      draft.pathAccess = { ...draft.pathAccess, mode: value }
    } else if (id === 'pathAccess.applyTo' &&
      (value === 'all' || value === 'write')) {
      draft.pathAccess = { ...draft.pathAccess, applyTo: value }
    } else if (id === 'pathAccess.alwaysScope' &&
      (value === 'local' || value === 'global')) {
      draft.pathAccess = { ...draft.pathAccess, alwaysScope: value }
    } else {
      return
    }
    this.setDraft(draft)
  }
}

/**
 * Registers `/guardrails:settings`: tabs per scope, changes held as drafts
 * until Ctrl+S.
 *
 * @param pi - The extension API.
 * @param runtime - Config access.
 * @param loadedFeatures - Features whose extension answered discovery.
 */
function registerSettingsCommand (
  pi: ExtensionAPI,
  runtime: Runtime,
  loadedFeatures: () => ReadonlySet<FeatureId>
): void {
  pi.registerCommand('guardrails:settings', {
    description: 'Configure guardrails',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('Guardrails settings need the interactive UI. Edit ' +
          `${runtime.loader.globalPath} instead.`, 'info')
        return
      }
      await runtime.ensureLoaded(ctx)
      await ctx.ui.custom<undefined>((tui, _theme, _keybindings, done) =>
        new SettingsScreen({
          runtime,
          loadedFeatures: loadedFeatures(),
          tui,
          close: () => done(undefined)
        }))
    }
  })
}

export { registerSettingsCommand }

import { getSettingsListTheme } from '@earendil-works/pi-coding-agent'
import { Key, matchesKey } from '@earendil-works/pi-tui'

import { CONFIG_VERSION, DEFAULT_CONFIG } from '../config/config-defaults.ts'
import { Choice, Wizard, wrap } from './widgets.ts'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Component, SettingsListTheme } from '@earendil-works/pi-tui'

import type { GuardrailsConfig } from '../config/config-schema.ts'
import type { Runtime } from '../runtime.ts'

interface OnboardingChoices {
  applyBuiltinDefaults: boolean
  pathAccess: boolean
}

const INTRO = 'Guardrails helps prevent accidental exposure of secrets and ' +
  'risky actions.\n\nPolicies are file rules (noAccess or readOnly). The ' +
  'permission gate asks before dangerous commands run. Path access asks ' +
  'before tools reach outside the working directory.\n\nYou are choosing ' +
  'starting defaults; change them later with /guardrails:settings.'

class TextStep implements Component {
  constructor (
    private readonly text: string,
    private readonly theme: SettingsListTheme,
    private readonly next: () => void
  ) {}

  invalidate (): void {}

  render (width: number): string[] {
    return wrap(this.text, Math.max(20, width - 4))
      .map((line) => this.theme.description(`  ${line}`))
  }

  handleInput (data: string): void {
    if (matchesKey(data, Key.enter)) {
      this.next()
    }
  }
}

function recap (choices: OnboardingChoices): string {
  const defaults = choices.applyBuiltinDefaults
    ? 'Recommended defaults: .env and similar secret files are protected ' +
      '(example and sample files stay readable).'
    : 'Minimal setup: no built-in file policies.'
  const gate = 'Dangerous commands such as rm -rf, sudo and dd of= ' +
    'need confirmation.'
  const paths = choices.pathAccess
    ? 'Path access: ask before touching files outside the working directory.'
    : 'Path access: off.'
  return `${defaults}\n\n${gate}\n\n${paths}\n\nPress Enter to save.`
}

/**
 * The settings onboarding writes to the global config.
 *
 * @param base - The current global config, if any.
 * @param choices - What the user picked.
 * @returns The config to save.
 */
function onboardedConfig (
  base: GuardrailsConfig | undefined,
  choices: OnboardingChoices
): GuardrailsConfig {
  const next: GuardrailsConfig = {
    ...structuredClone(base ?? {}),
    version: CONFIG_VERSION,
    applyBuiltinDefaults: choices.applyBuiltinDefaults,
    onboarding: {
      completed: true,
      completedAt: new Date().toISOString(),
      version: CONFIG_VERSION
    }
  }
  if (choices.pathAccess) {
    next.features = { ...next.features, pathAccess: true }
    next.pathAccess = {
      ...next.pathAccess,
      mode: 'ask',
      allowedPaths: [...DEFAULT_CONFIG.pathAccess.allowedPaths]
    }
  }
  return next
}

function isPending (config: GuardrailsConfig | undefined): boolean {
  return config?.onboarding?.completed !== true
}

function onboardingWizard (
  done: (choices: OnboardingChoices | undefined) => void
): Component {
  const theme = getSettingsListTheme()
  const choices: OnboardingChoices = {
    applyBuiltinDefaults: true, pathAccess: true
  }
  return new Wizard({
    title: 'Guardrails onboarding',
    theme,
    steps: [
      { label: 'Welcome', build: (next) => new TextStep(INTRO, theme, next) },
      {
        label: 'Defaults',
        build: (next) => new Choice({
          title: 'How much built-in protection to start with?',
          theme,
          items: [
            {
              label: 'Recommended defaults',
              description: 'Protect .env, .env.local, .env.production and ' +
                '.dev.vars; keep .env.example and *.sample.env readable.'
            },
            {
              label: 'Minimal setup',
              description: 'No built-in file policies. Add your own in ' +
                '/guardrails:settings or /guardrails:examples.'
            }
          ],
          onSelect: (index) => {
            choices.applyBuiltinDefaults = index === 0
            next()
          }
        })
      },
      {
        label: 'Path access',
        build: (next) => new Choice({
          title: 'Restrict access to the project directory?',
          theme,
          items: [
            {
              label: 'Ask before accessing outside files',
              description: 'Grant per file or directory, once, for the ' +
                'session or always. Without a UI, outside access is blocked.'
            },
            {
              label: 'No restrictions',
              description: 'Any path can be accessed without asking. You ' +
                'can turn this on later.'
            }
          ],
          onSelect: (index) => {
            choices.pathAccess = index === 0
            next()
          }
        })
      },
      {
        label: 'Recap',
        build: (next) => new TextStep(recap(choices), theme, next)
      }
    ],
    onFinish: () => done(choices),
    onCancel: () => done(undefined)
  })
}

/**
 * Registers `/guardrails:onboarding` while onboarding has not been done.
 *
 * @param pi - The extension API.
 * @param runtime - Config access.
 */
function registerOnboardingCommand (pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerCommand('guardrails:onboarding', {
    description: 'Choose guardrails starting defaults',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') {
        return
      }
      await runtime.ensureLoaded(ctx)
      const global = runtime.loader.raw('global')
      if (!isPending(global)) {
        ctx.ui.notify('Guardrails onboarding is already done. Use ' +
          '/guardrails:settings to change settings.', 'info')
        return
      }
      const choices = await ctx.ui.custom<OnboardingChoices | undefined>(
        (_tui, _theme, _keybindings, done) => onboardingWizard(done),
        { overlay: true })
      if (choices === undefined) {
        ctx.ui.notify('Guardrails onboarding cancelled.', 'warning')
        return
      }
      await runtime.loader.save('global', onboardedConfig(global, choices))
      runtime.notifyChanged()
      ctx.ui.notify('Guardrails onboarding complete.', 'info')
    }
  })
}

export { isPending, onboardedConfig, registerOnboardingCommand }
export type { OnboardingChoices }

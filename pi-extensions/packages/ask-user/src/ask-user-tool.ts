import { StringEnum } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import { createAskEvents } from './ask-events.ts'
import {
  batchNonInteractiveMessage,
  createFreeformResponse,
  formatBatchAnswers,
  formatResponseSummary,
  nonInteractiveMessage,
  withContext
} from './answer-format.ts'
import { AskComponent } from './ask-component.ts'
import {
  BATCH_MAX_QUESTIONS,
  BATCH_MIN_QUESTIONS,
  batchHeading,
  normalizeBatchQuestions,
  normalizeContext,
  normalizeOptions
} from './ask-params.ts'
import { BatchAskComponent } from './batch-component.ts'
import { isAborted, runCustomPrompt, whileBlocked } from './custom-prompt.ts'
import { askBatchViaDialogs, askViaDialogs } from './dialog-fallback.ts'
import { resolveEmitFullEvents, resolvePromptSettings } from './prompt-settings.ts'
import { renderCallText, renderResultText } from './result-render.ts'
import { loadSettings, settingsPath } from './settings.ts'

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIDialogOptions,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'

import type { AskParams } from './ask-params.ts'
import type {
  AskBatchDetails,
  AskDetails,
  AskToolDetails,
  BatchAnswer
} from './ask-types.ts'
import type { PromptSettings } from './prompt-settings.ts'
import type { Environment } from './settings.ts'

const TOOL_NAME = 'ask_user'
const WAITING = 'Waiting for user input...'
const SETTINGS_NOTE = 'Omit to use the user\'s preference (env var or ' +
  'ask-user.json in the Pi agent directory).'

const optionSchema = Type.Object({
  title: Type.String({ description: 'Short title for this option' }),
  description: Type.Optional(Type.String({
    description: 'Longer explanation of this option'
  }))
})

const parametersSchema = Type.Object({
  question: Type.Optional(Type.String({
    description: 'The question to ask. With questions, only an optional heading for the batch; put every real question inside questions.'
  })),
  questions: Type.Optional(Type.Array(Type.Object({
    question: Type.String({ description: 'One question in the batch' }),
    context: Type.Optional(Type.String({
      description: 'Short summary of findings shown with this question'
    })),
    options: Type.Optional(Type.Array(optionSchema, {
      description: 'Choices for this question'
    })),
    allowMultiple: Type.Optional(Type.Boolean({
      description: 'Allow choosing several options. Default: false'
    })),
    allowFreeform: Type.Optional(Type.Boolean({
      description: 'Offer a free-text answer. Default: true'
    }))
  }), {
    minItems: BATCH_MIN_QUESTIONS,
    maxItems: BATCH_MAX_QUESTIONS,
    description: '2-4 independent questions shown together, instead of question. Set context, options, allowMultiple and allowFreeform on each entry; the other parameters apply to the whole batch.'
  })),
  context: Type.Optional(Type.String({
    description: 'Short summary of findings shown before the question'
  })),
  options: Type.Optional(Type.Array(optionSchema, {
    description: 'Choices for the user'
  })),
  allowMultiple: Type.Optional(Type.Boolean({
    description: 'Allow choosing several options. Default: false'
  })),
  allowFreeform: Type.Optional(Type.Boolean({
    description: 'Offer a free-text answer. Default: true'
  })),
  allowComment: Type.Optional(Type.Boolean({
    description: `Ask for an optional comment after a choice. ${SETTINGS_NOTE} Built-in default: false.`
  })),
  displayMode: Type.Optional(StringEnum(['overlay', 'inline'] as const, {
    description: `overlay: centred modal; inline: in place, keeping the conversation visible. ${SETTINGS_NOTE} Built-in default: overlay.`
  })),
  singleSelectLayout: Type.Optional(StringEnum(['auto', 'list'] as const, {
    description: `auto: details pane beside the list on wide terminals; list: descriptions under each option. ${SETTINGS_NOTE} Built-in default: auto.`
  })),
  contextExpanded: Type.Optional(Type.Boolean({
    description: `Start with long context expanded instead of collapsed. ${SETTINGS_NOTE} Built-in default: false.`
  })),
  overlayToggleKey: Type.Optional(Type.String({
    description: `Key that hides/shows the overlay, e.g. 'alt+o'; 'off' disables. ${SETTINGS_NOTE} Built-in default: alt+o.`
  })),
  commentToggleKey: Type.Optional(Type.String({
    description: `Key that toggles the optional comment row, e.g. 'ctrl+g'; 'off' disables. ${SETTINGS_NOTE} Built-in default: ctrl+g.`
  })),
  timeout: Type.Optional(Type.Number({
    description: 'Dismiss after this many milliseconds; counts as cancelled.'
  }))
})

type AskResult = AgentToolResult<AskDetails>

function textResult<T extends AskDetails> (
  text: string,
  details: T
): AgentToolResult<T> {
  return { content: [{ type: 'text', text }], details }
}

interface ToolEnv {
  readonly pi: Pick<ExtensionAPI, 'events'>
  readonly env: Environment
}

interface Preferences {
  readonly settings: PromptSettings
  readonly emitFull: boolean
}

function preferences (params: AskParams, env: Environment): Preferences {
  // Re-read every call so edits to ask-user.json apply without a restart.
  const file = loadSettings(settingsPath(env))
  return {
    settings: resolvePromptSettings(params, env, file),
    emitFull: resolveEmitFullEvents(env, file)
  }
}

async function executeBatch (
  tool: ToolEnv,
  params: AskParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AskDetails> | undefined,
  ctx: ExtensionContext
): Promise<AgentToolResult<AskBatchDetails>> {
  const questions = normalizeBatchQuestions(params)
  const heading = batchHeading(params)
  const { settings, emitFull } = preferences(params, tool.env)
  const events = createAskEvents(tool.pi, emitFull)
  const subjects = questions.map(({ question, context, options }) => ({
    question,
    ...(context === undefined ? {} : { context }),
    options
  }))
  const details = (
    answers: readonly BatchAnswer[],
    cancelled: boolean
  ): AskBatchDetails => ({
    kind: 'batch',
    ...(heading === undefined ? {} : { heading }),
    questions: subjects,
    answers,
    cancelled
  })

  if (!ctx.hasUI) {
    throw new Error(batchNonInteractiveMessage(questions,
      settings.allowComment, heading))
  }
  onUpdate?.(textResult(WAITING, details([], false)))

  const timeout = params.timeout
  const deadline = timeout !== undefined && timeout > 0
    ? Date.now() + timeout
    : undefined
  // One controller owns the batch deadline and the caller's abort, so an
  // open dialog closes on time and a late answer cancels the batch.
  const batch = new AbortController()
  const forwardAbort = (): void => batch.abort()
  signal?.addEventListener('abort', forwardAbort, { once: true })
  if (signal?.aborted === true) {
    batch.abort()
  }
  const deadlineTimer = deadline === undefined
    ? undefined
    : setTimeout(() => batch.abort(), timeout)
  let answers: BatchAnswer[] | null
  try {
    answers = await whileBlocked(tool.pi, async () =>
      await runCustomPrompt<BatchAnswer[]>(ctx.ui, {
        signal: batch.signal,
        displayMode: settings.displayMode,
        overlayToggle: settings.shortcuts.overlayToggle,
        create: (tui, theme, keys, complete) => new BatchAskComponent(
          questions, { settings, tui, theme, keys }, complete, heading),
        fallback: async () => await askBatchViaDialogs(ctx.ui, questions,
          settings.allowComment, batch.signal, deadline, heading)
      }))
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer)
    }
    signal?.removeEventListener('abort', forwardAbort)
  }

  const total = subjects.length
  if (batch.signal.aborted || answers === null) {
    subjects.forEach((subject, index) =>
      events.cancelled(subject, { index, total }))
    return textResult('User cancelled the questions', details([], true))
  }
  // Skipped questions emit nothing.
  answers.forEach((answer, index) => {
    const subject = subjects[index]
    if (answer.status === 'answered' && subject !== undefined) {
      events.answered(subject, answer.response, { index, total })
    }
  })
  const result = details(answers, false)
  return textResult(formatBatchAnswers(result), result)
}

async function executeSingle (
  tool: ToolEnv,
  params: AskParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<AskDetails> | undefined,
  ctx: ExtensionContext
): Promise<AgentToolResult<AskToolDetails>> {
  const { question } = params
  if (typeof question !== 'string') {
    throw new Error('ask_user needs question (one focused question) or ' +
      'questions (2-4 independent questions).')
  }
  const { settings, emitFull } = preferences(params, tool.env)
  const events = createAskEvents(tool.pi, emitFull)
  const options = normalizeOptions(params.options, 'options')
  const context = normalizeContext(params.context)
  const allowMultiple = params.allowMultiple === true
  const allowFreeform = params.allowFreeform !== false
  const { allowComment } = settings
  const subject = {
    question, ...(context === undefined ? {} : { context }), options
  }
  const details = (
    response: AskToolDetails['response'],
    cancelled: boolean
  ): AskToolDetails => ({ ...subject, response, cancelled })

  if (!ctx.hasUI) {
    throw new Error(nonInteractiveMessage(question, context, options,
      allowFreeform, allowComment))
  }

  const ask = {
    question,
    ...(context === undefined ? {} : { context }),
    options,
    allowMultiple,
    allowFreeform
  }
  const timeout = params.timeout !== undefined && params.timeout > 0
    ? params.timeout
    : undefined
  const dialogOpts: ExtensionUIDialogOptions | undefined =
    signal === undefined && timeout === undefined
      ? undefined
      : {
          ...(signal === undefined ? {} : { signal }),
          ...(timeout === undefined ? {} : { timeout })
        }

  let response
  if (options.length === 0) {
    const answer = await whileBlocked(tool.pi, async () =>
      await ctx.ui.input(withContext(question, context),
        'Type your answer...', dialogOpts))
    response = isAborted(signal) ? null : createFreeformResponse(answer)
  } else {
    onUpdate?.(textResult(WAITING, details(null, false)))
    response = await whileBlocked(tool.pi, async () =>
      await runCustomPrompt(ctx.ui, {
        ...(signal === undefined ? {} : { signal }),
        ...(timeout === undefined ? {} : { timeout }),
        displayMode: settings.displayMode,
        overlayToggle: settings.shortcuts.overlayToggle,
        create: (tui, theme, keys, complete) => new AskComponent(
          ask, { settings, tui, theme, keys }, complete),
        fallback: async () => await askViaDialogs(ctx.ui,
          { ...ask, allowComment }, dialogOpts)
      }))
  }

  if (isAborted(signal) || response === null) {
    events.cancelled(subject)
    return textResult('User cancelled the question', details(null, true))
  }
  events.answered(subject, response)
  return textResult(`User answered: ${formatResponseSummary(response)}`,
    details(response, false))
}

/**
 * Creates the `ask_user` tool.
 *
 * @param pi - The extension API (for events).
 * @param env - The process environment (for preferences).
 * @returns The tool definition to register.
 */
function createAskUserTool (
  pi: Pick<ExtensionAPI, 'events'>,
  env: Environment
): ToolDefinition<typeof parametersSchema, AskDetails> {
  const tool: ToolEnv = { pi, env }
  return defineTool({
    name: TOOL_NAME,
    label: 'Ask User',
    description: 'Ask the user a question, optionally with multiple-choice answers. Ask one focused question per call, or 2-4 independent questions together through questions. Gather context with your tools first and pass a short summary in context.',
    promptSnippet: 'Ask the user one focused question (or 2-4 independent ones) with optional multiple-choice answers',
    promptGuidelines: [
      'Before calling ask_user, gather context with your tools and pass a short summary in context.',
      'Use ask_user when intent is ambiguous, a decision needs the user, or several valid options exist.',
      'Ask one focused question per ask_user call by default.',
      'Use questions (2-4 entries) only for independent decisions whose prerequisites are settled; ask dependent questions in a later call.',
      'With questions, put every question inside questions; a top-level question is only the batch heading.',
      'Do not combine several numbered, multipart or unrelated questions into one question.'
    ],
    // Only the model may ask; scripts must not open prompts.
    exposure: 'model-only',
    // Hold other tool calls in the same turn until the user answers.
    executionMode: 'sequential',
    parameters: parametersSchema,
    async execute (
      _toolCallId,
      params,
      signal,
      onUpdate,
      ctx
    ): Promise<AskResult> {
      const batch = params.questions !== undefined
      if (signal?.aborted === true) {
        return textResult('Cancelled', batch
          ? { kind: 'batch', questions: [], answers: [], cancelled: true }
          : {
              question: params.question ?? '',
              options: [],
              response: null,
              cancelled: true
            })
      }
      return batch
        ? await executeBatch(tool, params, signal, onUpdate, ctx)
        : await executeSingle(tool, params, signal, onUpdate, ctx)
    },
    renderCall: (args, theme) => new Text(renderCallText(args, theme), 0, 0),
    renderResult: (result, options, theme, context) => {
      const text = result.content
        .map((part) => part.type === 'text' ? part.text : '')
        .join('\n')
      const details: AskDetails | undefined = result.details
      return new Text(renderResultText({
        details,
        text,
        isError: context.isError,
        isPartial: options.isPartial,
        expanded: options.expanded
      }, theme), 0, 0)
    }
  })
}

export { createAskUserTool, TOOL_NAME }

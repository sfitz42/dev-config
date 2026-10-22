/*
 * The `initialize` request this extension sends. Shared by the client and
 * the daemon, which node runs directly: keep this erasable TypeScript with
 * no imports.
 */

interface InitializeFolder {
  readonly uri: string
  readonly name: string
}

interface InitializeInput {
  readonly processId: number
  readonly rootUri: string
  readonly rootName: string
  readonly workspaceFolders?: readonly InitializeFolder[]
  readonly initializationOptions?: unknown
}

const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    hover: { contentFormat: ['plaintext', 'markdown'] },
    definition: {},
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    rename: { prepareSupport: false },
    publishDiagnostics: { relatedInformation: true },
    completion: { completionItem: { snippetSupport: false } },
    codeAction: {}
  },
  workspace: { workspaceFolders: true, symbol: {}, configuration: true }
}

/**
 * Builds `initialize` parameters.
 *
 * @param input - Root, folders and server-specific options.
 * @returns The request parameters.
 */
function buildInitializeParams (input: InitializeInput): object {
  const folders = input.workspaceFolders !== undefined &&
    input.workspaceFolders.length > 0
    ? input.workspaceFolders
    : [{ uri: input.rootUri, name: input.rootName }]
  return {
    processId: input.processId,
    capabilities: CLIENT_CAPABILITIES,
    rootUri: input.rootUri,
    workspaceFolders: folders,
    ...(input.initializationOptions === undefined
      ? {}
      : { initializationOptions: input.initializationOptions })
  }
}

/**
 * Answers a `workspace/configuration` request from configured settings.
 *
 * @param params - The request parameters.
 * @param settings - Settings keyed by section.
 * @returns One value per requested item; `{}` for unknown sections.
 */
function answerConfiguration (
  params: unknown,
  settings: Readonly<Record<string, unknown>> | undefined
): unknown[] {
  const items = typeof params === 'object' && params !== null &&
    'items' in params && Array.isArray(params.items)
    ? params.items as unknown[]
    : []
  return items.map((item) => {
    const section = typeof item === 'object' && item !== null &&
      'section' in item && typeof item.section === 'string'
      ? item.section
      : undefined
    if (section !== undefined && settings !== undefined &&
      Object.hasOwn(settings, section)) {
      return settings[section]
    }
    return {}
  })
}

export { answerConfiguration, buildInitializeParams, CLIENT_CAPABILITIES }
export type { InitializeFolder, InitializeInput }

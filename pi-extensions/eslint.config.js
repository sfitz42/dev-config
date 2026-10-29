import neostandard from 'neostandard'

const noWildcardImports = {
  selector: 'ImportNamespaceSpecifier',
  message: 'Use named imports, not wildcard imports.'
}

// AICE: neostandard formatting. Google TS: the type-level rules below.
export default [
  ...neostandard({ ts: true }),
  {
    files: ['**/*.ts'],
    rules: {
      '@stylistic/max-len': ['error', {
        code: 80,
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true
      }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': ['error', noWildcardImports, {
        selector: 'ExportDefaultDeclaration',
        message: 'Use named exports. Only a Pi entry point may export default.'
      }]
    }
  },
  {
    // Pi loads an extension through its default-exported factory. List each
    // `pi.extensions` entry that is not a package's src/index.ts here.
    files: [
      'packages/*/src/index.ts',
      'packages/guardrails/src/{path-access,permission-gate,herdr}/index.ts',
      '*.config.ts'
    ],
    rules: {
      'no-restricted-syntax': ['error', noWildcardImports]
    }
  }
]

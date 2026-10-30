/**
 * Modular-monolith boundaries. See README "Architecture".
 * app → modules → contracts/shared ; modules talk to each other only via `connection`'s public index.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'module-public-api-only',
      comment: 'Outside a module, import it only through its index.ts.',
      severity: 'error',
      from: { path: '^src/(?!modules/)' },
      to: { path: '^src/modules/[^/]+/', pathNot: '^src/modules/[^/]+/index\\.ts$' },
    },
    {
      name: 'cross-module-public-api-only',
      comment: 'Between modules, import only the other module\'s index.ts.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/[^/]+/', pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\\.ts$'] },
    },
    {
      name: 'modules-depend-only-on-connection',
      comment: 'Feature modules may depend on connection; connection depends on no other module.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/([^/]+)/', pathNot: ['^src/modules/$1/', '^src/modules/connection/'] },
    },
    {
      name: 'foundation-is-leaf',
      comment: 'contracts/ and shared/ hold no business logic and import nothing above them.',
      severity: 'error',
      from: { path: '^src/(contracts|shared)/' },
      to: { path: '^src/(modules|app|ui|server)/' },
    },
    {
      name: 'modules-are-ui-free',
      comment: 'Core modules stay framework-free; only app/ and ui/ know Svelte.',
      severity: 'error',
      from: { path: '^src/(modules|contracts|shared|server)/' },
      to: { path: '(^src/(app|ui)/)|(\\.svelte$)' },
    },
    {
      name: 'ui-is-presentational',
      comment: 'Design-system components never reach into modules or app.',
      severity: 'error',
      from: { path: '^src/ui/' },
      to: { path: '^src/(modules|app|server)/' },
    },
    {
      name: 'server-isolated',
      comment: 'The Worker imports only contracts/ and shared/.',
      severity: 'error',
      from: { path: '^src/server/' },
      to: { path: '^src/(modules|app|ui)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.test\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.app.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default', 'types'] },
  },
};

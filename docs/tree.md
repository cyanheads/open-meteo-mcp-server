# open-meteo-mcp-server - Directory Structure

Generated on: 2026-07-31 01:47:25

```text
open-meteo-mcp-server/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── dataframe-describe.tool.ts
│   │       │   ├── dataframe-query.tool.ts
│   │       │   ├── get-air-quality.tool.ts
│   │       │   ├── get-climate.tool.ts
│   │       │   ├── get-elevation.tool.ts
│   │       │   ├── get-ensemble.tool.ts
│   │       │   ├── get-flood.tool.ts
│   │       │   ├── get-forecast.tool.ts
│   │       │   ├── get-historical.tool.ts
│   │       │   ├── get-marine.tool.ts
│   │       │   ├── index.ts
│   │       │   └── search-locations.tool.ts
│   │       ├── model-catalog.ts
│   │       ├── reshape-utils.ts
│   │       ├── spill-utils.ts
│   │       ├── upstream-error.ts
│   │       └── variable-cadence.ts
│   ├── services/
│   │   ├── open-meteo/
│   │   │   ├── open-meteo-service.ts
│   │   │   └── types.ts
│   │   └── canvas-accessor.ts
│   └── index.ts
├── tests/
│   ├── prompts/
│   ├── resources/
│   ├── scripts/
│   │   └── packaging-entry-regex-sync.test.ts
│   ├── services/
│   │   └── open-meteo-service.test.ts
│   └── tools/
│       ├── dataframe-describe.tool.test.ts
│       ├── dataframe-query.tool.test.ts
│       ├── get-air-quality.tool.test.ts
│       ├── get-climate.tool.test.ts
│       ├── get-elevation.tool.test.ts
│       ├── get-ensemble.tool.test.ts
│       ├── get-flood.tool.test.ts
│       ├── get-forecast.tool.test.ts
│       ├── get-historical.tool.test.ts
│       ├── get-marine.tool.test.ts
│       ├── model-catalog.test.ts
│       ├── search-locations.tool.test.ts
│       ├── spill-utils.test.ts
│       ├── tool-surface.test.ts
│       ├── upstream-error.test.ts
│       └── variable-cadence.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._

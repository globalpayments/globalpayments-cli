# Contributing to @globalpayments/cli

Thank you for your interest in contributing to the Global Payments CLI tool! This document explains how to get started.

## Code of Conduct

Be respectful, inclusive, and professional. Harassment, discrimination, and hostile behavior are not tolerated.

## Getting Started

### Prerequisites
- Node.js ≥ 20
- npm or yarn
- Basic knowledge of TypeScript, CLI tools, and Git

### Local Setup
```bash
git clone https://github.com/globalpayments/globalpayments-cli.git
cd globalpayments-cli
npm install
npm run build
npm test
```

### Project Structure
```
src/
├── bin.ts                      # CLI entry point
├── cli.ts                      # Command registration
├── commands/                   # Command implementations
│   ├── init.ts
│   ├── doctor.ts
│   ├── watch.ts
│   ├── run.ts
│   ├── report.ts
│   └── auth/
│       └── test.ts
│   └── cases/
│       ├── list.ts
│       └── show.ts
├── config/                     # Config loading and schema
│   ├── load.ts
│   └── schema.ts
├── core/                       # Core logic
│   ├── engine.ts              # Main polling + evaluation loop
│   ├── evaluator.ts           # Evaluator module loading
│   ├── evaluator-runtime.ts   # Script loading and execution
│   ├── matching.ts            # Case matching logic
│   ├── pack-loader.ts         # Pack YAML loading
│   ├── pack-resolver.ts       # Pack inheritance resolution
│   ├── polling.ts             # Time-window sliding logic
│   ├── result-store.ts        # Persistence
│   └── redaction.ts           # Credential masking
├── gpapi/                      # GP API integration
│   ├── auth.ts               # OAuth token provider
│   ├── client.ts             # HTTP client
│   ├── transactions.ts       # Transaction polling
│   └── adapters.ts           # Response parsing
├── types/
│   └── domain.ts             # TypeScript interfaces
└── util/
    └── index.ts              # Utilities (duration parsing, etc.)

test/                          # Test suite
├── *.test.ts                 # Unit tests (16 test files, 113 tests)

examples/                      # Sample config and packs
├── globalpayments.config.yaml
```

## How to Contribute

### Reporting Bugs
1. Search existing issues to avoid duplicates
2. Include reproduction steps, environment info, and error output
3. Attach relevant logs or config (redact credentials)

### Suggesting Features
1. Open an issue describing the use case
2. Explain why this feature matters for certification testing
3. Link to any related issues or discussions

### Submitting Code

#### Before You Code
1. Create or comment on an issue to get feedback
2. Discuss your approach with maintainers
3. Wait for approval before implementing large changes

#### Code Style
- **TypeScript strict mode** — All code must pass `tsc --noEmit`
- **No `any` types** — Use proper interfaces from `src/types/domain.ts`
- **Minimal comments** — Code should be self-documenting; comment only non-obvious logic
- **Clean imports** — Avoid circular dependencies; use absolute imports from `src/`
- **Tests required** — All new functionality must have corresponding unit tests

#### Writing Tests
```typescript
import { describe, it, expect } from 'vitest';

describe('My Feature', () => {
  it('should do something', () => {
    const result = myFunction('input');
    expect(result).toBe('expected output');
  });

  it('should handle errors gracefully', () => {
    expect(() => myFunction(null)).toThrow('Invalid input');
  });
});
```

#### Making a Commit
```bash
git checkout -b feature/my-feature
# Make changes, run tests
npm run lint
npm test

git commit -m "Add my feature

This implements X for Y use case.

- Added new matcher logic
- Updated case schema
- Added 8 new tests

Fixes #123"
```

#### Submitting a Pull Request
1. Push your branch: `git push origin feature/my-feature`
2. Open PR with a clear title and description
3. Link related issues: `Fixes #123` or `Related to #456`
4. Ensure CI passes (build, lint, tests)
5. Request review from a maintainer
6. Respond to feedback and make requested changes

### Areas We Need Help

- **Pack definitions** — Write certification cases for new payment flows
- **Evaluators** — Contribute custom evaluation logic for complex scenarios
- **Documentation** — Improve guides, examples, error messages
- **Testing** — Increase coverage, add edge case tests
- **Performance** — Optimize polling, matching, or evaluation
- **Integrations** — CI/CD examples (GitHub, GitLab, Jenkins, etc.)

## Development Workflow

### Running Locally
```bash
npm run dev -- doctor --config examples/globalpayments.config.yaml
npm run dev -- watch --config examples/globalpayments.config.yaml --timeout 2m
```

### Type Checking
```bash
npm run lint  # tsc --noEmit
```

### Testing
```bash
npm run verify        # typecheck + tests + build + build-level smoke (run this before every PR)
npm test              # Run all tests once
npm run test:watch   # Watch mode (re-run on changes)
```

### Building for Distribution
```bash
npm run build        # Compile to dist/
npm run clean        # Clear dist/ and coverage/
```

## Code Review Process

All PRs require review from at least one maintainer. Reviewers look for:

- ✓ Functionality — Does it work as intended?
- ✓ Testing — Are edge cases covered?
- ✓ Code quality — Is it maintainable?
- ✓ Documentation — Are changes documented?
- ✓ Performance — Any regressions?
- ✓ Security — Are credentials/data safe?

## Release Process

Maintainers handle releases:

1. Merge PR to `main`
2. Bump version in `package.json`
3. Update `CHANGELOG.md`
4. Create Git tag (`v0.2.0`)
5. Publish to npm: `npm publish`

## Questions?

- Open an issue on GitHub
- Email [CommunityExperience@globalpayments.com](mailto:CommunityExperience@globalpayments.com)
- Check existing documentation in README.md

Thank you for contributing! 🎉

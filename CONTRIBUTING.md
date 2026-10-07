# Contributing to StratoSort Stack

Thanks for your interest in StratoSort Stack. Please read this document fully before opening an issue
or a pull request — contributions are accepted under the terms below so ownership stays clear.

## Table of Contents

- [License and Contribution Terms](#license-and-contribution-terms)
- [Code of Conduct](#code-of-conduct)
- [Reporting Issues](#reporting-issues)
- [Security Disclosures](#security-disclosures)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Pull Request Checklist](#pull-request-checklist)

## License and Contribution Terms

StratoSort Stack is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal and
other noncommercial use is free. Commercial use requires a [paid license](docs/COMMERCIAL.md).

We do, however, accept community **bug reports**, **feature requests**, and **pull requests** under
the following terms:

- **Bug reports and feature requests** are welcome from anyone. Use GitHub Issues — no special
  permission is required.
- **Pull requests** are accepted at the maintainers' discretion. By opening a pull request that
  contains code, documentation, configuration, or any other content (a "Contribution"), you agree
  that:
  1. The Contribution is your original work, or that you have the right to submit it.
  2. You grant the project's rights holder (Kennedy Applied Sciences, Inc.) a perpetual, worldwide,
     non-exclusive, royalty-free, irrevocable license to use, reproduce, modify, sublicense, and
     distribute the Contribution as part of the project under any terms the rights holder chooses,
     including the PolyForm Noncommercial License 1.0.0 currently applied to this repository.
  3. The Contribution does not infringe any third party's intellectual property rights.
  4. You understand that you retain copyright to your Contribution but cannot revoke the license
     granted in (2) once the Contribution has been merged.
- **Trivial fixes** (typos, link fixes, dependency bumps with no behavior change) are encouraged and
  the bar above is intentionally low for them.

If you cannot agree to the above terms, please do not open a pull request — open an issue describing
what you would change instead, and a maintainer can implement it.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating in any project
space — issues, pull requests, discussions — you agree to abide by it.

## Reporting Issues

Open a GitHub issue: <https://github.com/iLevyTate/StratoSortStack/issues>. Include:

- Clear reproduction steps
- Expected vs actual behavior
- App version and platform (you can grab this from **Settings → About → Copy Version Info**)
- Relevant logs (the directory is `app.getPath('userData')/logs/`, which resolves to
  `%APPDATA%\StratoSort Stack\logs\` on Windows,
  `~/Library/Application Support/StratoSort Stack/logs/` on macOS, and
  `~/.config/StratoSort Stack/logs/` on Linux). Use **Settings → Diagnostics → Export Logs** for a
  redacted archive suitable for sharing.

From **Settings → About** you can use **Copy Version Info** to grab your runtime details, then open
a new GitHub issue, or use **Email Support** to send them directly.

## Security Disclosures

Do **not** report security vulnerabilities through public GitHub issues. Follow the process in
[SECURITY.md](SECURITY.md) — use the repository's Security tab to file a private advisory.

## Development Setup

### Prerequisites

| Requirement | Version       | Notes                                        |
| ----------- | ------------- | -------------------------------------------- |
| Node.js     | See `.nvmrc`  | Use nvm for version management               |
| npm         | >=8.0.0       | Comes with Node.js                           |
| OS          | Windows 10/11 | Recommended; other OS builds are best-effort |

### Setup

```powershell
git clone https://github.com/iLevyTate/StratoSortStack.git
cd StratoSortStack
npm ci
npm run dev
```

## Where to Learn the Codebase

| Document                                       | Purpose                       |
| ---------------------------------------------- | ----------------------------- |
| [Onboarding](docs/ONBOARDING.md)               | Onboarding and glossary       |
| [Architecture](docs/ARCHITECTURE.md)           | System design and data flow   |
| [DI Patterns](docs/DI_PATTERNS.md)             | Dependency injection patterns |
| [Error Handling](docs/ERROR_HANDLING_GUIDE.md) | Error handling standards      |
| [Code Quality](docs/CODE_QUALITY_STANDARDS.md) | Style and review expectations |

## Development Workflow

1. Create a feature branch from the current default branch.
2. Make focused changes that keep scope tight and tests relevant.
3. Run tests and linting (see below).
4. Open a PR with a clear description and test results.

## Testing

### Automated

```powershell
npm run format:check
npm run lint
npm test
```

Use `npm run ci` for core quality gates; CI additionally runs E2E and IPC channel checks.  
See `docs/TESTING.md` for test patterns, priorities, and the manual QA checklist.

## Pull Request Checklist

- [ ] Formatting passes (`npm run format:check`)
- [ ] Lint passes (`npm run lint`)
- [ ] Tests pass (`npm test`)
- [ ] Manual checklist reviewed/completed when user flows change (`docs/TESTING.md`)
- [ ] Docs updated for new behavior or configuration
- [ ] PR template is fully completed with clear test notes

---

<p align="center">
  Thank you for helping make StratoSort Stack better!
</p>

# Contributing

Use Node.js 24.22.0 and install dependencies with `npm ci`.
Run `npm run check` before submitting a pull request. These local checks need no provider credentials and place no calls.

For a bug fix, add a regression test that fails before the fix and passes afterward.
Use synthetic providers and temporary directories for operational tests.
Do not replace runtime tests with mocks of the component under test.
Read [AGENTS.md](AGENTS.md) for the repository layout and command boundaries.

Keep changes focused and describe the behavior, reason, and validation in the pull request.
Use fictional examples and remove private data from screenshots and logs.
Follow [SECURITY.md](SECURITY.md) for sensitive reports.
New commands and configuration fields also need documentation.

Local tests do not authorize paid simulations, provisioning, deployment, agent updates, or real telephone calls.
Those actions require explicit authorization and the reviews described in [deployment](docs/DEPLOYMENT.md).

Contributions use the repository's [MIT license](LICENSE).

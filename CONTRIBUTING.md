# Contributing to PA Code

Thanks for your interest in improving PA Code! This is a community project and
contributions of all kinds are welcome — bug reports, fixes, features, docs and
tests.

## License of contributions

PA Code is licensed under the **Apache License 2.0**. By contributing, you agree
that your contributions are licensed under the same license (Apache-2.0, see
[LICENSE](LICENSE)), as stated in section 5 of the license.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a CLA. It's a lightweight statement that you have the right to submit
your contribution under the project's license. To sign off, add a `Signed-off-by`
line to each commit — Git does this automatically with the `-s` flag:

```
git commit -s -m "Fix: correct dimension binding in rule check"
```

This adds a line like:

```
Signed-off-by: Your Name <your.email@example.com>
```

Make sure the name and email match your Git configuration.

## How to contribute

1. **Open an issue first** for larger changes so we can discuss the approach.
2. **Fork** the repository and create a feature branch.
3. **Build & verify** locally:
   - `npm install`
   - `npm run watch` (or a production build: `npx webpack --mode production`)
   - Load the extension with **F5** (Extension Development Host) and test your change.
4. **Keep changes focused** — one logical change per pull request.
5. **Update the CHANGELOG** (`CHANGELOG.md`) under the current unreleased/next
   version with a short, user-facing note.
6. **Open a pull request** with a clear description of what and why. Reference any
   related issue.

## Coding guidelines

- TypeScript, matching the existing style in `src/`.
- Prefer small, readable functions; comment only what the code cannot show on its own.
- Do not introduce new runtime dependencies without discussion.
- Webview code must keep its Content-Security-Policy and escape any server-provided data.

## Security

Please do **not** open public issues for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for how to report them responsibly.

## Code of conduct

Be respectful and constructive. We want PA Code to be a welcoming project for
everyone.

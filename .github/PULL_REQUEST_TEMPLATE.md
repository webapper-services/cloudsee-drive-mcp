## Summary

<!-- What does this PR change and why? Reference the related GitHub issue (e.g. #123) if applicable. -->

## Type of change

- [ ] `fix:` bug fix
- [ ] `feat:` new feature
- [ ] `docs:` documentation only
- [ ] `refactor:` / `chore:` / `test:`
- [ ] Breaking change (`feat!:` or `BREAKING CHANGE:` footer)

## Checklist

- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] `npm run lint && npm run typecheck && npm test && npm run build` all pass
- [ ] New/changed tools wrap a real endpoint; `contract/registry.snapshot.json` updated if the API surface changed (`npm run sync:contract`)
- [ ] Destructive tools route through the two-step confirm helper
- [ ] No secret is logged, returned, or committed; logging stays on stderr

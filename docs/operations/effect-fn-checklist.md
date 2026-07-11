# Effect.fn Maintenance Checklist

This is a living review guide, not a generated inventory. The former checklist
contained stale counts and absolute paths from another checkout, so it was
retired during the Tauri migration cleanup.

## When To Refactor

Consider `Effect.fn` when a named function primarily wraps
`Effect.gen(function* () { ... })` and the wrapper adds no useful boundary of
its own. Do not perform a mechanical repository-wide rewrite. Keep a normal
function when it improves overloads, public API shape, inference, or readability.

```ts
const loadProject = Effect.fn("loadProject")(function* (projectId: ProjectId) {
  const store = yield* ProjectStore;
  return yield* store.get(projectId);
});
```

The optional transformation arguments may add shared tracing, logging, or error
handling when that policy belongs to the function boundary.

## Review Checklist

- Use a stable operation name suitable for traces.
- Preserve the original success, error, and requirement types.
- Keep input types explicit when inference becomes difficult.
- Avoid changing behavior while changing function form.
- Add or update focused tests for error and interruption behavior.
- Check `.repos/effect-smol/LLMS.md` and vendored examples before introducing a
  new Effect pattern.
- Run focused tests, then `vp check` and `vp run typecheck`.

Candidate discovery is intentionally performed against the current tree during
the change. Do not treat historical candidate counts as an active backlog.

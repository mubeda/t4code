# Chat Links Internal Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every normal HTTP(S) link activation in AI chat open T4Code's internal Browser while preserving fragment, file-link, non-HTTP, and context-menu behavior.

**Architecture:** Keep link routing inside `ChatMarkdown`, which already owns `openUrlInPreview` and the native context menu. Add a small pure HTTP(S) classifier, cover it through behavior tests, and route only those anchors through the existing preview command.

**Tech Stack:** React 19, TypeScript, react-markdown, Effect Atom command results, Vite+ test, happy-dom.

## Global Constraints

- Every `http://` and `https://` chat link opens the internal Browser by default.
- Same-document fragments retain existing in-chat navigation.
- File links and non-HTTP schemes retain existing behavior.
- The context menu retains integrated-browser and system-browser choices.
- Do not introduce a second Browser-opening API.
- Use TDD: observe each new test fail before production changes.
- `vp check` and `vp run typecheck` must pass before completion.

## File Structure

- Modify `apps/web/src/components/ChatMarkdown.tsx`: classify HTTP(S) anchors and dispatch normal activation through `openExternalLinkInPreview`.
- Modify `apps/web/src/components/ChatMarkdown.behavior.test.tsx`: browser-routing and failure regression coverage using the existing preview mocks.
- Verify `apps/web/src/components/ChatMarkdown.test.tsx` unchanged: render-only cases without thread context retain `_blank` fallback attributes.

---

### Task 1: Route normal HTTP(S) activation into the internal Browser

**Files:**
- Modify: `apps/web/src/components/ChatMarkdown.tsx:1377-1453`
- Test: `apps/web/src/components/ChatMarkdown.behavior.test.tsx:145-160,345-430`
- Verify: `apps/web/src/components/ChatMarkdown.test.tsx:275-315`

**Interfaces:**
- Consumes: `openExternalLinkInPreview(url: string): Promise<AtomCommandResult<void, BrowserPreviewUnavailableError>>`
- Produces: `isHttpUrl(href: string | undefined): boolean` and an anchor click handler that opens preview exactly once.

- [ ] **Step 1: Add failing normal-click and failure-reporting tests**

Add these cases to `describe("ChatMarkdown external-link behavior", ...)`:

```tsx
it("opens normal HTTP(S) link activation in the integrated browser", async () => {
  const link = await mountExternalLink();
  const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });

  await act(async () => link.dispatchEvent(click));
  await flush();

  expect(click.defaultPrevented).toBe(true);
  expect(mocks.openUrlInPreview).toHaveBeenCalledOnce();
  expect(mocks.openUrlInPreview).toHaveBeenCalledWith(
    expect.objectContaining({ threadRef, url: "https://example.test/docs" }),
  );
  expect(mocks.openExternal).not.toHaveBeenCalled();
});

it("reports a failed normal HTTP(S) preview open without falling back externally", async () => {
  const link = await mountExternalLink();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const cause = Cause.fail(new Error("preview rejected"));
  mocks.openUrlInPreview.mockResolvedValueOnce(AsyncResult.failure(cause));

  await act(async () => link.click());
  await flush();

  expect(consoleError).toHaveBeenCalledWith(
    "[chat-markdown] action failed",
    { operation: "open-link-in-preview", target: "https://example.test/docs" },
    cause,
  );
  expect(mocks.openExternal).not.toHaveBeenCalled();
});
```

Add a mount helper and preservation test for a non-HTTP scheme:

```tsx
async function mountMailtoLink(): Promise<HTMLAnchorElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <ChatMarkdown text="[Email](mailto:hi@example.test)" cwd="/workspace" threadRef={threadRef} />,
    ),
  );
  return container.querySelector<HTMLAnchorElement>('a[href="mailto:hi@example.test"]')!;
}

it("does not route non-HTTP schemes into the integrated browser", async () => {
  const link = await mountMailtoLink();
  await act(async () => link.click());
  await flush();
  expect(mocks.openUrlInPreview).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused behavior test and confirm RED**

Run:

```powershell
corepack pnpm --filter @t4code/web exec vp test run src/components/ChatMarkdown.behavior.test.tsx --project unit
```

Expected: FAIL because a normal HTTP(S) click does not call `openUrlInPreview` or prevent default navigation.

- [ ] **Step 3: Add the minimal HTTP(S) classifier and click dispatch**

Near the existing URL helpers in `ChatMarkdown.tsx`, add:

```ts
export function isHttpUrl(href: string | undefined): href is string {
  return typeof href === "string" && /^https?:\/\//i.test(href);
}
```

In the markdown anchor renderer, derive `opensInPreview` and replace the external-link click behavior with:

```tsx
const isSameDocumentLink = href?.startsWith("#") ?? false;
const opensInPreview = isHttpUrl(href) && Boolean(threadRef) && isPreviewSupportedInRuntime();
const onClick = props.onClick;

<a
  {...props}
  href={href}
  target={!isSameDocumentLink && !opensInPreview ? "_blank" : undefined}
  rel={!isSameDocumentLink && !opensInPreview ? "noopener noreferrer" : undefined}
  onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (isSameDocumentLink && href) {
      handleMarkdownFragmentClick(event, href);
      return;
    }
    if (!opensInPreview || !href) return;
    event.preventDefault();
    void openExternalLinkInPreview(href)
      .then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          reportMarkdownActionFailure(
            { operation: "open-link-in-preview", target: href },
            result.cause,
          );
        }
      })
      .catch((cause: unknown) => {
        reportMarkdownActionFailure({ operation: "open-link-in-preview", target: href }, cause);
      });
  }}
>
```

Keep the existing context-menu handler unchanged. Do not call `api.shell.openExternal` from the normal-click failure path.

- [ ] **Step 4: Run focused ChatMarkdown tests and confirm GREEN**

Run:

```powershell
corepack pnpm --filter @t4code/web exec vp test run src/components/ChatMarkdown.behavior.test.tsx src/components/ChatMarkdown.test.tsx --project unit
```

Expected: PASS. The new HTTP(S) tests pass; fragment, file-link, and native context-menu coverage remains green.

- [ ] **Step 5: Commit the chat-link fix**

```powershell
git add apps/web/src/components/ChatMarkdown.tsx apps/web/src/components/ChatMarkdown.behavior.test.tsx
git commit -m "fix(web): open chat links in internal browser"
```

### Task 2: Verify the subsystem and repository gates

**Files:**
- Verify only; no production files should change.

**Interfaces:**
- Consumes: completed HTTP(S) routing from Task 1.
- Produces: evidence that the subsystem and mandatory repository gates pass.

- [ ] **Step 1: Run the built-in Vite+ test command**

```powershell
vp test
```

Expected: PASS.

- [ ] **Step 2: Run repository checks**

```powershell
vp check
vp run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 3: Confirm the worktree contains only intended changes**

```powershell
git status --short
git diff --check
```

Expected: no whitespace errors and no unrelated files.

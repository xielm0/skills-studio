# DeepSeek Harness preview sources

These files were copied from `E:\Github\deepseek-harness` at commit `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` (MIT; licenses are preserved in each directory).

- `dsh-primitives/`: the transitive source files used by `MarkdownText` and `CodeBlock` from `packages/client/ui-primitives`.
- `dsh-theme/`: shared Markdown, code, and theme CSS from `packages/client/ui-primitives`.
- `dsh-viewer/`: Markdown frontmatter, code language selection, and preview CSS from `packages/client/ui-sidebar-documentpreview`.
- `dsh-ui/`: copied Dockkit, TextPreview and ChatView styles, the chat animation asset, their source snapshots, and the PathLabel component. `ChatPage.tsx` binds them to this app's conversation and file IPC.

PDF uses PDF.js's legacy build for the Electron 39 runtime. Office conversion and spreadsheet viewing are separate DSH services and are not included here. DSH's Cordis/Dockkit state graph cannot be imported directly into this Electron host; the copied view styles and layout are bound to this app's conversation and file IPC.

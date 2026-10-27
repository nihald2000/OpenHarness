<!-- BEGIN:nextjs-agent-rules -->
# Next.js: ALWAYS read docs before coding

Before any Next.js work, find and read the relevant doc in `node_modules/next/dist/docs/`. Your training data is outdated — the docs are the source of truth.

## Important Next.js 16 Notes
- Dynamic route `params` and `searchParams` are Promises and MUST be awaited (`const { id } = await params`).
- Request APIs (`cookies()`, `headers()`, `draftMode()`) are async.
<!-- END:nextjs-agent-rules -->

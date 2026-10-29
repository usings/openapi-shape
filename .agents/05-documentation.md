# Documentation

Read before writing, editing, or auditing reader-facing documentation.

Treat documentation as a reader-facing contract; scale checks to the impact of what it says, not merely to its file type.

- Organize around the reader's task, using a suitable form for the document's purpose. Split pages for independent tasks while keeping the instructions for a common operation connected; length or internal module boundaries alone do not justify a split.
- Ground commands, imports, flags, defaults, outputs, compatibility claims, and other consequential statements in current project evidence. Distinguish observed behavior from documented-but-unreproduced claims and illustrative examples. Never invent project capabilities or results.
- Put prerequisites before dependent steps. Explain placeholders, expected success, meaningful failures, limits, and cleanup where relevant. Prefer one canonical home for shared details and link to it.
- Follow the target renderer and existing terminology and style. Use semantic Markdown, accurate code fences, useful headings and links, and accessible alternatives to diagrams. Do not add decorative syntax or rely on unsupported extensions.
- Preserve working links, incoming heading anchors, examples, and established documentation contracts unless change is required. When updating generated docs, edit their source of truth where applicable.
- Remove filler, inflated claims, repeated summaries, and unnecessary formatting without deleting technical distinctions, warnings, or caveats.
- After behavior changes, rewrite the affected explanation to describe the current model; avoid accumulating exceptions that explain superseded designs.
- Verify affected snippets, links, anchors, and rendering where practical using existing project checks. Identify static-only reviews and unexecuted examples.

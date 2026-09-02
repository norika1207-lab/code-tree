// Shared agent discipline: make the AI choose the smallest correct change first.
// This is intentionally prompt-only so it can guard both the local tool-loop agent
// and the Claude SDK path without changing the tree renderer.
export function minimalDiscipline() {
  if (process.env.CODETREE_MINIMAL_DISCIPLINE === '0') return '';
  return `(Minimum correct change discipline)
- Start from the actual project state: list/read/search before diagnosing. Do not guess paths, project names, SSH state, or file contents.
- Prefer the smallest safe action that completes the task: use existing files, existing helpers, standard libraries, and installed tools before adding new files, dependencies, abstractions, wrappers, or future scaffolding.
- If the user asks to enter or inspect a project, find/open the project first and surface the tree. Do not stop at asking for a path unless reasonable local/remote searches have failed.
- Before editing, reduce blast radius: touch the fewest dependent files. If a change affects other files, name the affected files and then make the coordinated change.
- Never weaken validation, data-loss protection, security, SSH/PTY safety, permissions, accessibility, or any explicit user requirement.
- For non-trivial changes, run one focused check or test that proves the changed path works.
- Answer with the result and evidence, not a long plan.`;
}

# Code Tree

> Your AI is editing four files right now. You're watching one.

A coding-agent CLI whose view follows whatever file the agent touches. You type a prompt, the agent starts working, and the camera jumps to whichever cell it is editing. Hit Tab to see your whole codebase as a living tree. A token bar shows what you are burning (and what stale cache is wasting), and a safety gate stops the agent before anything irreversible.

It runs on Claude, borrowing your existing Claude Code login, so there is no separate API key to set up. No cloud login at all? It also drives a local model (Ollama, vLLM, llama.cpp) with zero login.

<p align="center">
  <img src="assets/world-tree-v3.gif" alt="Code Tree: a real Claude agent fixing a bug, watched live as a world-tree with a change ledger" width="900">
</p>

<p align="center">
  <sub>Real, unedited: a Claude agent fixes a bug while you watch. Left, the terminal. Right, the world-tree (every block a file, every line a dependency) with the camera following each edit. Top-right, the change ledger: every file it touched, the tokens it burned there, and a one-click revert. (<a href="assets/world-tree-v3.mp4">MP4</a>)</sub>
</p>

## Install

Run it with no install:

```
npx code-tree .
```

Or install globally:

```
npm i -g code-tree
code-tree .
```

Requires Node 18+. `.` means "open the current project"; pass a path to open a different one, just like `code .`.

## How it follows you

You never tell it which project. The core watches your shell, parses imports into a tree, and as the agent moves, the camera jumps to the file it is touching. Repeated edits flash red. Blocks are files, lines are imports. Nothing leaves your machine.

## Login

Code Tree reuses the session you already have from Claude Code (read from the macOS Keychain). Check the connection:

```
code-tree status
```

If it says it borrowed your Claude Code login, you are ready. If not, run `claude` once in your terminal to log in, then come back. You can also set `ANTHROPIC_API_KEY` instead.

## No-login local mode

Don't want to log into any cloud LLM? Code Tree can write code with a model running on your own machine, no account and no API key. It speaks the OpenAI-compatible protocol, so [Ollama](https://ollama.com), vLLM, llama.cpp server, and LM Studio all work.

The fastest path is Ollama:

```
brew install ollama        # or download from ollama.com
ollama pull qwen2.5-coder  # a small coding model that fits on a laptop
```

Then just run Code Tree. If you are not logged into Claude Code, it auto-detects the local model and uses it. To force local even when you are logged into Claude:

```
code-tree --local <path-to-your-project>
```

It probes, in order: the env vars `CODETREE_LOCAL_URL` / `CODETREE_LOCAL_MODEL` if set, then Ollama on `:11434`, then a generic OpenAI-compatible server on `:8000` or `:1234`. Point it at a beefier box on your network with:

```
CODETREE_LOCAL_URL=http://192.168.1.50:11434/v1 CODETREE_LOCAL_MODEL=qwen2.5-coder code-tree --local .
```

Local models are smaller than Claude, so expect rougher edits.

## Run it

In a real terminal (a TTY, so you can type):

```
code-tree <path-to-your-project>
```

<p align="center">
  <img src="assets/demo.gif" alt="The all-in-terminal view: agent transcript, flow trail, live token bar" width="820">
</p>

<p align="center">
  <sub>The all-in-terminal view, no browser: the agent transcript on the left, a flow trail on the right, the token bar climbing as it burns. (<a href="assets/demo.mp4">MP4</a>)</sub>
</p>

- Type a prompt, press Enter. The agent starts editing; the view follows it cell by cell.
- Tab toggles Focus view and the full Tree view.
- Ctrl+L re-measures wasted cache and shows what clearing would save.
- Ctrl+C to exit.

Want the full browser world-tree at the same time? Add `--web`:

```
code-tree --web <path-to-your-project>
```

A split view opens in your browser: a real terminal on the left, the live world-tree on the right. It follows what you do automatically; you never tell it which project.

## Try the demo (no login needed)

```
code-tree --demo
```

A scripted agent replays a scenario: it edits `session-store.js` three times chasing a bug (that cell flashes red and raises a "not converging" warning), then steps back and finds the real cause in `middleware.js`. Reproducible every run.

## What's inside

- World-tree: your whole codebase as a living tree, every block a file, every line an import. The camera follows the file the agent is editing; repeated edits flash red.
- Change ledger: a running list of every file the agent changed this session, with the tokens burned on each, and a one-click revert to its state at session start. The temporal view that survives compaction, because it lives on disk, not in the model's context.
- Cross-session memory: each finished task is recorded per project; the next similar task recalls it ("Recalled 3 past fixes"), so the agent gets more familiar with your codebase the more you use it.
- Token attribution: see where the tokens actually went, tied to the files that caused the burn.
- MASL safety gate: speaks up only on the four things that matter (irreversible shell commands, breaking a public interface others import, going off-script, thrashing the same file) instead of nagging on every edit.
- Remote projects over ssh: `code-tree host:/path` maps a codebase that lives on another machine, for people who do their real work over ssh. Blocks, import lines and revert all work over plain ssh.
- Session recording: the whole session is written to a txt transcript and a structured `.jsonl` for later review and training.
- Runs on Claude (borrowed Claude Code login, no extra key), or fully offline on a local model (Ollama / vLLM / llama.cpp) with zero cloud login.

## How it works

```
CLI (Ink) ─┐
           ├─ WebSocket :7778 ─ Core (file watcher + import parser + anomaly + agent runner)
Browser viz :7790 ─┘
```

Fully local. No server dependency, nothing leaves your machine.

## License

MIT © norika

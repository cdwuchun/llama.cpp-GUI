| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-attachment-local` | yes | Private content-addressed DSH_HOME attachment storage |

## boot

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-config-editor` | no | Persist plugin configuration through profile patches and Loader reconciliation |
| `@deepseek-ai/dsh-hmr` | yes | Coordinated module and profile configuration hot reload |
| `@deepseek-ai/dsh-plugin-manager` | yes | Current-profile plugin and bundle management shared by dsh CLI, Web and agent tools |

## browser-use

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-browser-use` | no | Exclusive named browser-use provider registration |

## bundle

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-acp-app` | no | The dsh ACP profile bundle: automation-only JSON-RPC stdio and process lifecycle over dsh-base |
| `@deepseek-ai/dsh-headless` | yes | The dsh one-shot bundle: a direct core Agent/Session runner over dsh-base with no Host, HTTP, or browser layer |
| `@deepseek-ai/dsh-sdk-app` | yes | The dsh SDK profile bundle: stdio JSON-RPC serving and process lifecycle over dsh-base |
| `@deepseek-ai/dsh-web-app` | yes | The dsh browser-surface bundle: the web patch layer over dsh-base plus the runtime glue plugin (frontend dist serving, web-surface prompt, bash runtime variables, URL line) |

## client

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-client-connection` | yes | Authenticated RPC transport and generation lifecycle |
| `@deepseek-ai/dsh-client-file-upload` | no | Agent-scoped browser file upload, streaming intake, and staged receipt service |
| `@deepseek-ai/dsh-client-hmr` | yes | Web client graph synchronization and rebuilt-bundle reload transport |
| `@deepseek-ai/dsh-client-locale` | no | Locale plugin: Host-backed preference, extensible language catalog, browser fallback, and typed built-in dictionaries |
| `@deepseek-ai/dsh-client-modules` | no | Client module system, dual-face: node half composes the __DSH_BOOT__ entry graph (incremental dsh.client scan, bundle route, index tap, webPlugins service); browser half is the lazy-CJS module table the vendored cordis Loader consumes as its internal seam |
| `@deepseek-ai/dsh-client-resources` | no | Unified client resource model: protocol-registered providers turn URL addresses into live values, consumed through the useResource global standard hook |
| `@deepseek-ai/dsh-client-shortcuts` | yes | Application keyboard command registry and physical-key routing |
| `@deepseek-ai/dsh-client-ui-agent-preset` | no | Agent-preset surfaces: the default for later sessions, this session's seat, and the composition editor |
| `@deepseek-ai/dsh-client-ui-approval` | no | Approval composer takeover over the scoped Remote Event waterfall |
| `@deepseek-ai/dsh-client-ui-attachment` | no | Dynamic attachment presentation plugin for conversation input, message-image, and trajectory image slots |
| `@deepseek-ai/dsh-client-ui-brand-official` | no | Official DeepSeek Harness brand occupants for the Web client's sidebar slots |
| `@deepseek-ai/dsh-client-ui-chat` | no | Chat Conversation target, node definitions, renderers, and details surface |
| `@deepseek-ai/dsh-client-ui-commands` | no | Client command surface: global directory cache, '/' source, three command UI kinds, popupSelect registry |
| `@deepseek-ai/dsh-client-ui-conversation` | no | Target-neutral Conversation assembly, shell, composer, queue, and view navigation |
| `@deepseek-ai/dsh-client-ui-deliverables` | no | Changed-files card with per-file comparison tabs, delivery cards, and clickable final-response file references for Web |
| `@deepseek-ai/dsh-client-ui-directory-picker-browse` | no | In-app directory browsing surface: the workspace directory-flow owner rendering the host's listing and creation primitives |
| `@deepseek-ai/dsh-client-ui-directory-picker-native` | no | Native directory-picker surface: the renderless workspace directory-flow occupant driving the local Desktop or Host OS chooser |
| `@deepseek-ai/dsh-client-ui-goal` | no | Session goal surface: GoalBar docked above the composer, read from the goal session projection |
| `@deepseek-ai/dsh-client-ui-input-trigger` | no | Input trigger pipeline: '/' and '@' detection, candidate menu, pick routing to registered sources |
| `@deepseek-ai/dsh-client-ui-jobs` | no | Session-header background-job list with on-demand streaming record panels |
| `@deepseek-ai/dsh-client-ui-layout` | no | Shell plugin: three-column AppFrame with drag handles, ctx.layout viewing-state service (navigation + panels) |
| `@deepseek-ai/dsh-client-ui-message-feedback` | no | The Web feedback surface: per-message Like/Dislike in the assistant-message action strip and the feedback dialog behind both ratings and /feedback, backed by the messageFeedback and sessionFeedback Host Remotes |
| `@deepseek-ai/dsh-client-ui-model-selection` | no | Model selection over the shared model catalog, Session projection, and session.selectModel |
| `@deepseek-ai/dsh-client-ui-open-in-app` | no | Web "Open In..." controls: the Session-header split button opening the workspace directory in an installed application, and the document preview's default-application controls for one file |
| `@deepseek-ai/dsh-client-ui-permission-presets` | no | Permission surfaces: a new-session default in General settings and a current-session /permission popup over the permissions projection |
| `@deepseek-ai/dsh-client-ui-plan` | no | Plan mode controls, persistent transcript plan cards, and sidebar Markdown previews |
| `@deepseek-ai/dsh-client-ui-plugin-manager` | yes | Plugin management for the dsh web client: the sidebar Plugins panel installs, enables, disables, retries, and composes installed plugin packages |
| `@deepseek-ai/dsh-client-ui-reference` | no | Unified Web @file and @session reference source |
| `@deepseek-ai/dsh-client-ui-renderer` | no | Browser UI renderer: React slot bindings, ctx.uiRenderer, and the assembled application root |
| `@deepseek-ai/dsh-client-ui-schedule` | no | Host task management page and Session reminder catalog |
| `@deepseek-ai/dsh-client-ui-session` | no | Session Controller adapter for React and session-scoped slots |
| `@deepseek-ai/dsh-client-ui-settings` | no | Settings domain base plugin: shared configuration forms and the canonical settings slot-type contract |
| `@deepseek-ai/dsh-client-ui-settings-account` | yes | Manage DeepSeek login and open Platform billing pages |
| `@deepseek-ai/dsh-client-ui-settings-agent-loop` | no | Settings page of the agent loop on the dsh web client's Plugins page: the parallel tool-call cap of the agent-loop namespace |
| `@deepseek-ai/dsh-client-ui-settings-general` | no | Settings ownerless-copy and product onboarding plugin: the General section, shell trigger/header chrome content, settings dictionaries, and the versioned welcome notice |
| `@deepseek-ai/dsh-client-ui-settings-models` | yes | Models settings and shared product-onboarding dialogs over existing settings and credential joins |
| `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` | no | Read-only Cordis Loader inventory tab in Web Plugins settings |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | no | Built-in plugins settings section for the dsh web client: the Settings navigation entry and the tab chrome feature-owned tabs register into |
| `@deepseek-ai/dsh-client-ui-settings-shell` | no | Settings page of the shell executor on the dsh web client's Plugins page: the command timeout and the per-stream output cap of the shell namespace |
| `@deepseek-ai/dsh-client-ui-settings-subagent` | no | Settings page of Subagent delegation on the dsh web client's Plugins page: recursion depth, parallel capacity, and the models agents may choose for subagents |
| `@deepseek-ai/dsh-client-ui-settings-web-search` | no | Settings page of the DeepSeek web-search provider on the dsh web client's Plugins page: its API key, endpoint, and per-request search budget |
| `@deepseek-ai/dsh-client-ui-shortcuts` | no | Keyboard shortcut reference, recording, and local preference editing |
| `@deepseek-ai/dsh-client-ui-sidebar` | no | Sidebar plugin: session multi-level tree, search, grouping, state dots |
| `@deepseek-ai/dsh-client-ui-sidebar-browser` | no | Sandboxed Web browser tabs for the right Sidebar |
| `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` | yes | Extensible Sidebar previews for Office documents, spreadsheets, Markdown, code, images, PDF, HTML, and plain text |
| `@deepseek-ai/dsh-client-ui-sidebar-files` | no | Workspace file tree tab type for the right Sidebar: lazy directory listing over the workspaceFiles Remote namespace, opening files into the Sidebar |
| `@deepseek-ai/dsh-client-ui-sidebar-right` | no | Right Sidebar: the docking surface's session-bound state, its panel and header expand control, and the navigation service over it |
| `@deepseek-ai/dsh-client-ui-sidebar-terminal` | no | Interactive shell tabs for the right Sidebar |
| `@deepseek-ai/dsh-client-ui-skill` | no | Web skill references and the dedicated skill tool row |
| `@deepseek-ai/dsh-client-ui-subagent` | no | Subagent conversation catalog, continuation routing UI, and '@' reference source |
| `@deepseek-ai/dsh-client-ui-theme` | yes | Theme plugin: Host bootstrap for the pre-plugin palette; DOM-free ThemeRuntime for light/dark/system state; --dsw-* token styles and Appearance settings row |
| `@deepseek-ai/dsh-client-ui-tool` | no | Client Tool call-tree renderer and keyed per-tool presentation slot |
| `@deepseek-ai/dsh-client-ui-trajectory` | no | Trajectory event ledger with an interactive timing overview: pure-consumer plugin registering into the conversation ViewMap (no service) |
| `@deepseek-ai/dsh-client-ui-user-questions` | no | Web ask_user_question composer takeover and plan-review presentation UI |
| `@deepseek-ai/dsh-client-ui-workflow-run` | no | Durable workflow-run Conversation Node and nested member disclosure for dsh web |
| `@deepseek-ai/dsh-client-ui-workspace` | no | Workspace picker plugin: one WorkspacePicker registered into the sidebar and empty-state workspace slots |

## compaction

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-command-compact` | no | Human-facing slash command for explicit session compaction |
| `@deepseek-ai/dsh-compaction-basic` | yes | Token-meter-driven compaction policy and LLM summarization backend for the DeepSeek Harness |
| `@deepseek-ai/dsh-compaction-image-offload` | no | Durable image offload for image-capable routes: replace over-budget request images with placeholders and retry |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | yes | Replay-safe model-free head/middle/tail pruning for tool-result surface nodes |

## computer-use

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-computer-use` | no | Exclusive named computer-use provider registration |

## context

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-agent-instructions` | yes | Workspace context loader for AGENTS.md/CLAUDE.md instruction files |
| `@deepseek-ai/dsh-file-reference-local` | yes | Local-filesystem ctx.fileReferences provider with bounded fuzzy indexes |
| `@deepseek-ai/dsh-session-reference` | yes | Cross-session snapshot references and durable untrusted model context (ctx.sessionReferenceResolver) |
| `@deepseek-ai/dsh-time-context` | yes | Durable per-step context with the current time and elapsed time |
| `@deepseek-ai/dsh-tmux-context` | yes | Opt-in durable per-step context with this agent's tmux pane and window location |

## core

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-agent` | no | Agent interface, registry, initiator scope, and event vocabulary for the DeepSeek Harness |
| `@deepseek-ai/dsh-agent-default-model` | yes | Default model selection shared by Agent entry points |
| `@deepseek-ai/dsh-agent-loop` | yes | The concrete agent loop plugin for the DeepSeek Harness |
| `@deepseek-ai/dsh-agent-tool-presentation` | yes | Agent-plane presentation selector: composes one agent's tools as PTC mode, native, or both |
| `@deepseek-ai/dsh-session` | no | Event-sourced session store for the DeepSeek Harness |
| `@deepseek-ai/dsh-system-prompt` | yes | System prompt assembly registry for the DeepSeek Harness |
| `@deepseek-ai/dsh-tools` | yes | Tool registry and execution pipeline for the DeepSeek Harness |

## credentials

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-authorization` | no | Authorization seam (ctx.authorization): plugin-owned flows that obtain a credential through a conversation with the human |
| `@deepseek-ai/dsh-credentials-local` | yes | File-backed credentials provider ($DSH_HOME/.env under the live process environment) for the DeepSeek Harness |
| `@deepseek-ai/dsh-deepseek-account-platform` | yes | Authorize DeepSeek accounts through browser PKCE |

## deliverables

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-tool-present` | yes | Explicit workspace file delivery declarations for the DeepSeek Harness |
| `@deepseek-ai/dsh-workspace-changes` | yes | Per-turn workspace file changes recorded from git working-tree snapshots and whole-file captures, with per-file comparisons, for the DeepSeek Harness |

## document

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-office-to-pdf` | yes | Shared Office-to-PDF conversion with bounded queues and caching |

## experimental

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-experimental-agent-team` | yes | Implicit-root Agent Teams roster, durable peer mailbox, and shared task DAG |
| `@deepseek-ai/dsh-experimental-api-speech-to-text` | yes | Authenticated experimental speech transcription for browser clients |
| `@deepseek-ai/dsh-experimental-auto-review` | no | Per-tool LLM authorization review for the DeepSeek Harness Auto permission preset |
| `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp` | yes | Experimental per-Session Chromium browser tools through chrome-devtools-mcp |
| `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` | yes | Experimental per-Session Chromium browser tools through @playwright/mcp |
| `@deepseek-ai/dsh-experimental-browser-use-stagehand-native` | yes | Experimental Stagehand browser tools with separately configured native models |
| `@deepseek-ai/dsh-experimental-client-ui-agent-team` | no | Web Agent Teams roster, task board, and teammate navigation |
| `@deepseek-ai/dsh-experimental-client-ui-voice-input` | no | Record speech and insert editable text into the conversation draft |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp` | yes | Experimental computer use through an installed Cua Driver MCP executable |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` | no | Experimental computer-use provider embedding the Cua Driver native npm SDK |
| `@deepseek-ai/dsh-experimental-inspector` | yes | Experimental cross-realm CDP hub for Host debugging and Client Runtime inspection |
| `@deepseek-ai/dsh-experimental-ptc-runtime-python` | yes | CPython subprocess implementation of the DeepSeek Harness PTC execution seam |
| `@deepseek-ai/dsh-experimental-speech-to-text` | yes | Experimental speech recognition with independently selectable providers |
| `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` | yes | Local SenseVoice ONNX transcription with a managed sherpa-onnx process |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | yes | Scoped model-facing Agent Teams tools over ctx.agentTeams |

## extensions

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-cordis` | no | Cordis dynamic-plugin definition card: the keyed cordis_define tool row with its run/stop switch |
| `@deepseek-ai/dsh-cordis-client-runner` | no | Browser half of dynamic dual-half plugin packages: event subscription, closure evaluation, guard facade, and loader entries |
| `@deepseek-ai/dsh-cordis-host-runner` | yes | Dynamic package definition registry, host-half sandbox lifecycle, and invoke handler table for model-mounted dual-half packages |
| `@deepseek-ai/dsh-tool-cordis` | no | Read-only runtime API inspection for Harness plugin development |

## feedback

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-command-feedback` | no | Log-only session feedback: the record event, the sessionFeedback Host Remote, and the human-facing slash command |
| `@deepseek-ai/dsh-message-feedback` | yes | Canonical Session-log ratings and notes for finalized assistant messages |

## fs

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-fs-local` | yes | Local-filesystem implementation of the DeepSeek Harness filesystem seam (ctx.fs) |
| `@deepseek-ai/dsh-fs-observation-policy` | no | File-context policy plugin for the DeepSeek Harness — observed-state, read-before-edit, and version-guarded write/edit added over the ctx.fs provider seam through the fs/* event gate (no service API) |
| `@deepseek-ai/dsh-fs-sandbox` | yes | Sandbox-enforcing implementation of the DeepSeek Harness filesystem seam: fences write/edit by the per-call sandbox mode (read-only denies mutation, workspace-write contains it to the workspace + temp roots) while reads pass through |
| `@deepseek-ai/dsh-tool-fs` | yes | Model-facing filesystem tools (read, write, edit) over the DeepSeek Harness filesystem seam (ctx.fs) |
| `@deepseek-ai/dsh-tool-fs-search` | yes | Model-facing filesystem discovery tools (glob, grep) backed by the packaged ripgrep binary (@vscode/ripgrep) |
| `@deepseek-ai/dsh-tool-str-replace-editor` | yes | Model-facing view, create, literal replace, and line insert tool over the Harness filesystem service |

## goal

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-command-goal` | no | Human-facing slash command for persisted same-session goals |
| `@deepseek-ai/dsh-goal` | yes | Event-sourced same-session goal state and lifecycle service for the DeepSeek Harness |
| `@deepseek-ai/dsh-goal-round-driver` | no | Race-fenced same-session goal-round driver |
| `@deepseek-ai/dsh-tool-goal` | yes | Model-facing same-session goal tools with execution-time authority checks |

## guard

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-repeat-tool-reminder` | yes | Repeat-tool-call guard plugin: advisory reminders when an agent loops on identical tool calls |
| `@deepseek-ai/dsh-tool-call-timeout-policy` | no | Tool-call timeout policy: a tools/execute wrapper that arms a per-tool deadline on exec.signal and returns TOOL_TIMEOUT when it wins |

## hooks

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-hooks-claude-code` | yes | Bridge plugin: run a Claude Code hooks.json / settings hook config on the DeepSeek Harness interception seams |
| `@deepseek-ai/dsh-hooks-codex` | yes | Bridge plugin: run a Codex hooks.json hook config on the DeepSeek Harness interception seams |

## host

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-host-directory-picker-auto` | no | Adaptive chooser of the directory-picker seam: resolves the host situation at boot and mounts the native or browse backend for the DeepSeek Harness web GUI host |
| `@deepseek-ai/dsh-host-directory-picker-browse` | yes | In-app browsing backend of the directory-picker seam (listing/creation primitives over the host filesystem) |
| `@deepseek-ai/dsh-host-directory-picker-native` | no | Native-OS-chooser backend of the directory-picker seam for the DeepSeek Harness web GUI host |
| `@deepseek-ai/dsh-host-frontend-static` | yes | SPA dist server for the Web shell: owns the webserver fallback seat, serving explicit index entries and static assets with traversal rejection and 404 misses |
| `@deepseek-ai/dsh-host-open-in-app` | yes | Host half of open-in-app: resolved application catalog, icons, and the launch endpoint as three webServer routes |
| `@deepseek-ai/dsh-host-plugin-inventory` | no | Read-only Remote projection of current Cordis Loader plugin state |
| `@deepseek-ai/dsh-host-product-telemetry-otel` | yes | Explicit product usage events exported through OpenTelemetry HTTP logs |
| `@deepseek-ai/dsh-host-webserver` | yes | Web route-registration plugin: HTTP and upgrade routes, index transform taps, and static dist fallback; knows no harness concepts |

## interaction

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-commands` | no | Plugin-owned human command registry for DeepSeek Harness UIs |
| `@deepseek-ai/dsh-permission-presets` | yes | User-facing permission presets (ctx.permissionPresets) for the DeepSeek Harness: one product-level Permissions select bundling the sandbox-mode and approval-policy knobs, written through to their own session events |
| `@deepseek-ai/dsh-tool-ask-user` | no | Model-facing ask_user_question tool over the ctx.userQuestions seam |
| `@deepseek-ai/dsh-user-approval` | yes | User-approval seam (ctx.approval) for the DeepSeek Harness: one-shot permission decisions dispatched to composed answerers over the approval/request waterfall, fail-closed by default |
| `@deepseek-ai/dsh-user-questions` | no | Abstract user-questions seam (ctx.userQuestions) for asking the human during agent runs |

## jobs

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-jobs-local` | yes | Process-local implementation of the DeepSeek Harness background job registry seam |
| `@deepseek-ai/dsh-tool-jobs` | yes | Model-facing background job control tools (job_output, job_list, job_kill) over the ctx.jobs registry |

## llm

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-deepseek-llm-api-extensions` | no | Additive request-field registry for the official DeepSeek LLM API adapter |
| `@deepseek-ai/dsh-llm` | no | Provider-neutral LLM service interface for the DeepSeek Harness |
| `@deepseek-ai/dsh-llm-deepseek-account` | yes | DeepSeek account provider authentication and discovery |
| `@deepseek-ai/dsh-llm-deepseek-api-key` | yes | DeepSeek api-key provider authentication and discovery |
| `@deepseek-ai/dsh-llm-pi-ai` | yes | pi-ai-backed DeepSeek adapter for the DeepSeek Harness LLM seam (design-verification twin of dsh-llm-deepseek) |
| `@deepseek-ai/dsh-llm-retry` | yes | Provider-routed LLM request retry policy for the DeepSeek Harness |
| `@deepseek-ai/dsh-plugin-package-inventory-deepseek` | yes | Active Loader-backed plugin package inventory for official DeepSeek LLM API requests |
| `@deepseek-ai/dsh-token-meter` | yes | Replay-aware token measurement service (ctx.tokenMeter) for the DeepSeek Harness |

## lsp

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-lsp` | no | Abstract LSP capability seam (ctx.lsp) for the DeepSeek Harness — language-server provider registry keyed by branded id and extension mapping, order-independent per-query selection, normalized definition/references/implementation/hover requests and results, and the LspError taxonomy |
| `@deepseek-ai/dsh-lsp-stdio` | yes | Generic stdio language-server provider for the DeepSeek Harness LSP capability seam (ctx.lsp) — spawns configured servers, translates JSON-RPC, and serves transient-open goToDefinition/findReferences/goToImplementation/hover queries in the host filesystem namespace |
| `@deepseek-ai/dsh-tool-lsp` | yes | Model-facing lsp tool over the DeepSeek Harness LSP capability seam (ctx.lsp) — one read-only tool with goToDefinition/findReferences/goToImplementation/hover operations, one-based UTF-16 cursor coordinates, bounded location rendering, and hover normalization |

## mcp

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-mcp-client` | yes | MCP client bridge: connects to MCP servers and registers their tools on ctx.tools |
| `@deepseek-ai/dsh-mcp-resources` | no | Scoped MCP resource discovery and reading through shared model tools |

## plan

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-plan-mode` | yes | Logged per-agent plan mode with deployment guidance, a direct slash command, and a user-reviewed exit |

## preset

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-agent-preset` | yes | Declare an Agent capability composition in Cordis YAML |
| `@deepseek-ai/dsh-agent-preset-registry` | yes | Declarative Agent preset registry and profile-backed editing |
| `@deepseek-ai/dsh-persona` | yes | Composition-authored deployment persona section for the DeepSeek Harness |

## ptc-runtime

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-ptc-runtime-node` | yes | Sandboxed Node process implementation of the DeepSeek Harness PTC execution capability |

## runtime-diagnostics

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-invariants` | yes | Registry service for package-owned DeepSeek Harness runtime invariants |

## sandbox

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-sandbox-local` | yes | Local process-sandbox backends for the DeepSeek Harness sandbox seam: bwrap, the npm-distributed landlock-run launcher, macOS Seatbelt, or the Windows ACL restricted-token runner — functionally probed, fail-closed |
| `@deepseek-ai/dsh-sandbox-policy` | yes | Per-call sandbox policy resolver and current model context: deployment fallbacks plus each session's mode and workspace root, shared by every enforcing capability family |

## schedule

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-schedule` | yes | Host-wide durable reminders with shared management and original-Session delivery |

## sdk

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | yes | Stdio JSON-RPC server plugin for out-of-process DeepSeek Harness SDK clients |

## session

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-session-checkpoint-policy` | no | Semantic session durability checkpoints before model requests and tool side effects |
| `@deepseek-ai/dsh-session-log-deepseek` | yes | Incremental lossless session-log request extension for the official DeepSeek LLM API |
| `@deepseek-ai/dsh-session-persistence-jsonl` | yes | JSONL durable session persistence backend for the DeepSeek Harness |
| `@deepseek-ai/dsh-session-projection` | no | Session-projection seam: the merge-extensible projection type table, the provider contract, and the ctx.sessionProjections registry serving whole current values of log-derived per-session state |
| `@deepseek-ai/dsh-session-projection-cache` | yes | Persisted projection cache (ctx.sessionProjectionCache): durable per-session checkpoint records on the session_projcache storage domain (per-record layout), throttled write-behind, and the cached listing read |
| `@deepseek-ai/dsh-session-stats` | no | Whole-log conversation counts and wall times projection (sessionStats) for the DeepSeek Harness |
| `@deepseek-ai/dsh-session-telemetry-otel` | yes | OpenTelemetry backend for the DeepSeek Harness telemetry seam: hands captured session records to the OTel JS SDK's log pipeline |
| `@deepseek-ai/dsh-session-title` | yes | Log-backed session title service and provider registry for the DeepSeek Harness |
| `@deepseek-ai/dsh-session-title-all-prompts-llm` | yes | All-user-messages LLM provider plugin for DeepSeek Harness session titles |
| `@deepseek-ai/dsh-session-title-first-prompt-llm` | yes | First-message LLM provider plugin for DeepSeek Harness session titles |
| `@deepseek-ai/dsh-session-turn-outline` | no | Whole-log turn outline projection (turnOutline) for the DeepSeek Harness |

## session-query

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-session-log-export` | yes | Web Session-log export command and shared download dialog |
| `@deepseek-ai/dsh-session-query-sqlite` | yes | Concrete ctx.sessionQuery backend with SQLite FTS5 search |
| `@deepseek-ai/dsh-tool-session-query` | yes | Workspace-authorized model-facing session history search, trace, and event read tools |

## settings

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-settings` | no | Abstract user-settings seam (ctx.settings) for the DeepSeek Harness |

## shell

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-bash-local` | yes | Local-subprocess implementation of the DeepSeek Harness bash executor seam |
| `@deepseek-ai/dsh-bash-sandbox` | yes | Sandbox-consuming implementation of the DeepSeek Harness bash executor seam (confines every command via ctx.sandbox, reports denial/enforcement result facts) |
| `@deepseek-ai/dsh-pwsh-local` | yes | Local PowerShell implementation of the DeepSeek Harness bash executor seam |
| `@deepseek-ai/dsh-pwsh-sandbox` | yes | Sandbox-consuming implementation of the DeepSeek Harness PowerShell executor seam (confines every command via ctx.sandbox, reports denial/enforcement result facts) |
| `@deepseek-ai/dsh-shell-env` | yes | Tool-independent managed DSH_* shell environment registry |
| `@deepseek-ai/dsh-tool-bash` | yes | Model-facing bash tool with optional generic background-job and sandbox-escalation support |
| `@deepseek-ai/dsh-tool-bash-persistent` | yes | Model-facing owner-scoped persistent Bash tool backed by the Harness PTY service |
| `@deepseek-ai/dsh-tool-pwsh` | yes | Model-facing pwsh tool over the bash executor seam |
| `@deepseek-ai/dsh-tool-pwsh-persistent` | yes | Model-facing owner-scoped persistent PowerShell tool backed by the Harness PTY service |

## skill

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-skill` | yes | Agent skill provider registry for the DeepSeek Harness |
| `@deepseek-ai/dsh-skill-badge` | no | Bundled dsh badge skill provider for DeepSeek Harness |
| `@deepseek-ai/dsh-skill-filesystem` | yes | Local filesystem skill provider for the DeepSeek Harness |
| `@deepseek-ai/dsh-skill-office` | yes | Bundled Word, PowerPoint, and Excel workflows and structural checks |
| `@deepseek-ai/dsh-tool-skill` | yes | Model-facing skill loading tool for the DeepSeek Harness |
| `@deepseek-ai/dsh-tool-workspace-dependencies` | yes | The load_workspace_dependencies tool: absolute paths into a bundled Python, Node.js, and pnpm payload |

## spill

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-spill-local` | yes | Local-filesystem implementation of the DeepSeek Harness spill storage seam (private session-scoped files) |
| `@deepseek-ai/dsh-spill-policy` | yes | Token-budgeted tool-result retention with recoverable text and image paths |

## ssh

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-fs-ssh` | no | Filesystem provider over the shared POSIX SSH helper |
| `@deepseek-ai/dsh-sandbox-ssh` | no | Remote POSIX sandbox argv provider over the shared SSH helper |
| `@deepseek-ai/dsh-ssh` | yes | Shared OpenSSH connection and versioned POSIX remote helper |
| `@deepseek-ai/dsh-subprocess-ssh` | no | Subprocess and terminal provider over the shared POSIX SSH helper |

## storage

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-storage` | no | Storage hub (ctx.storage): named backend registry plus mounted data-form facilities for the DeepSeek Harness |
| `@deepseek-ai/dsh-storage-domain` | yes | Domain data form (ctx.storage.domain): schema-validated, event-emitting KV domains over storage backends for the DeepSeek Harness |
| `@deepseek-ai/dsh-storage-json` | yes | JSON file KV storage backend for the DeepSeek Harness storage hub |
| `@deepseek-ai/dsh-storage-sqlite` | yes | SQLite storage backend (kv facet) for the DeepSeek Harness storage hub |

## subagent

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-subagent` | yes | Abstract subagent seam (ctx.subagents): named-provider registry for delegating to child agents |
| `@deepseek-ai/dsh-subagent-acp` | yes | Out-of-process ACP subagent backend: drives a child agent in a spawned subprocess over the Agent Client Protocol |
| `@deepseek-ai/dsh-subagent-claude-code` | yes | One-shot Claude Code subagent provider over the official Agent SDK |
| `@deepseek-ai/dsh-subagent-codex` | yes | One-shot Codex subagent provider over the official app-server protocol |
| `@deepseek-ai/dsh-subagent-dsh-sdk` | yes | Out-of-process SDK subagent backend: drives a child DeepSeek Harness runtime subprocess over stdio JSON-RPC through the TypeScript SDK client |
| `@deepseek-ai/dsh-subagent-fork-in-process` | yes | In-process fork subagent backend: runs a child agent seeded with a prefix of the parent's log |
| `@deepseek-ai/dsh-subagent-spawn-in-process` | yes | In-process spawn subagent backend: runs a fresh child agent on ctx.agents |
| `@deepseek-ai/dsh-tool-subagent` | yes | Model-facing subagent delegation tool over the ctx.subagents seam |
| `@deepseek-ai/dsh-tool-subagent-control` | no | Globally named send_message, interrupt_agent, and list_agents tools over ctx.subagents continuations |

## subprocess

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-subprocess-local` | no | Local-subprocess implementation of the DeepSeek Harness subprocess seam |

## terminal

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-terminal` | no | Persistent PTY session seam for the DeepSeek Harness — owner-scoped ids, backend registry, interactive sends, reads, signals, and awaited cleanup |
| `@deepseek-ai/dsh-terminal-bash` | yes | Persistent shell PTY backend over the DeepSeek Harness subprocess terminal primitive |
| `@deepseek-ai/dsh-tool-terminal` | yes | Six model-facing persistent PTY tools with owner isolation and generic background-job integration |

## test-support

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-llm-replay` | yes | Replay LLM plugin: short-circuits llm/stream with model chunks reconstructed from a recorded session JSONL (keyless snapshot tests) |

## todo

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-tool-todo` | yes | Model-facing todo_write tool over the DeepSeek Harness event-sourced session log |

## typert

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-typert-loader` | yes | Loader integration for generated Typert package contributions |

## web

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-tool-web` | yes | Model-facing web tools (web_search, web_fetch) over the DeepSeek Harness web capability seam (ctx.web) |
| `@deepseek-ai/dsh-web` | yes | Abstract web access capability seam (ctx.web) for the DeepSeek Harness — search/fetch provider registry, registration-order-independent selection, request/result vocabulary, and the WebError taxonomy |
| `@deepseek-ai/dsh-web-fetch-http` | yes | Anonymous public HTTP(S) fetch provider for the DeepSeek Harness web capability seam (ctx.web) |
| `@deepseek-ai/dsh-web-search-deepseek` | yes | DeepSeek-backed search provider (native web_search via the Anthropic-compatible API) for the DeepSeek Harness web capability seam (ctx.web) |
| `@deepseek-ai/dsh-web-search-exa` | yes | Exa-backed search provider for the DeepSeek Harness web capability seam (ctx.web) |
| `@deepseek-ai/dsh-web-search-perplexity` | yes | Perplexity-backed search provider for the DeepSeek Harness web capability seam (ctx.web) |

## webhook

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-webhook` | no | Fire-and-forget webhook rule runtime that creates Workspace-backed DeepSeek Harness Sessions |
| `@deepseek-ai/dsh-webhook-github` | yes | Signed GitHub HTTP webhook adapter for the DeepSeek Harness webhook runtime |

## workflow

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-tool-ralph` | yes | Model-facing fresh-agent Ralph loop over the workflow and subagent seams |
| `@deepseek-ai/dsh-tool-workflow` | yes | Model-facing workflow tool: run a JavaScript orchestration script over ctx.workflowEngine |
| `@deepseek-ai/dsh-workflow-ptc` | yes | Workflow orchestration in the shared sandboxed Node PTC runtime |

## workspace

| Package | Config | Description |
|---|---|---|
| `@deepseek-ai/dsh-workspace` | no | Workspace entity registry (ctx.workspaceRegistry): durable workspace records with validated session attachment over the domain data form for the DeepSeek Harness |
---
name: cordis-plugin-development
description: Use when adding, enabling, disabling, installing, configuring, or debugging a plugin, bundle, feature, page, panel, tool, or MCP connection in the current Harness profile, including a shipped plugin that is disabled by default, and for any visual object, decoration, or widget request that names no other destination, which means an installed UI plugin rendered in the Harness Web UI.
---

# Persistent Harness plugins

Use ordinary workspace files to author a bundle, then `plugin_manager` with `action: install_bundle` and the absolute package directory as `target` to install it in the current profile. Changes affect every session in that profile and survive restart. Load `editing-cordis-compositions` for agent preset changes.

Do not write the profile's `package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in the profile directory: `install_bundle` performs those steps, and each hand-made write outside the workspace needs its own approval. Every `plugin_manager` action, including `list_plugins` and `list_bundles`, also needs approval without Full access, so call it only when its result decides the next step.

## Enable a shipped plugin

A shipped bundle can resolve a plugin row and leave it `disabled`. The row id and its reason are in the shipped patch, `packages/bundle/*/cordis.patch.yml` in a source checkout. Write a workspace bundle whose patch overrides that row with `disabled: false` and inserts the Host rows it depends on; a source checkout's `apps/cli/config/examples/<feature>/cordis.yml` lists them for opt-in features. Packages shipped with dsh resolve from the dsh installation, so the bundle declares no dependencies on them. Install it with `install_bundle`.

## Deliver a working plugin first

1. Resolve the requested result and destination. An unspecified visual destination is the current Harness Web UI; a standalone image or HTML file does not complete such a request. Choose reasonable visual details and implement a small first version; install it before visual refinement.
2. Discover only the APIs needed for that version: `cordis_inspect_list`, then targeted `cordis_inspect_query` calls. For UI, query Client `Slots.listSubTree` and the selected slot's registration options and props. For anything beyond a static decoration, such as tool policy, agent context, session-derived state, or Chat rows, read `references/practices.md` before choosing the extension point. Once the chosen slot and registration API are known, write the plugin.
3. Read the matching template under `templates/` with the file-read tool and write its copies into one workspace directory, or write the installable package, patch, and required Host/Client files there yourself. Check JavaScript syntax and the manifest, then install it. Before that first installation, do not create preview HTML, mock shells, design variants, screenshot scripts, or rasterizer tooling. Use the installed plugin itself as the first preview.
4. Read the installation result: its `application` and `warnings` fields decide whether the change is live, not server logs, terminal output, process lists, or the page's boot payload. Confirm new rows with `cordis_inspect_query`, which needs no approval, rather than paging `list_plugins`. After `application: applied`, exercise the capability or inspect the live Client registration. Use the connected page for visual verification when browser control is available. For a page or panel, also verify design consistency: styles use only theme tokens, the plugin imports no Harness Client package such as `@deepseek-ai/dsh-client-ui-primitives`, the console shows no slot entry crash, and the view reads correctly in light and dark themes beside a comparable host page. State any verification limitation explicitly; installation and slot registration alone do not establish what the user can see.
5. Fix observed defects in the same plugin. When the requested result works, finish with its location and verification status. Do not continue speculative visual variants, optional features, or a new mock preview. Close any task list you created.

## Knowledge sources, in order

1. Inspection: `cordis_inspect_query` answers exact Service methods and Event modes (`Service`, `Event`), a mounted plugin's Config JSON Schema (`Config.listConfigs`: filter the paged directory by `name`, then query the `entry` id), the Tools this Agent can call (`Tool`), and live Client Slots and theme tokens (`Slots`, `Theme`).
2. Package documentation: `Config.listConfigs` with `name` set to the package finds its entries; querying one `entry` returns its `packageDir`, the resolved package directory. Read `<packageDir>/README.md`. Bundled packages resolve from the dsh installation and profile-installed bundles from the profile, so never guess the path from `$DSH_PROFILE_DIR`.
3. Source: installed packages ship built `lib/index.js` and `lib/types/**/*.d.ts` with JSDoc under that same `packageDir`, not `src/`; a source checkout of DSH has `packages/<group>/<name>/src`. Read them when inspection and the README leave a question open, and start source-level diagnosis from a concrete installation or runtime failure.

`DSH_PROFILE` (profile name) and `DSH_PROFILE_DIR` (its directory, whose `node_modules` holds only profile-installed bundles) are set in every shell call of a profile-launched Harness and absent when the Harness was booted without a profile. Bash reads them as `$DSH_PROFILE`; PowerShell, which the Windows preset uses, reads them as `$env:DSH_PROFILE`. With `dsh` on the PATH, `dsh --profile "$DSH_PROFILE" --dump-config` prints the composed profile.

## Read next

The files below live in this skill's base directory, which the `skill` tool reported, and the table is the complete list: do not enumerate that directory. In every deployment, including a source checkout, read these files with the file-read tool, write copies into the workspace with the file-write tool, and verify a copy by reading it back. In Desktop the directory sits inside `app.asar`, which only the Host process's own file reads can open; shell commands (`ls`, `cat`, `cp`, `cmp`), the glob and search tools (they run a native ripgrep process), `node`, and pnpm all fail on it. Never install or syntax-check a template in place; copy its contents into the workspace first.

| Task | File |
|---|---|
| Bundle manifest, display metadata and icon, install and enable semantics, Host plugin export forms, Config | `references/host-plugin.md` |
| A UI plugin rendered in the Web page: Client manifest, module loader, slot registration | `references/ui-plugin.md` |
| Connecting an MCP server through a configuration-only bundle | `references/mcp-bundle.md` |
| Verification limits when no browser control is available | `references/verification.md` |
| UI plugin starting point, four files | `templates/decoration/package.json`, `templates/decoration/cordis.patch.yml`, `templates/decoration/index.js`, `templates/decoration/client.js` |
| MCP bundle starting point, two files | `templates/mcp/package.json`, `templates/mcp/cordis.patch.yml` |
| Loader patch dialect and the list of installable plugin packages | the `cordis-composition-reference` skill |
| Choosing extension points, contexts, and state mechanisms for upgrade stability and performance | `references/practices.md` |
# Bundles and Host plugins

A bundle is a package whose `package.json` declares `dsh.bundle.patch`; the YAML patch inserts plugin entries. Give the package and rows unique names; use the Loader's existing YAML syntax, including `!!js` where expressions are needed. Read an existing patch before editing it: a matching override replaces the complete `config`.

## Manifest

A Host-only bundle needs no dependencies, install scripts, or build tool:

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

## Display metadata and icon

Plugin Manager cards, bundle details, component rows, and the Settings plugin inventory read display text and an icon from the manifest without activating the plugin. Put the title and description in `locale/en.json` (other languages such as `locale/zh.json` use the same fields), and declare the icon as a top-level `icon` in `package.json`:

```json
{ "meta": { "title": "My Decoration", "description": "Draws a badge under the composer." } }
```

```json
{
  "icon": "./icon.svg",
  "exports": { "./package.json": "./package.json", "./locale/*.json": "./locale/*.json" },
  "files": ["locale/*.json", "icon.svg"]
}
```

`icon` is a path relative to the manifest directory; SVG, PNG, JPEG, and WebP up to 256 KiB are accepted, while absolute paths, URLs, paths outside the directory, and symlinks leaving it are rejected. Missing fields fall back to `package.json` `name` and `description` and to the panel's default artwork; malformed metadata produces a diagnostic and keeps the valid text.

## Host plugin export forms

`index.js` exports one of these forms; do not mix them:

- `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
- A service class as the default export.

Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup. A plugin that declares `Config` validates the row's `config` at activation; query `Config.listConfigs` for an installed plugin's schema before writing its `config`, and follow `$defs` references in the returned document.

## Install, enable, and observe

`plugin_manager` `install_bundle` performs package installation and bundle selection; do not reproduce those steps with shell commands. Only pass `approvedBuilds` after the user explicitly approves the reported pending build scripts. Preserve returned failures and pending states; report success only after observing the requested capability.

`list_plugins` and `list_bundles` return exact identifiers for existing installations. `set_plugin` and `set_bundle` toggle them; `remove_bundle` removes a bundle. Inspect saved-state and activation outcomes separately: `failed` requires diagnosis, `overridden` means a higher-priority layer wins, and `restart-required` means the change is not live. Installing a new bundle can activate through HMR; replacing an installed package requires restart to load a fresh JavaScript module generation. Do not infer updated browser code from an unchanged slot id.
# Connect an MCP server

Read `templates/mcp/` with the file-read tool and write its files into your bundle directory. A configuration-only bundle's manifest needs a unique name, version, and `dsh.bundle.patch`, but no Host/Client entry files. Its patch, `templates/mcp/cordis.patch.yml`, inserts the already installed `@deepseek-ai/dsh-mcp-client` with `serverName`, `transport: streamable-http`, `url`, and `failOnStartupError: true`.

Replace the endpoint, install the bundle through `plugin_manager`, then call `mcp__demo__ping` or another newly available `mcp__<serverName>__<tool>` tool to verify the connection. For stdio, use `transport: stdio`, `command`, and optional `args`, `env`, and `cwd`; `Config.listConfigs` on the installed row returns the complete client schema. Ambient credentials are scrubbed; reference existing credentials with Loader `!!js` rather than copying secrets into conversation text. Repair the same bundle on failure instead of creating duplicates.
# Harness plugin practices

These rules follow from Harness mechanisms. Confirm every Service method, Event name, and dispatch mode named here with `cordis_inspect_query` (`Service`, `Event`) before relying on it; the installed Harness is the authority.

## Principles

1. **The session log is the only source of truth.** Anything the model sees must be reconstructable from committed session events; fork, resume, and replay derive from the log. Plugin memory is a derived cache.
2. **Registrations are effects owned by a context.** Plugin unload, agent disposal, slot collapse, and profile patches remove what was registered on the corresponding context. Choose the owning context. A registration on another context, such as `agent.ctx`, has two owners: keep its disposer in your plugin's own effect too, so either teardown removes it.
3. **The framework drives; the plugin computes.** Session projections, Conversation assembly, and slot rendering subscribe, cache, and publish for you. A plugin that subscribes, rescans, or writes DOM itself bypasses that incremental machinery.
4. **Extension points are shared; use the weakest mechanism that suffices.** From weakest to strongest: `ctx.tools.restrict()` can only remove tools; `ctx.tools.guard()` can only deny; waterfall listeners can rewrite and depend on registration order; `system-prompt/assemble` replaces the whole assembly. The stronger the mechanism, the more of other plugins' contributions you must preserve.
5. **Other plugins and other Harness versions read your data.** Unknown event types, older readers, and older cached state meet what you write; declare compatibility with the envelope fields and versions the Harness provides.
6. **Plugin UI is part of the Harness UI.** Users see one application, so a plugin uses the host's theme tokens, locale, and layout patterns, and matches the look and behavior of host components. Whether that is possible is decided by where the UI renders, so choose the rendering surface before writing any view; later styling inside the wrong surface cannot recover consistency.

## Stability

- A waterfall listener (`agent/pre-step`, `agent/request`, `llm/stream`, `tools/pre-execute`, `tools/execute`, `tools/post-execute`) that does not own the decision must return `next()`. When rewriting an `agent/pre-step` decision, spread it (`{ ...decision, messages }`) so fields such as `startsRequestSeries` survive.
- A denial that must hold regardless of order is a `ctx.tools.guard()`; a guard is synchronous, so a decision that must await something, such as asking the user, returns `ask` from `tools/pre-execute`. Hiding tools from one agent is `ctx.tools.restrict()` on that agent's context; it keeps schema presentation, lookup, and execution aligned. Observe final tool outcomes on `tools/result`; use `tools/post-execute` only to transform a result. Do not listen to `system-prompt/assemble` to add or remove tools or text.
- Add prompt text with `ctx.systemPrompt.section()`. Add per-agent context with `agent.inject()`; it is logged as `agent/inbox/spliced` at call time and enters the next admitted step. `agent/request` listeners cannot change request messages.
- Register per-agent behavior on `agent.ctx`, obtained in an `agent/created` listener, so it is removed when that agent is disposed. Wrap it in one `agent.ctx.effect()` and also keep that disposer, keyed by agent, in your plugin's own effect; unloading the plugin does not dispose `agent.ctx` registrations by itself.
- Put optional services in `inject` or `ctx.inject([...], ...)` so the plugin stays inactive in profiles without them instead of throwing.
- Do not append session events with a new `type`. Readers accept an unknown stored event only when its envelope carries `ignorable: true`, and live `Session.append()` cannot set that marker, so the Session would refuse to reopen. Derive state from existing events, or keep plugin-owned data in a storage service found through inspection.
- Put tunable values in the plugin's `Config` so users change them in `cordis.patch.yml`; the user's patch layer survives upgrades.

## Performance

- Keep per-session state derived from the log in a `ctx.sessionProjections` unit instead of subscribing to `session/event` and rescanning `session.events`. `apply(state, event)` is pure and synchronous and returns the same reference for events it ignores, so unchanged state costs nothing downstream. Read with `stateOf()`. A `view()` returns the same reference when its value is unchanged, which suppresses publication.
- Keep projection state plain JSON and bump `stateVersion` when fields or fold semantics change. The projection cache then checkpoints it, cold reads replay only the tail, and stale checkpoints are discarded.
- Wait on durable events such as `turn/end`, `assistant/message`, or `tool/result`; render live tokens from `agent/assistant-stream`. Do not poll `agent/status`. `whenIdle()` does not mean one follow-up finished: several inputs can share one running interval.
- A timer that starts work calls `agent.followup()`, which wakes the agent; `agent.inject()` does not wake it, so injected context can wait in the inbox until other input arrives. Clear the timer in the owning effect.

## UI

- Render plugin pages as React components in a slot. Do not serve an HTML page from the Host and embed it in an iframe: an iframe document does not receive the host's theme tokens, light/dark switching, or `ctx.locale`.
- Style with the theme tokens that `cordis_inspect_query` `Theme` lists (`--dsw-alias-*`); literal colors are for artwork only. Tokens are the lowest-risk way to match the host: a renamed token degrades appearance but never breaks rendering. Copy spacing, type sizes, and row patterns from an existing host page of the same kind; the Plugin Manager page is the reference for management lists.
- Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module; `dsh.client.inject` entries only order activation and stay allowed. They change without notice, a plain-JS plugin has no type check, and a throwing component blanks your slot entry (console: `slot entry crashed in '<slot>'`). Write your own controls and match the host instead: copy markup, CSS, and behavior from the primitive into the plugin (`src/*.tsx` and `*.module.css` in a DSH source checkout, or the installed package's `lib/index.js` and `lib/**/*.css`), or inspect the rendered host control in the connected page. Rename copied classes under your plugin's prefix, keep only `--dsw-alias-*` token references, and keep the behavior that users rely on, such as Modal focus and Escape handling, `role="switch"` with `aria-checked`, and Tooltip placement. Tokens then remain the only shared styling dependency.
- Contribute through slots: `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`. The callback's registrations are disposed when the owning declaration collapses and reinstalled when it returns. Read session data through the slot props' selector hooks, subscribing to the smallest slice. Do not write DOM outside your component or append to `document.body`.
- Add a Chat row by registering an event definition with `ctx.uiConversation.events.register()` and its view in the `conversation.chat.node` slot under the definition's `kind`, which is the renderer key; the Conversation layer owns paging, Turn and Step placement, and incremental assembly.
- When the Client needs a value derived from a session, declare `wire.view` on the Host projection. The value reaches the Client already computed; the Client does not fold session events itself.
# UI plugins in the Web page

Read `templates/decoration/` with the file-read tool and write its files into your bundle directory: its `package.json` adds a `dsh.client` section (`platform`, `immediately`, `inject`) and a `./client` export beside the bundle patch.

`index.js` exports `export function apply() {}`; the patch inserts one row named after the package. For a simple drawing, prefer a slot with allocated space, such as `conversation.composer.dock` when available. Keep the first version within that slot's flow; do not plan a motion path around host controls. Use `shell.overlay` only when the request needs an overlay and its placement is known.

## Client module

The browser artifact registers a lazy factory whose id equals the package name. React comes from the browser module table; no duplicate React installation, CDN script, or UMD search is needed. For compiled sources, use the deployment's Client build tooling to emit this format; declare non-baseline runtime imports in `dsh.client.external`.

`templates/decoration/client.js` registers a lazy factory into `conversation.composer.dock` through `ctx.slots.inject` and `ctx.slots.register`; follow the selected slot's props and options from `Slots.listSubTree` when you change the slot.

Keep factories free of side effects. Register styles, timers, listeners and other resources inside `apply` with `ctx.effect`/`ctx.on` and return their cleanup functions. Component-local styles can render as React elements so unmounting removes them. Verify disposal for resources you add. Inherit the host theme for containers and controls; artwork may use its own colors. A page or panel beyond a decoration follows the UI rules in `references/practices.md`. Route visible UI text through the Client locale service. Do not replace the app root or append a second application to `document.body`. Do not read another plugin's DOM, stylesheet, or component source to estimate placement; choose a slot that already allocates space.
# Verify in the available environment

Prefer the authenticated page already connected to Harness. Do not launch a separate browser from shell commands, change `HOME`, inspect personal browser profiles, search for authentication tokens, or alter keychains to obtain a screenshot. For a visual-only request without browser control, limit verification to JavaScript syntax, manifest validation, and the live Client slot, then report that visual verification remains unavailable. Before or after installation, do not search for rasterizers, invoke Quick Look, extract SVG into preview files, emulate React/DOM, or implement a custom renderer to compensate for missing browser control. A screenshot of a mock page is not verification of the running plugin.

For any test subprocess or temporary resource, use a unique owned directory, bound execution, and await cleanup. A failed optional preview must not turn into environment repair or block installation.
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Decoration() {
      return h('svg', {
        viewBox: '0 0 64 64', width: 48, height: 48,
        'aria-hidden': true,
        style: { display: 'block', pointerEvents: 'none' },
      }, h('circle', { cx: 32, cy: 32, r: 24, fill: '#247bbf' }));
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
        }, Decoration));
      },
    };
  },
});
- insert:
    - id: my-decoration

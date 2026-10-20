# Codex runtime boundary

`CodexRuntime` adapts stdio JSON-RPC. The application owns durable task state,
queueing, cancellation and approval policy. The runtime owns execution readiness:
`getStatus()` is informational and never renews authorization; an explicit `run()`
may prepare or renew its own credentials before starting a model turn.

## Authentication modes

`AGENT_RUNTIME=disabled` remains the default. There is no simulated response and
no automatic fallback to a separately billed API key.

- `AGENT_CODEX_AUTH=codex-login` keeps the original development adapter. It reads
  Codex account status with `refreshToken: false` and accepts ChatGPT login only.
  Desktop login does not establish third-party cloud application eligibility.
- `AGENT_CODEX_AUTH=chatgpt-plan` uses this application's separate Sign in with
  ChatGPT registration. It does not call Codex account/login methods or discover
  desktop auth files. `PlanCredentialProvider` supplies only this application's
  access token, revision, stable app identity and isolated `CODEX_HOME`.

The plan branch uses the documented `openai_chatgpt_plan` Responses provider,
fixed official API URL, `ACCESS_TOKEN`, `requires_openai_auth=false`, and
`supports_websockets=false`. Effective provider configuration is checked before
opening a thread. Account authentication and `model/list` are not entitlement
checks: only a completed real inference verifies that request's access.

## Independent authorization preparation

The administrator helper is built with the server:

```text
node apps/server/dist/auth/cli.js --help
node apps/server/dist/auth/cli.js login --open-source-ready --profile-dir <dedicated-directory>
```

The second command is for a later deliberate authorization operation. The flag
is an operator acknowledgement that the application's actual publication and
eligibility meet the official open-source flow; it does not publish anything or
verify eligibility. This implementation has not performed that real sign-in.
It prints a link for the administrator's browser; it does not launch a browser or
start inference. A remote VM needs a separately prepared safe callback arrangement
as described in the official self-hosted VM guide.

The helper binds a random port on `127.0.0.1` with `/auth/callback`. PKCE S256,
state and nonce are fresh per attempt; callbacks are consumed once and expire
after ten minutes. `jose` verifies signature, fixed issuer/JWKS, audience, expiry,
issued-at time, nonce, subject and authorized-party constraints. Granted plan
scopes are required. Endpoint overrides, API keys and client secrets are absent.
Authorization URLs omit optional identity hints so they contain no retained ID
token. Errors and HTTP response bodies are not copied into logs or task events.

`AGENT_CHATGPT_APP_NAME` applies only to new registration. The profile persists
its original app identity; later display-name changes do not change registration
ownership or the runtime's originator. `AGENT_APP_TITLE` is display metadata.

`AGENT_CHATGPT_PROFILE_DIR` selects a new dedicated directory. Its protected
profile records one selected account/registration, a stable host ID, scope and
expiry, and the token set. Unix permissions are 0700/0600; Windows uses a verified
protected DACL for the current user and SYSTEM. Symlinks and unsafe existing
permissions are rejected. Existing broadly accessible directories are not
silently adopted. Temporary files are synced and atomically renamed.

Refresh is serialized under an exclusive filesystem lock. Another process waits
up to 1.5 seconds and then reports busy; it does not race a slow refresh or remove
an unknown abandoned lock. Once a rotating refresh has been sent, task cancellation
does not discard its response: the bounded request finishes and commits the new
token set before cancellation stops execution. A changed token revision restarts
app-server and the next explicit task resumes its saved thread. A model turn is
never automatically replayed. Mid-turn expiry can fail the task; renewal occurs
at the next explicit task, not by replaying possibly completed actions.

Account selection, sign-out/revocation UI and automatic VM credential deployment
are not implemented. Each registration needs its own directory. The supported
manual sign-in flow replaces credentials only after the selected identity has
been verified.

## Tools and process boundary

Native executables launch without a shell. A small OS environment allowlist is
used; the plan branch replaces home discovery with its own profile location and
injects only its access token. Business service credentials are not inherited.
No model ID is embedded; model choice remains configurable.

Calls use `approvalPolicy: never` and a read-only sandbox with network disabled.
Desktop, browser, shell, plugin, hooks and inherited MCP tools remain disabled.
An unsupported approval request is refused and stops the task. The explicit
`AGENT_CODEX_KNOWLEDGE_TOOLS=experimental` flag additionally permits only this
application's typed, bounded, read-only knowledge tools; retrieved text remains
untrusted reference material. It grants no new permissions.

Read-only sandboxing is not an OS boundary against host reads. Production still
requires a dedicated account/container with only required runtime state and task
workspace, no business database, user home, host filesystem or Docker socket.
Enabling shell/browser/code tools requires separately validated isolation and an
approval bridge. Current restrictions are a development stage, not the final
product's intended capabilities.

## Verification and limits

Protocol fields were checked against installed Codex CLI 0.154.0; this is a tested
baseline, not a requirement to remain on that version. A no-credential real CLI
probe confirmed initialization and the official provider's effective config.
It did not request account data, models, threads or inference.

Offline tests cover signature and claim validation, callback replay, cancellation,
serialized refresh, real Windows ACL enforcement, a second process's filesystem
lock, token replacement and thread resume, Worker renewal of expired sessions,
stream ownership, tool boundaries and failure cleanup. Test credentials and model
processes are synthetic. No real SIWC authorization, cloud deployment or plan
inference has been validated by these tests.

Official references:

- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://learn.chatgpt.com/docs/app-server

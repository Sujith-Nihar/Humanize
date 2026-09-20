# Deploying the Humanize runner

The runner reviews private repositories inside your own network. Repository content and the
model that reads it stay on your infrastructure; the control plane never sees your source.

## What it needs

- A host that can reach your control plane over HTTPS, and Ollama on the same host or network.
- A local model whose context window is at least 16,000 tokens. The adapter requests that
  window explicitly, and a smaller model silently truncates the prompt.
- Docker, or Node.js 22 if you would rather run it directly.

## Enrollment

An administrator creates a single-use enrollment token in the dashboard. It expires in ten
minutes and can be consumed once. The runner exchanges it at startup for a revocable
credential that is stored only as a hash on the server, and shown to you once.

```sh
export HUMANIZE_CONTROL_PLANE_URL=https://humanize.example.com
export HUMANIZE_RUNNER_TOKEN=...          # the credential from enrollment
export OLLAMA_BASE_URL=http://host.docker.internal:11434
docker compose -f docker/runner/compose.yaml up -d
```

## What the deployment guarantees

- **Outbound only.** No port is published and nothing dials in. The runner contacts the
  control plane and your local model; Ollama is reached across the host boundary rather than
  being exposed publicly.
- **Unprivileged.** It runs as uid 10001 with every Linux capability dropped and
  `no-new-privileges` set. Nothing it does requires root.
- **Read-only root filesystem.** The only writable path is the workspace.
- **Repository content never touches disk.** The workspace is a tmpfs, so a clone lives in
  memory and disappears with the container, and each job deletes its workspace regardless.

A tmpfs mount is owned by root unless the mount says otherwise, which would leave the
unprivileged runner unable to create a workspace at all. The compose file therefore passes
`uid=10001,gid=10001`; keep that if you write your own deployment.

## Upgrading

Pull the new image and recreate the container. A runner holds a lease for at most 120 seconds,
so an in-flight review is either finished or returned to the queue and picked up again; no
review is lost by restarting.

```sh
docker compose -f docker/runner/compose.yaml pull
docker compose -f docker/runner/compose.yaml up -d
```

## Revoking

Revoke the runner in the dashboard. Its credential stops working immediately, any lease it
holds is cancelled, and it cannot enroll again without a new token.

## When something is wrong

The runner refuses to start unless `HUMANIZE_CONTROL_PLANE_URL` and `HUMANIZE_RUNNER_TOKEN`
are both set, and refuses a job configured to use a cloud model, because a runner exists so
that private content stays private.

| Symptom | Cause |
|---|---|
| Exits immediately naming the two variables | Configuration missing |
| `RUNNER_UNAUTHORIZED` | Credential revoked, or enrolled against a different control plane |
| `CLOUD_MODEL_IN_PRIVATE_JOB` | Organization policy selects a cloud provider for runner execution |
| `MODEL_UNAVAILABLE` | The configured model is not installed in Ollama |
| `CONTEXT_LIMIT` | The model's context window is smaller than the request |

Logs carry identifiers, timings, counts and error classes. They never carry repository
content, prompts, or credentials.

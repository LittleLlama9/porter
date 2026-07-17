# Porter

Makes your localhost apps act like normal sites. You go to the URL, it starts up. You leave, it shuts down after a bit so it's not sitting in the background eating RAM. Come back and it's up again in about a second.

## How it works

For each app it listens on the port you'd normally use. First time you hit it, it spawns the real server hidden on port+10000 and pipes traffic through. HTTP, websockets, SSE all work. After idleMinutes with nothing connected it kills the server. Open the URL and it comes back.

You also get name.localhost (so myapp.localhost instead of localhost:3000). Browsers point *.localhost at loopback on their own, so no hosts file or admin.

## How to run

```
copy porter.config.example.json porter.config.json
node porter.js
```

Or start it at logon with no admin:

```
powershell -File install-launch.ps1
```

Config is just a list of apps:

```json
{
  "name": "myapp",
  "port": 3000,
  "cmd": "node",
  "args": ["server.js"],
  "cwd": "C:\\path\\to\\myapp"
}
```

## Automatic app manifests

Set `manifestRoots` to folders that contain your projects. Porter checks each
root and its immediate child directories for `porter.app.json` at startup and
every `manifestScanSeconds`. A new manifest opens its port and
`http://<name>.localhost/` route without editing Porter's central config or
restarting it.

Example `porter.app.json` in an app's project root:

```json
{
  "name": "myapp",
  "port": 3000,
  "cmd": "node",
  "args": ["server.js"]
}
```

The manifest directory becomes the app's working directory. Optional fields are
`upstreamPort`, `env`, `idleMinutes`, and `enabled`. Names may contain lowercase
letters, numbers, and hyphens. Ports and upstream ports must be unique.

## Limitations

Windows only (the logon stuff is windows, the doorman is plain node). Your app
has to read `process.env.PORT`; Porter tells it which upstream port to use.
Manifest discovery scans only each configured root and its immediate children.
Changes to an already loaded manifest require a Porter restart. name.localhost
wants port 80 free, falls back to IPv6 if something's on it, or set
`"namePort": false` to skip it.

MIT

# Porter

Makes your localhost apps act like normal sites. You go to the URL, it starts up. You leave, it shuts down after a bit so it's not sitting in the background eating RAM. Come back and it's up again in about a second.

## Download

Grab the latest zip from the [releases page](https://github.com/LittleLlama9/porter/releases/latest), unzip it, and follow How to run below. Or clone the repo if you'd rather track it with git.

## How it works

For each app it listens on the port you'd normally use. First time you hit it, it spawns the real server hidden on port+10000 and pipes traffic through. HTTP, websockets, SSE all work. After idleMinutes with nothing connected it kills the server. Open the URL and it comes back.

You also get name.localhost (so myapp.localhost instead of localhost:3000). Browsers point *.localhost at loopback on their own, so no hosts file or admin.

## Keeping an app alive during background work

Porter reaps on idle connections, not on a closed tab. An open tab only counts
while it's actually holding a socket open. A lot of tabs don't: a page that just
polls every so often, and only while it's visible, has no socket most of the
time. So an app can get reaped with the tab still sitting there (backgrounded
during a game, say), and anything the app was doing server-side with no browser
attached, like a radio queue or a cron loop, dies with it.

If your app does work in the background, keep it alive by pinging its own door:

```
GET http://localhost:<PUBLIC_PORT>/_porter/keepalive
```

Porter answers that itself with a 204 and resets the idle countdown, so it
doesn't hit your app or spawn it if it's already down. Send it a bit more often
than idleMinutes for as long as the background work is running. Porter sets
`PUBLIC_PORT` (your public door) and `PORTER_APP` (your name) in the child
environment so you don't have to hardcode the port. Any request to the door
resets the timer, so you can also just poll a real endpoint; the keepalive path
is the tidy version that does no work.

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

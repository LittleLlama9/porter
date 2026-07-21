# Porter

Makes your localhost apps act like normal sites. You go to the URL, it starts up. You leave, it shuts down after a bit so it's not sitting in the background eating RAM. Come back and it's up again in about a second.

## Download

1. **Install Node.js** if you don't already have it: go to [nodejs.org](https://nodejs.org), click the big **LTS** button, and install it (just accept the defaults). Porter needs Node 18 or newer.
2. Grab the latest zip from the [releases page](https://github.com/LittleLlama9/porter/releases/latest) and unzip it anywhere.
3. Double-click **`install.cmd`**. Porter starts now and every time you log in. To remove it, double-click **`uninstall.cmd`**.

That's the whole setup. Prefer a terminal, or want to track it with git? See How to run below.

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

The easy path is double-clicking `install.cmd` (installs and starts). To remove
it later, double-click `uninstall.cmd`.

Prefer a terminal, or want to run it once in the foreground?

```
node porter.js
```

Porter writes an empty `porter.config.json` beside itself on first run, so it
starts clean. Add your apps to it, or drop a `porter.app.json` in each project
(see Automatic app manifests below). `install.cmd` just wraps
`install-launch.ps1`, which registers the hidden logon task with no admin.

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

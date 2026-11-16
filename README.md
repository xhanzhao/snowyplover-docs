# SnowyPlover docs

The documentation site for SnowyPlover, a Grasshopper plugin for architectural animation.
Plain HTML, CSS and JavaScript, no dependencies. Node 18 or newer runs the build scripts.
The built site in `dist/` also works when opened straight from disk: double-click `dist/index.html`.

## Run it locally

```
npm run dev        # builds into dist/ and serves http://localhost:4321, rebuilding on changes
```

## Where things are

| Path | What it is |
|---|---|
| `src/pages/` | The hand-written pages. Each starts with a comment holding its title, sidebar group and order. |
| `src/notes/<slug>.html` | Optional extra text for one component's reference page. |
| `src/assets/diagram.js` | Draws the wiring diagrams. The syntax is described at the top of the file. |
| `src/assets/style.css`, `site.js` | Look, sidebar, search, theme switch, draggable sliders. |
| `data/components.json` | Every component's name, description, inputs and outputs. Generated, do not edit. |
| `data/overrides.json` | Corrections the generator cannot read from the source: button labels, missing descriptions. |
| `tools/sync.mjs` | Regenerates `components.json` and the icons from the plugin source. |
| `tools/build.mjs` | Builds `dist/`. Reference pages are generated from `components.json`. |

## Wiring diagrams

Write a diagram inside any page:

```html
<pre class="diagram" data-caption="Optional caption">
t   = slider 0.3 live
nv  = GetCameraFromNamedviews
key = AnimateKeyframes [used]
cam = ApplyCamera

nv.camera -> key.cameras
t ~> key.t
key.camera -> cam.camera
</pre>
```

Port names are checked against `components.json`; a typo fails the build with a message that lists the real ports.
Link a component in text with `[[Animate Keyframes]]`.

## After changing the plugin

The plugin source is private, so the component data is copied in here:

```
node tools/sync.mjs <path to the SnowyPlover source folder>
```

Commit the updated `data/components.json` and `src/assets/icons/`.

## Deploy

Every push to `main` builds the site and publishes it to GitHub Pages
(Settings › Pages › Source: GitHub Actions).

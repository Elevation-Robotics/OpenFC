# Contributing to OpenFC

Contributions of any size are welcome: bug reports, docs fixes, firmware, hardware revisions, new features on the site. The maintainers review and merge pull requests but are not actively developing new features, so a pull request will move faster than a feature request.

## Reporting a problem

Open an issue with:

- the board revision (V1.1 or V1.3) and firmware version (shown by the flasher, or `fw_version` in `hello` / `bu_hello`)
- browser and OS, if the problem is on the website
- what you did, what you expected, and what happened, with any serial log

**Safety problems** (a robot enabled when it should not be, a watchdog that does not trip, a period that does not end) should be marked as such in the title. They take priority.

## Pull requests

1. Fork the repository and branch from `master`.
2. Keep each pull request to one change. Separate refactors from behaviour changes.
3. Run the checks below. CI runs the typecheck and tests on every pull request, and `master` only accepts pull requests that pass them.
4. Describe what changed, why, and how you tested it. For firmware, say what was tested on real hardware and what was not.
5. A maintainer reviews and merges. `master` is protected, so every change goes through a pull request.

### Website

```
npm install
npm run typecheck
npm test
npm run build
```

Add or update tests in `tests/` when you change `lib/`. If you change a command, event or behaviour, update the docs page under `app/docs/` in the same pull request.

### Firmware

- V1.1 lives in `firmware/`, V1.3 in `firmware-bringup-v1_3/` (read its README first). They are separate PlatformIO projects on purpose.
- The firmware fails safe. The board boots Disabled, and outside a timed period it disables when the host goes quiet. Do not weaken this without discussing it in an issue first.
- In the V1.3 tree, the headers that exist in both the `esp32/` and `rp2350/` projects must stay byte-identical.
- State in the pull request which board you tested on, and whether controllers or robots were connected.

### Publishing a firmware release

Releases are published by adding the binary to `public/firmware/` and an entry to `public/firmware/manifest.json`:

- **V1.1:** `official_releases`. Only set `certified_for_competition: true` once the release has been verified on hardware, because the site and the API tell users that build is safe for competition.
- **V1.3:** `v13_releases`. Use `firmware-bringup-v1_3/tools/publish_firmware.py`, which builds the `release` environment and prints the entry.

`npm run build` checks every published binary against its manifest hash.

### Hardware

Design files live in `public/hardware/`, named by board revision (`openfc-v1-*`, `openfc-v1_3-*`). A new revision should include gerbers, BOM and placement files, and ideally a schematic PDF and the source project. Document it on `app/docs/hardware/page.tsx`.

## Licensing of contributions

By submitting a contribution, you agree that it is licensed under the project's licences:

- software, firmware and documentation: [Apache-2.0](LICENSE) (see its section 5)
- hardware designs: [CERN-OHL-P-2.0](LICENSE-hardware)

You keep the copyright in your work. Only submit code you wrote, or code whose licence is compatible and which you identify in the pull request. Code under the GPL or another copyleft licence makes the whole firmware image copyleft (see the SWD code in `NOTICE`), so raise it in an issue before contributing any.

## Trademarks

Do not use VEX, VEX Robotics or V5 names or logos in a way that suggests endorsement. OpenFC is not affiliated with Innovation First, Inc. (IFI), VEX Robotics or the Robotics Education & Competition Foundation (RECF). These names are used only to describe compatibility.

## Conduct

Be respectful and assume good faith. This project is used by students. Maintainers may close or lock discussions that are not.

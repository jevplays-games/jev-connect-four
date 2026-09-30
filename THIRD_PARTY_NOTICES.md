# Third-party notices

This application ships with no runtime npm dependencies. The following third-party
assets are vendored in the repository.

## Inter

SIL Open Font License 1.1

Copyright (c) 2016 The Inter Project Authors

Vendored at `public/brand/inter-var.woff2`. Full license text at `public/brand/OFL.txt`.

## @discord/embedded-app-sdk

MIT License

Copyright (c) Discord Inc.

Version 2.5.0, vendored as a single bundle at `public/vendor/discord-embedded-app-sdk.js`. It is loaded only when the game runs as a Discord Activity (see `docs/ACTIVITY.md`) and is served from this origin because the Content-Security-Policy allows scripts from `'self'` only.

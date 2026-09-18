# ISC Fulcrum extension - update channel

Distribution files for an internal browser extension used by ISC Industrial Manufacturing
staff on their own Fulcrum tenant. This repository holds **only** the update manifest and
the signed extension package - no source code.

| File | Purpose |
| ---- | ------- |
| `updates.xml` | Omaha-style update manifest that Chrome and Edge poll |
| `fulcrum-active-materials.crx` | The signed extension |

The extension adds three optional controls to Fulcrum's BOM panel (filter inactive
materials, collapse routing templates, truncate long item descriptions). It contains no
credentials and reads no data outside the user's own authenticated Fulcrum session.

Published publicly because Chrome and Edge fetch update manifests anonymously - their
updater cannot authenticate. The package is signed, and browsers verify that signature
against the extension ID before installing, so this channel cannot be used to deliver
anything ISC did not sign.

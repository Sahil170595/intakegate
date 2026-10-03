# Third-Party Notices

The repository does not vendor dependency source, binary distributions, or third-party fixtures. The root MIT license covers first-party code, documentation and synthetic fixtures only. Installations must retain the upstream licenses and notices included with each package; redistribution of bundled dependencies must preserve those terms separately.

Direct dependencies in the release lockfile:

| Package | Locked version | License |
| --- | --- | --- |
| `@anthropic-ai/sdk` | 0.97.1 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `tsx` | 4.21.0 | MIT |
| `ulid` | 2.4.0 | MIT |
| `@types/node` | 22.19.17 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |

Transitive lockfile packages use MIT except `fast-uri` 3.1.0 (BSD-3-Clause) and `fast-sha256` 1.3.0 (Unlicense). TypeScript's Apache-2.0 terms are not replaced by this repository's MIT license. Platform-specific optional packages are recorded in the lockfile but are not vendored here. Runtime Node.js licensing is separate from the repository license.

Consult `package-lock.json` for exact dependency versions, integrity hashes, public registry locations, and license declarations, and each installed package's LICENSE/NOTICE files for authoritative terms. No upstream license file or notice was removed from any installed runtime used to verify this release.

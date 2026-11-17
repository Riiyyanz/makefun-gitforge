# makefun-gitforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Riiyyanz/makefun-gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Riiyyanz/makefun-gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process and no dependencies: git smart HTTP (upload-pack protocol v2 for clone and fetch, receive-pack v0 with fast-forward enforcement), the REST v3 subset GitHub clients use, a GraphQL v4 endpoint with the introspection and mutations `gh` needs, and a Model Context Protocol endpoint over Streamable HTTP — all serving one in-memory object store.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=qat8rp1a&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

FROM --platform=$BUILDPLATFORM node:22 AS node-build

ARG NPM_REGISTRY=

WORKDIR /app
ADD app/package.json app/pnpm* app/.npmrc .

RUN <<EORUN
#!/bin/bash -e
corepack enable
corepack install --global $(node -e 'console.log(require("./package.json").packageManager)')
npm config set registry ${NPM_REGISTRY}
pnpm install --silent
EORUN

ADD app/ .
RUN <<EORUN
#!/bin/bash -e
pnpm run build
node scripts/trimChangelogs.js
mkdir /artifacts
mv appearance stage guide /artifacts/
if [ -d changelogs ]; then mv changelogs /artifacts/; fi
EORUN

FROM golang:1.26-alpine AS go-build

RUN <<EORUN
#!/bin/sh -e
apk add --no-cache gcc musl-dev
go env -w GO111MODULE=on
go env -w CGO_ENABLED=1
EORUN

WORKDIR /kernel
ADD kernel/go.* .
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg \
    go mod download

ADD kernel/ .
# Ver 从 app/package.json 注入，与 UI 版本保持一致（可用 --build-arg SIYUAN_VERSION 覆盖）
ARG SIYUAN_VERSION=
COPY app/package.json /tmp/package.json
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg <<EORUN
#!/bin/sh -e
VERSION="${SIYUAN_VERSION}"
if [ -z "$VERSION" ]; then
  VERSION=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /tmp/package.json | head -n 1)
fi
if [ -z "$VERSION" ]; then
  echo "Error: failed to read version from app/package.json"
  exit 1
fi
echo "Kernel version from package.json: ${VERSION}"
go build -tags fts5 -ldflags "-s -w -X github.com/siyuan-note/siyuan/kernel/util.Ver=${VERSION}"
EORUN

FROM alpine:latest
LABEL maintainer="Liang Ding<845765@qq.com>"

RUN apk add --no-cache ca-certificates tzdata su-exec

ENV TZ=Asia/Shanghai
ENV HOME=/home/siyuan
ENV RUN_IN_CONTAINER=true
EXPOSE 6806

WORKDIR /opt/siyuan/
COPY --from=go-build --chmod=755 /kernel/kernel /kernel/entrypoint.sh .
COPY --from=node-build /artifacts .

ENTRYPOINT ["/opt/siyuan/entrypoint.sh"]
# 默认启动伺服。若通过 `docker run` / `command:` 传额外参数，需自行带上 `serve` 子命令，
# 否则用户参数会整体覆盖 CMD。
CMD ["/opt/siyuan/kernel", "serve"]

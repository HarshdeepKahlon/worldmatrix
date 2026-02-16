FROM node:22-slim AS build

WORKDIR /usr/src/app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY dashboard ./dashboard

RUN npm ci

# Optional CLI dependency used by thumbnail generation.
# Install in the build stage (workspace present) so we don't clobber node_modules
# in the runtime stage (which caused missing deps like express).
RUN npm install --no-save @shopify/screenshot-glb@4.1.0

RUN npm run build -w @worldmatrix/wmx-core \
  && npm run build -w @worldmatrix/wmx-cli \
  && npm run build -w @worldmatrix/wmx-asset-server

FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8080
ENV WMX_DATA_DIR=/data
ENV WMX_SOURCE_DIR=/data/source
ENV WMX_OUTPUT_DIR=/data/wmx
ENV WMX_S3_PREFIX=3d-assets/wmx
ENV WMX_S3_REGION=us-east-1

WORKDIR /usr/src/app

# ---- KTX-Software install (mirrors BuildCoresBase/Dockerfile.prod) ----
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      wget \
      bzip2 \
      gconf-service \
      libasound2 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libc6 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libexpat1 \
      libfontconfig1 \
      libgcc1 \
      libgconf-2-4 \
      libgdk-pixbuf2.0-0 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libstdc++6 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxi6 \
      libxrandr2 \
      libxrender1 \
      libxss1 \
      libxtst6 \
      fonts-liberation \
      lsb-release \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

ARG KTX_VERSION=4.3.2
RUN set -eux; \
    if [ "$(uname -m)" = "aarch64" ]; then KTX_ARCH="arm64"; else KTX_ARCH="x86_64"; fi; \
    wget "https://static.buildcores.com/cicd/KTX-Software-${KTX_VERSION}-Linux-${KTX_ARCH}.tar.bz2"; \
    tar -xjf "KTX-Software-${KTX_VERSION}-Linux-${KTX_ARCH}.tar.bz2"; \
    cp "KTX-Software-${KTX_VERSION}-Linux-${KTX_ARCH}/bin/toktx" /usr/local/bin/; \
    cp "KTX-Software-${KTX_VERSION}-Linux-${KTX_ARCH}/bin/ktxsc" /usr/local/bin/; \
    cp "KTX-Software-${KTX_VERSION}-Linux-${KTX_ARCH}/bin/ktx" /usr/local/bin/; \
    cp "KTX-Software-${KTX_VERSION}-Linux-${KTX_ARCH}/lib/libktx.so"* /usr/local/lib/; \
    chmod +x /usr/local/bin/toktx /usr/local/bin/ktxsc /usr/local/bin/ktx; \
    ldconfig; \
    ktx --version; \
    rm -rf "KTX-Software-${KTX_VERSION}-Linux-${KTX_ARCH}"*;

# Copy only what we need at runtime.
COPY --from=build /usr/src/app/packages/wmx-cli/dist /usr/src/app/packages/wmx-cli/dist
COPY --from=build /usr/src/app/packages/wmx-core/dist /usr/src/app/packages/wmx-core/dist
COPY --from=build /usr/src/app/packages/wmx-asset-server/dist /usr/src/app/packages/wmx-asset-server/dist
COPY --from=build /usr/src/app/node_modules /usr/src/app/node_modules
COPY --from=build /usr/src/app/packages/wmx-cli/package.json /usr/src/app/packages/wmx-cli/package.json
COPY --from=build /usr/src/app/packages/wmx-core/package.json /usr/src/app/packages/wmx-core/package.json
COPY --from=build /usr/src/app/packages/wmx-asset-server/package.json /usr/src/app/packages/wmx-asset-server/package.json

EXPOSE 8080

CMD ["node", "packages/wmx-asset-server/dist/server.js"]


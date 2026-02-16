FROM node:22-slim AS build

WORKDIR /usr/src/app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY dashboard ./dashboard

RUN npm ci
# Dashboard depends on local workspace packages (e.g. @worldmatrix/wmx-viewer).
# Build the dependency chain first so Vite can resolve package exports from `dist/`.
RUN npm run build -w @worldmatrix/wmx-core \
  && npm run build -w @worldmatrix/wmx-three \
  && npm run build -w @worldmatrix/wmx-three-streaming \
  && npm run build -w @worldmatrix/wmx-runtime \
  && npm run build -w @worldmatrix/wmx-viewer \
  && npm run build -w @worldmatrix/dashboard

FROM nginx:alpine AS runtime
COPY dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /usr/src/app/dashboard/dist /usr/share/nginx/html
EXPOSE 80


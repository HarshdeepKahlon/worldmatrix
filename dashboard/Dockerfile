FROM node:22-slim AS build

WORKDIR /usr/src/app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY dashboard ./dashboard

RUN npm ci
RUN npm run build -w @worldmatrix/wmx-core && npm run build -w @worldmatrix/dashboard

FROM nginx:alpine AS runtime
COPY dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /usr/src/app/dashboard/dist /usr/share/nginx/html
EXPOSE 80


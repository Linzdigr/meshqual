FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
ARG VITE_API_BASE=
ARG VITE_TILE_URL=
ENV VITE_API_BASE=$VITE_API_BASE VITE_TILE_URL=$VITE_TILE_URL
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /src/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 8081

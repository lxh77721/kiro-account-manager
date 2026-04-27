FROM node:22-bookworm AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  chromium \
  dbus-x11 \
  fluxbox \
  fonts-noto-color-emoji \
  fonts-wqy-zenhei \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdrm2 \
  libgbm1 \
  libglu1-mesa \
  libgtk-3-0 \
  libnotify4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  libxshmfence1 \
  novnc \
  websockify \
  x11vnc \
  xauth \
  xdg-utils \
  xvfb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/out ./out
COPY --from=builder /app/resources ./resources
COPY docker/start-remote-ui.sh /usr/local/bin/start-remote-ui.sh

RUN chmod +x /usr/local/bin/start-remote-ui.sh

ENV DISPLAY=:99
ENV HOME=/root
ENV KIRO_CONTAINER_DESKTOP=true
ENV KIRO_DISABLE_TRAY=true
ENV KIRO_DISABLE_AUTO_UPDATE=true
ENV KIRO_DISABLE_GLOBAL_SHORTCUTS=true
ENV ELECTRON_DISABLE_SECURITY_WARNINGS=true

EXPOSE 6080 5900

VOLUME ["/root"]

CMD ["/usr/local/bin/start-remote-ui.sh"]


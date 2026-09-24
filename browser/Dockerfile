FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie
RUN apt-get update && apt-get install -y --no-install-recommends falkon fonts-noto-core fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*
COPY root/ /
RUN chmod +x /defaults/autostart /defaults/autostart_wayland /custom-cont-init.d/50-falkon
ENV TITLE="S-Power Browser"
ENV QT_QPA_PLATFORM=xcb
ENV QTWEBENGINE_CHROMIUM_FLAGS="--disable-dev-shm-usage"
ENV QTWEBENGINE_DISABLE_SANDBOX=1
ENV RESTART_APP=true
ENV SUBFOLDER=/stream/
ENV BROWSER_START_URL="https://www.google.com"
ENV TZ=Asia/Riyadh
ENV SELKIES_UI_TITLE="S-Power Browser"
ENV SELKIES_UI_SHOW_LOGO=false
ENV SELKIES_UI_SIDEBAR_SHOW_STATS=false
ENV SELKIES_UI_SIDEBAR_SHOW_APPS=false
ENV SELKIES_UI_SIDEBAR_SHOW_FILES=false
ENV SELKIES_UI_SIDEBAR_SHOW_SHARING=false
ENV SELKIES_ENABLE_SHARING="false|locked"
ENV SELKIES_AUDIO_ENABLED=true
ENV DISABLE_SUDO=true
ENV DISABLE_TERMINALS=true
EXPOSE 3000

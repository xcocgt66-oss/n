FROM lscr.io/linuxserver/chromium:latest
ENV SUBFOLDER=/stream/
ENV CHROME_CLI="--disable-dev-shm-usage https://www.google.com"
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
COPY policy.json /etc/chromium/policies/managed/spower.json
EXPOSE 3000

FROM python:3.14-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/home/retrox/.local/bin:$PATH

# UID 1000 keeps a host-bind-mounted /data writable without manual chowns
# on Linux hosts. BusyBox adduser/addgroup — Alpine has no useradd.
RUN addgroup -S -g 1000 retrox \
 && adduser  -S -u 1000 -G retrox -h /home/retrox -s /sbin/nologin retrox \
 && mkdir -p /data /app && chown retrox:retrox /data /app

# Install as retrox so ~/.local lands with correct ownership in a single
# layer — a post-hoc `chown -R` would otherwise duplicate ~30MB.
USER retrox
WORKDIR /app
COPY --chown=retrox:retrox backend/requirements.txt /tmp/req.txt
RUN PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    pip install --user --no-warn-script-location -r /tmp/req.txt \
 && find /home/retrox/.local -depth \
      \( -name '__pycache__' -o -name '*.pyc' -o -name '*.pyo' \
         -o -name 'tests' -o -name 'test' \) \
      -exec rm -rf {} + \
 && rm /tmp/req.txt

COPY --chown=retrox:retrox backend  /app/backend
COPY --chown=retrox:retrox frontend /app/frontend
COPY --chown=retrox:retrox docker   /app/docker
RUN chmod +x /app/docker/entrypoint.sh

EXPOSE 8080

# Uses the bundled Python interpreter so we don't ship curl. start-period
# gives the lifespan (DB init, library scan, demo seeding) time to complete
# on a cold start before the first probe is allowed to fail.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('RETROX_PORT','8080')+'/health',timeout=3).read()" || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]

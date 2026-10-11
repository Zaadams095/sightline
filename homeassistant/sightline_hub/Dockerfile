# The add-on is the published multi-arch Hub image (built from bridge/ by
# .github/workflows/bridge-image.yml). Home Assistant builds this tiny wrapper locally.
ARG BUILD_FROM
FROM ghcr.io/zaadams095/sightline-hub:latest
# Add-on data (/data, including options.json) is owned by root.
USER root
ENV DATA_DIR=/data

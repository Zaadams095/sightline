FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /sightline-hub .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 bridge && mkdir /data && chown bridge /data
COPY --from=build /sightline-hub /usr/local/bin/sightline-hub
# The image was called sightline-bridge before it became the Hub; keep the old command name.
RUN ln -s sightline-hub /usr/local/bin/sightline-bridge
USER bridge
VOLUME /data
EXPOSE 8086
ENTRYPOINT ["sightline-hub"]
